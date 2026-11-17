// Vorläufige Kaufschwellen direkt nach der ersten Preissuche – ohne KI, aus den gefundenen Daten.
// Grundlage: aktueller Bestpreis, bisher beobachtete Preise und frühere Deals (mydealz & Co. liefern auch
// abgelaufene Deals = Preise, die schon einmal möglich waren). Die tägliche Tiefenanalyse ersetzt sie später.
import { db } from '../db.ts';
import { createAlert } from './alerts.ts';
import { fmtEur } from '../util/money.ts';
import { PRICE_ERROR } from '../util/plausible.ts';
import { conditionFromTitle } from '../adapters/common.ts';
import { offerMaxAge } from './evaluate.ts';
import { hotWindow, berlinDate } from '../util/events.ts';

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

/** Steigende Tendenz im November/in der heißen Phase ignorieren: Händler heben vor Black Friday an, „gut“ = aktueller
 *  Preis − 1 € würde dann beim aufgeblähten Preis melden */
export function usableTrend(trend: string | null, now = new Date()): string | null {
  if (trend !== 'rising') return trend;
  return berlinDate(now)[1] === 11 || hotWindow(now) ? null : trend;
}

/** Bestehende vorläufige Schwellen nur senken (je Stufe das Minimum); höher nur bei der täglichen Neuberechnung */
export function lowerOnly(old: { good: number | null; top: number | null; instant: number | null }, t: { good: number; top: number; instant: number }) {
  if (old.good == null || old.top == null || old.instant == null) return t;
  return { good: Math.min(old.good, t.good), top: Math.min(old.top, t.top), instant: Math.min(old.instant, t.instant) };
}

export function computeThresholds(best: number, historyMin: number | null, dealPrices: number[], trend: string | null = null, market: number | null = null) {
  // Preise steigen seit Monaten (z. B. wiederholte Preiserhöhungen): Warten lohnt meist nicht –
  // „gut“ ist dann schon der aktuelle Preis, die anderen Schwellen nur knapp darunter
  if (trend === 'rising') {
    return { good: roundNice(best), top: roundNice(best * 0.96), instant: roundNice(best * 0.92), basis: 'dem aktuellen Preis (die Preise steigen seit Monaten – Warten lohnt eher nicht)', already: false };
  }
  const deals = dealPrices.filter((p) => p > best * 0.5 && p < best * 1.3); // Ausreißer (Zubehör, Bundles) weg
  // Schon jetzt ein guter Preis (17.11.: 34,95 € bei üblich ~46 € und bestem Deal 33,69 € – trotzdem nur Schwellen darunter):
  // deutlich unter dem Marktschnitt der Händler oder fast so günstig wie der beste frühere Deal → „gut“ = aktueller Preis
  const lowDeal = deals.length ? Math.min(...deals) : null;
  // Unter dem Marktschnitt allein reicht nicht (Review 17.11.: Median 118 bei Bestpreis 100, obwohl es mehrfach 90 gab) –
  // zusätzlich muss der Preis nahe am bisherigen Tief oder höchstens beim üblichen Deal-Preis liegen
  const dealMedian = deals.length ? quantile(deals, 0.5) : null;
  const belowMarket = market != null && best <= market * 0.87 &&
    ((historyMin != null && best <= historyMin * 1.03) || (dealMedian != null && best <= dealMedian));
  const nearDealLow = lowDeal != null && best <= lowDeal * 1.05;
  if (belowMarket || nearDealLow) {
    const g = Math.ceil(best);
    const tp = Math.min(roundNice(Math.min(best * 0.95, lowDeal ?? Infinity)), g - 0.5);
    const inst = Math.min(roundNice(best * 0.9), tp - 0.5);
    const basis = belowMarket
      ? `dem aktuellen Preis – er liegt schon ${Math.round((1 - best / market!) * 100)} % unter dem üblichen Händlerpreis`
      : 'dem aktuellen Preis – fast so günstig wie der beste frühere Deal';
    return { good: g, top: tp, instant: inst, basis, already: true };
  }
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
  return { good: roundNice(good), top: roundNice(top), instant: roundNice(instant), basis, already: false };
}

