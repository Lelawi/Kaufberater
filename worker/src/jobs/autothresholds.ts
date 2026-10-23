// Vorläufige Kaufschwellen direkt nach der ersten Preissuche – ohne KI, aus den gefundenen Daten.
// Grundlage: aktueller Bestpreis, bisher beobachtete Preise und frühere Deals (mydealz & Co. liefern auch
// abgelaufene Deals = Preise, die schon einmal möglich waren). Die tägliche Tiefenanalyse ersetzt sie später.
import { db } from '../db.ts';
import { createAlert } from './alerts.ts';
import { fmtEur } from '../util/money.ts';

function roundNice(v: number): number {
  if (v >= 1000) return Math.round(v / 10) * 10 - 1;     // 2.499 statt 2.503
  if (v >= 100) return Math.round(v) - (Math.round(v) % 5 === 0 ? 1 : 0);
  return Math.round(v * 2) / 2;
}
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q; const lo = Math.floor(i); const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export function computeThresholds(best: number, historyMin: number | null, dealPrices: number[]) {
  const deals = dealPrices.filter((p) => p > best * 0.5 && p < best * 1.3); // Ausreißer (Zubehör, Bundles) weg
  let good: number; let top: number; let instant: number; let basis: string;
  if (deals.length >= 3) {
    good = Math.min(quantile(deals, 0.5), best * 0.97);
    top = Math.min(quantile(deals, 0.2), good * 0.96);
    instant = Math.min(Math.min(...deals) * 0.99, top * 0.96);
    basis = `${deals.length} frühere Deals und dem aktuellen Bestpreis`;
  } else if (deals.length) {
    const low = Math.min(...deals, historyMin ?? Infinity);
    good = Math.min(best * 0.95, (best + low) / 2);
    top = Math.min(low, good * 0.95);
    instant = top * 0.95;
    basis = `${deals.length} früheren Deal${deals.length > 1 ? 's' : ''} und dem aktuellen Bestpreis`;
  } else {
    const ref = Math.min(best, historyMin ?? best);
    good = ref * 0.95; top = ref * 0.88; instant = ref * 0.82;
    basis = 'dem aktuellen Bestpreis (noch keine Deal-Historie)';
  }
  // Plausibilität: Ausreißer (Fehlzuordnung, Zubehör) dürfen die Schwellen nicht ins Absurde ziehen –
  // „gut“ knapp unter dem aktuellen Bestpreis, „top“/„sofort“ nicht unter 60 %/55 % davon
  good = Math.min(good, best * 0.98);
  top = Math.max(Math.min(top, good * 0.97), best * 0.6);
  instant = Math.max(Math.min(instant, top * 0.97), best * 0.55);
  return { good: roundNice(good), top: roundNice(top), instant: roundNice(instant), basis };
}

export async function runAutoThresholds(opts: { productId?: string } = {}) {
  const sql = await db();
  const products = await sql`
    select id, user_id, name, best_price, lowest_seen, quantity from kb_products
    where status = 'watching' and not thresholds_manual and best_price is not null
      and (threshold_good is null or threshold_source = 'auto')
      and (${opts.productId ?? null}::uuid is null or id = ${opts.productId ?? null}::uuid)`;
  let set = 0;
  for (const p of products) {
    // Nur Deals, die in Deutschland erreichbar waren (Auslands-Deals sind mit einer Notiz markiert)
    // Mengen-Produkte: alles pro Stück (Packungspreis / Packungsgröße); sonst nur Einzelstück-Deals
    const multi = Number(p.quantity ?? 1) > 1;
    const deals = await sql`select price / case when ${multi} then pack_size else 1 end as price from kb_deals
                            where product_id = ${p.id} and price is not null and match_score >= 0.85 and (${multi} or pack_size = 1)
                            and notes is null and (posted_at is null or posted_at > now() - interval '18 months')`;
    // Preisverlauf der Preisvergleiche (ca. 6 Monate): 10-%-Tiefpunkt, damit ein einzelner Ausreißer-Tag nicht zählt
    const [h] = await sql`select percentile_cont(0.1) within group (order by d.m) as low, count(*)::int as n from (
                            select (observed_at at time zone 'Europe/Berlin')::date as day, min(total / case when ${multi} then pack_size else 1 end) as m from kb_price_history
                            where product_id = ${p.id} and series like 'hist:%' and observed_at > now() - interval '200 days' group by 1) d`;
    const histLow = h?.n >= 20 && h.low ? Number(h.low) : null;
    const seen = [p.lowest_seen ? Number(p.lowest_seen) : null, histLow].filter((x): x is number => x != null);
    const t = computeThresholds(Number(p.best_price), seen.length ? Math.min(...seen) : null, deals.map((d) => Number(d.price)));
    const upd = await sql`update kb_products set threshold_good = ${t.good}, threshold_top = ${t.top}, threshold_instant = ${t.instant}, threshold_source = 'auto'
              where id = ${p.id} and not thresholds_manual and (threshold_good is null or threshold_source = 'auto')
                and (threshold_good, threshold_top, threshold_instant) is distinct from (${t.good}::numeric, ${t.top}::numeric, ${t.instant}::numeric)
              returning id`;
    if (!upd.length) continue;
    await createAlert({
      userId: p.user_id, productId: p.id, kind: 'analysis', level: 'info',
      title: `${p.name}: Preisüberwachung läuft`,
      body: `Günstigster Preis gerade ${fmtEur(Number(p.best_price))}${multi ? ' pro Stück' : ''}. Vorläufige Schwellen${multi ? ' (pro Stück)' : ''} aus ${t.basis}: gut ${fmtEur(t.good)}, top ${fmtEur(t.top)}, sofort ${fmtEur(t.instant)}. Die Tiefenanalyse verfeinert sie morgen früh.`,
      dedupKey: `auto:${p.id}`,
    });
    set++;
  }
  return { set };
}