export async function runAutoThresholds(opts: { productId?: string } = {}) {
  const sql = await db();
  const products = await sql`
    select id, user_id, name, best_price, lowest_seen, quantity, price_trend, threshold_good, threshold_top, threshold_instant, threshold_source from kb_products
    where status = 'watching' and not thresholds_manual and best_price is not null
      and (threshold_good is null or threshold_source = 'auto')
      and (${opts.productId ?? null}::uuid is null or id = ${opts.productId ?? null}::uuid)`;
  let set = 0;
  // Einmal setzen, danach nur senken – höchstens einmal am Tag komplett neu (Review 17.11.: bei jedem Lauf aus dem
  // aktuellen Bestpreis neu berechnet; war der günstigste Shop ausverkauft, stiegen die Schwellen mit)
  const [y, m, d] = berlinDate();
  const today = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // Lauf für ein einzelnes Produkt (Änderung in der App, z. B. Menge) darf immer neu rechnen, zählt aber nicht als Tageslauf
  const [done] = opts.productId ? [] : await sql`select 1 from kb_runs where stats->'autothresholds'->>'full' = ${today} limit 1`;
  const full = !!opts.productId || !done;
  for (const p of products) {
    // Nur Deals, die in Deutschland erreichbar waren (Auslands-Deals sind mit einer Notiz markiert)
    // Mengen-Produkte: alles pro Stück (Packungspreis / Packungsgröße); sonst nur Einzelstück-Deals
    const multi = Number(p.quantity ?? 1) > 1;
    const dealRows = await sql`select title, price / case when ${multi} then pack_size else 1 end as price from kb_deals
                            where product_id = ${p.id} and price is not null and match_score >= 0.85 and (${multi} or pack_size = 1)
                            and notes is null and (posted_at is null or posted_at > now() - interval '18 months')
                            -- Preisfehler kommen nicht wieder (11.11.) – sonst zöge einer die Stufe „sofort“ unerreichbar nach unten
                            and title !~* ${PRICE_ERROR.source.replace(/\\b/g, '\\y')}`;   // Postgres: Wortgrenze heißt \y
    // Refurbished/B-Ware/Gebraucht ist kein Neupreis (auch ältere Deals ohne Notiz)
    const deals = dealRows.filter((d) => conditionFromTitle(d.title as string) === 'new');
    // Preisverlauf der Preisvergleiche (ca. 6 Monate): 10-%-Tiefpunkt, damit ein einzelner Ausreißer-Tag nicht zählt
    const [h] = await sql`select percentile_cont(0.1) within group (order by d.m) as low, count(*)::int as n from (
                            select (observed_at at time zone 'Europe/Berlin')::date as day, min(total / case when ${multi} then pack_size else 1 end) as m from kb_price_history
                            where product_id = ${p.id} and series like 'hist:%' and observed_at > now() - interval '200 days' group by 1) d`;
    const histLow = h?.n >= 20 && h.low ? Number(h.low) : null;
    const seen = [p.lowest_seen ? Number(p.lowest_seen) : null, histLow].filter((x): x is number => x != null);
    // Üblicher Händlerpreis: Median der aktuellen Neuware-Angebote (pro Stück), erst ab 5 Angeboten aussagekräftig
    const [mk] = await sql`select percentile_cont(0.5) within group (order by o.total / case when ${multi} then o.pack_size else 1 end) as med, count(*)::int as n
                           from kb_offers o where o.product_id = ${p.id} and not o.gone and o.condition = 'new' and coalesce(o.in_stock, true)
                             and o.last_seen_at > now() - ${offerMaxAge()}::interval and (${multi} or o.pack_size = 1)
                             and o.listing_id not in (select id from kb_listings where product_id = ${p.id} and (rejected or not active))
                             and o.disputed_total is null
                             -- nur seriöse Händler (wie trusted in evaluate.ts) – Marktplatz-Händler ziehen den Median nach oben
                             and not (o.shop_reviews is not null and o.shop_reviews < 20)
                             and not (o.shop_rating is not null and o.shop_rating < 3.5 and coalesce(o.shop_reviews, 0) < 500)`;
    const market = mk?.n >= 5 && mk.med ? Number(mk.med) : null;
    const computed = computeThresholds(Number(p.best_price), seen.length ? Math.min(...seen) : null, deals.map((d) => Number(d.price)), usableTrend(p.price_trend), market);
    const hasAuto = p.threshold_source === 'auto' && p.threshold_good != null;
    const t = { ...computed, ...(hasAuto && !full ? lowerOnly({ good: num(p.threshold_good), top: num(p.threshold_top), instant: num(p.threshold_instant) }, computed) : {}) };
    const upd = await sql`update kb_products set threshold_good = ${t.good}, threshold_top = ${t.top}, threshold_instant = ${t.instant}, threshold_source = 'auto'
              where id = ${p.id} and not thresholds_manual and (threshold_good is null or threshold_source = 'auto')
                and (threshold_good, threshold_top, threshold_instant) is distinct from (${t.good}::numeric, ${t.top}::numeric, ${t.instant}::numeric)
              returning id`;
    if (!upd.length) continue;
    await createAlert({
      // immer nur Info: ist der Preis wirklich gut, meldet die anschließende Bewertung („Guter Preis“) – sonst zwei Pushes
      userId: p.user_id, productId: p.id, kind: 'analysis', level: 'info',
      title: t.already ? `${p.name}: schon jetzt ein guter Preis` : `${p.name}: Preisüberwachung läuft`,
      body: `Günstigster Preis gerade ${fmtEur(Number(p.best_price))}${multi ? ' pro Stück' : ''}. Vorläufige Schwellen${multi ? ' (pro Stück)' : ''} aus ${t.basis}: gut ${fmtEur(t.good)}, top ${fmtEur(t.top)}, sofort ${fmtEur(t.instant)}. Die Tiefenanalyse verfeinert sie morgen früh.`,
      dedupKey: `auto:${p.id}`,
    });
    set++;
  }
  return full && !opts.productId ? { set, full: today } : { set };
}

const num = (x: unknown) => (x == null ? null : Number(x));
