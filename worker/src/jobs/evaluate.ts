// Bewertet die gesammelten Angebote: Endpreis nach Cashback/Gutscheinen, Bestpreise, Schwellen,
// Preisschutz nach dem Kauf, Ende des Zeitfensters, künstliche Rabatte, Bündel-Möglichkeiten
import { db } from '../db.ts';
import { fmtEur, round2 } from '../util/money.ts';
import { sameShop } from '../util/shop.ts';
import { createAlert } from './alerts.ts';
import type { ProductRow } from '../products.ts';

interface Offer {
  id: string; product_id: string; source: string; shop: string; country: string; condition: string; url: string | null;
  price: number; shipping: number | null; total: number; list_price: number | null; in_stock: boolean | null; title: string | null;
}
interface Voucher { id: string; kind: string; shop: string | null; label: string; code: string | null; value: number | null; value_type: string | null; min_order: number | null; valid_until: Date | null }
interface Rate { portal: string; shop: string; rate_percent: number | null; rate_eur: number | null; rate_text: string }

const LEVEL_LABEL: Record<string, string> = { good: 'Guter Preis', top: 'Top-Preis', instant: 'Sofort zuschlagen!' };

export async function runEvaluate(opts: { productId?: string } = {}) {
  const sql = await db();
  const products = await sql<(ProductRow & { bought_shop: string | null })[]>`
    select * from kb_products
    where (status = 'watching' or (status = 'bought' and return_until >= current_date))
      and (${opts.productId ?? null}::uuid is null or id = ${opts.productId ?? null}::uuid)`;
  const rates = await sql<Rate[]>`select portal, shop, rate_percent, rate_eur, rate_text from kb_cashback_rates`;
  const stats = { products: products.length, alerts: 0 };
  const userVouchers = new Map<string, Voucher[]>();
  const bundleCandidates = new Map<string, { voucher: Voucher; items: { product: string; name: string; offer: Offer }[] }>();

  for (const p of products) {
    if (!userVouchers.has(p.user_id)) {
      userVouchers.set(p.user_id, await sql<Voucher[]>`
        select id, kind, shop, label, code, value, value_type, min_order, valid_until from kb_vouchers
        where user_id = ${p.user_id} and active and (valid_until is null or valid_until >= current_date)`);
    }
    const vouchers = userVouchers.get(p.user_id)!;
    const offers = await sql<Offer[]>`
      select id, product_id, source, shop, country, condition, url, price, shipping, total, list_price, in_stock, title
      from kb_offers where product_id = ${p.id} and not gone and coalesce(in_stock, true)`;

    // 1) Effektiver Endpreis je Angebot
    const enriched = offers.map((o) => ({ o, ...effective(o, vouchers, rates) }));
    for (const e of enriched) {
      await sql`update kb_offers set effective_total = ${e.eff}, effective_notes = ${e.notes || null} where id = ${e.o.id}
                and (effective_total is distinct from ${e.eff} or effective_notes is distinct from ${e.notes || null})`;
    }

    // 2) Bestpreise
    const newOnes = enriched.filter((e) => e.o.condition === 'new').sort((a, b) => a.eff - b.eff);
    const refurb = enriched.filter((e) => e.o.condition !== 'new').sort((a, b) => a.eff - b.eff);
    const best = newOnes[0];
    const bestR = p.include_refurb ? refurb[0] : undefined;
    const prevLowest = p.lowest_seen;
    await sql`update kb_products set
      best_price = ${best?.eff ?? null}, best_offer_id = ${best?.o.id ?? null},
      best_refurb_price = ${bestR?.eff ?? null}, best_refurb_offer_id = ${bestR?.o.id ?? null},
      lowest_seen = case when ${best?.eff ?? null}::numeric is not null and (lowest_seen is null or ${best?.eff ?? null}::numeric < lowest_seen) then ${best?.eff ?? null}::numeric else lowest_seen end,
      lowest_seen_at = case when ${best?.eff ?? null}::numeric is not null and (lowest_seen is null or ${best?.eff ?? null}::numeric < lowest_seen) then now() else lowest_seen_at end,
      last_checked_at = now()
      where id = ${p.id}`;

    if (p.status === 'bought') {
      // 3) Preisschutz: nach dem Kauf deutlich günstiger?
      if (best && p.bought_price) {
        const diff = p.bought_price - best.eff;
        if (diff >= Math.max(10, p.bought_price * 0.03)) {
          const sameShopBest = newOnes.find((e) => sameShop(e.o.shop, p.bought_shop));
          const days = p.return_until ? Math.ceil((new Date(p.return_until).getTime() - Date.now()) / 86400000) : null;
          stats.alerts += await createAlert({
            userId: p.user_id, productId: p.id, kind: 'price_protection', level: 'top',
            title: `${p.name}: jetzt ${fmtEur(diff)} günstiger als dein Kauf`,
            body: `Du hast ${fmtEur(p.bought_price)} bezahlt. Jetzt: ${fmtEur(best.eff)} bei ${best.o.shop}` +
              (sameShopBest ? ` (bei ${sameShopBest.o.shop}: ${fmtEur(sameShopBest.eff)} – frag dort nach Preisanpassung)` : '') +
              (days !== null ? `. Rückgabe noch ${days} Tag(e) möglich: zurückschicken und neu kaufen lohnt sich.` : '.'),
            url: best.o.url, dedupKey: `pp:${p.id}:${Math.floor(best.eff / 5)}`,
          });
        }
      }
      continue;
    }

    if (!best && !bestR) continue;

    // 4) Schwellen
    const fakeNote = best ? fakeDiscountNote(best.o, await maxSeen(p.id)) : '';
    const levels: [string, number | null][] = [['instant', p.threshold_instant], ['top', p.threshold_top], ['good', p.threshold_good ?? p.max_price]];
    for (const cand of [best, bestR].filter(Boolean) as typeof enriched) {
      const isRefurb = cand.o.condition !== 'new';
      const hit = levels.find(([, t]) => t !== null && cand.eff <= (isRefurb ? t! * 0.9 : t!));
      if (!hit) continue;
      const [level] = hit;
      // nicht erneut melden, wenn in den letzten 24h schon ein gleich guter/besserer Preis gemeldet wurde
      const recent = await sql`select 1 from kb_alerts where product_id = ${p.id} and kind = 'threshold'
        and created_at > now() - interval '24 hours'
        and dedup_key like ${`thr:${p.id}:${isRefurb ? 'r' : 'n'}:%`}
        and split_part(dedup_key, ':', 5)::numeric <= ${Math.floor(cand.eff)} limit 1`;
      if (recent.length) continue;
      stats.alerts += await createAlert({
        userId: p.user_id, productId: p.id, kind: 'threshold', level: level as any,
        title: `${LEVEL_LABEL[level]} ${isRefurb ? '(Refurbished) ' : ''}${p.name}: ${fmtEur(cand.eff)}`,
        body: `Bei ${cand.o.shop}${cand.o.country !== 'DE' ? ` (${cand.o.country})` : ''}: ${fmtEur(cand.o.total)}` +
          (cand.notes ? `, nach ${cand.notes} effektiv ${fmtEur(cand.eff)}` : '') +
          (p.lowest_seen ? `. Bisher günstigster beobachteter Preis: ${fmtEur(p.lowest_seen)}.` : '.') +
          (fakeNote && !isRefurb ? ` ${fakeNote}` : ''),
        url: cand.o.url, dedupKey: `thr:${p.id}:${isRefurb ? 'r' : 'n'}:${level}:${Math.floor(cand.eff)}`,
      });
    }

    // 4b) Eigener Wunschpreis (Höchstpreis) erreicht – unabhängig von den Schwellen
    if (p.max_price) {
      for (const cand of [best, bestR].filter(Boolean) as typeof enriched) {
        if (cand.eff > p.max_price) continue;
        const isRefurb = cand.o.condition !== 'new';
        stats.alerts += await createAlert({
          userId: p.user_id, productId: p.id, kind: 'threshold', level: 'instant',
          title: `Dein Wunschpreis ist erreicht: ${p.name}${isRefurb ? ' (Refurbished)' : ''} für ${fmtEur(cand.eff)}`,
          body: `Bei ${cand.o.shop}${cand.o.country !== 'DE' ? ` (${cand.o.country})` : ''}. Dein Höchstpreis: ${fmtEur(p.max_price)}.` + (cand.notes ? ` Effektiv nach ${cand.notes}.` : ''),
          url: cand.o.url, dedupKey: `max:${p.id}:${isRefurb ? 'r' : 'n'}:${Math.floor(cand.eff / 10)}`,
        });
      }
    }

    // 5) Ohne Schwellen (noch keine Analyse): neuer Tiefstpreis deutlich unter bisherigem Minimum
    if (best && p.threshold_good === null && p.max_price === null && prevLowest && best.eff < prevLowest * 0.95) {
      stats.alerts += await createAlert({
        userId: p.user_id, productId: p.id, kind: 'threshold', level: 'good',
        title: `Neuer Tiefstpreis: ${p.name} für ${fmtEur(best.eff)}`,
        body: `Bei ${best.o.shop}. Bisheriges Minimum seit Beobachtung: ${fmtEur(prevLowest)}.`,
        url: best.o.url, dedupKey: `low:${p.id}:${Math.floor(best.eff)}`,
      });
    }

    // 5b) Von der Tiefenanalyse empfohlener Kaufzeitpunkt ist da
    const [rec] = await sql`select best_buy_date, best_buy_window from kb_analyses where product_id = ${p.id} order by created_at desc limit 1`;
    if (best && rec?.best_buy_date) {
      const d0 = new Date(rec.best_buy_date).getTime();
      if (Date.now() >= d0 - 12 * 3600_000 && Date.now() <= d0 + 4 * 86400_000) {
        const lvl = levels.find(([, t]) => t !== null && best.eff <= t!)?.[0];
        stats.alerts += await createAlert({
          userId: p.user_id, productId: p.id, kind: 'analysis', level: lvl === 'instant' || lvl === 'top' ? 'top' : 'info',
          title: `Jetzt ist der empfohlene Kaufzeitraum: ${p.name}`,
          body: `${rec.best_buy_window ?? ''}. Aktuell bester Preis: ${fmtEur(best.eff)} bei ${best.o.shop}` +
            (lvl && lvl !== 'wait' ? ` – das ist ein ${LEVEL_LABEL[lvl] ?? 'guter Preis'}.` : `. Die Schwellen sind noch nicht erreicht; schau dir die Angebote trotzdem an.`),
          url: best.o.url, dedupKey: `when:${p.id}:${new Date(rec.best_buy_date).toISOString().slice(0, 10)}`,
        });
      }
    }

    // 6) Hartes Zeitfenster läuft ab
    if (p.window_type === 'hard' && p.window_end && best) {
      const daysLeft = Math.ceil((new Date(p.window_end).getTime() - Date.now()) / 86400000);
      if (daysLeft <= 3 && daysLeft >= 0) {
        stats.alerts += await createAlert({
          userId: p.user_id, productId: p.id, kind: 'threshold', level: 'warning',
          title: `Zeitfenster endet in ${daysLeft} Tag(en): ${p.name}`,
          body: `Aktuell bester Preis: ${fmtEur(best.eff)} bei ${best.o.shop}. Wenn du es bis dahin brauchst, ist jetzt der Moment.`,
          url: best.o.url, dedupKey: `win:${p.id}:${p.window_end}`,
        });
      }
    }

    // 7) Bündel-Kandidaten sammeln (Gutschein mit Mindestbestellwert)
    for (const v of vouchers.filter((x) => x.kind === 'voucher' && x.min_order && x.shop)) {
      const atShop = newOnes.find((e) => sameShop(e.o.shop, v.shop));
      if (!atShop || atShop.o.total >= v.min_order!) continue;
      const k = `${p.user_id}:${v.id}`;
      const entry = bundleCandidates.get(k) ?? { voucher: v, items: [] };
      entry.items.push({ product: p.id, name: p.name, offer: atShop.o });
      bundleCandidates.set(k, entry);
    }
  }

  for (const [k, { voucher, items }] of bundleCandidates) {
    if (items.length < 2) continue;
    const sum = round2(items.reduce((s, i) => s + i.offer.total, 0));
    if (sum < voucher.min_order!) continue;
    const userId = k.split(':')[0];
    stats.alerts += await createAlert({
      userId, productId: null, kind: 'bundle', level: 'info',
      title: `Bündeln lohnt sich bei ${voucher.shop}`,
      body: `${items.map((i) => i.name).join(' + ')} = ${fmtEur(sum)} – damit greift dein Gutschein „${voucher.label}“ (ab ${fmtEur(voucher.min_order)}).`,
      url: items[0].offer.url, dedupKey: `bundle:${voucher.id}:${items.map((i) => i.product).sort().join(',')}`,
    });
  }
  return stats;
}

function effective(o: Offer, vouchers: Voucher[], rates: Rate[]): { eff: number; notes: string } {
  let eff = Number(o.total);
  const notes: string[] = [];
  // Prime: kostenloser Versand bei Amazon
  if (o.source.startsWith('amazon') && o.shipping && vouchers.some((v) => v.kind === 'membership' && /prime/i.test(v.label))) {
    eff -= Number(o.shipping); notes.push('Prime-Versand');
  }
  // Bester einzelner Gutschein
  let bestV: { amount: number; label: string } | null = null;
  for (const v of vouchers.filter((x) => x.kind === 'voucher' && x.value)) {
    if (v.shop && !sameShop(v.shop, o.shop)) continue;
    if (v.min_order && o.price < v.min_order) continue;
    const amount = v.value_type === 'percent' ? o.price * Number(v.value) / 100 : Number(v.value);
    if (!bestV || amount > bestV.amount) bestV = { amount, label: v.label };
  }
  if (bestV) { eff -= bestV.amount; notes.push(`Gutschein ${bestV.label} (−${fmtEur(bestV.amount)})`); }
  // Cashback über eigene Cashback-Konten
  const portals = vouchers.filter((v) => v.kind === 'cashback').map((v) => v.label.toLowerCase());
  let bestC: { amount: number; label: string } | null = null;
  for (const r of rates) {
    if (!portals.some((p) => r.portal.toLowerCase().includes(p) || p.includes(r.portal.toLowerCase()))) continue;
    if (!sameShop(r.shop, o.shop)) continue;
    const amount = r.rate_percent ? o.price * Number(r.rate_percent) / 100 : Number(r.rate_eur ?? 0);
    if (amount > 0 && (!bestC || amount > bestC.amount)) bestC = { amount, label: `${r.portal} ${r.rate_text}` };
  }
  if (bestC) { eff -= bestC.amount; notes.push(`Cashback ${bestC.label} (−${fmtEur(bestC.amount)})`); }
  return { eff: round2(Math.max(0, eff)), notes: notes.join(', ') };
}

async function maxSeen(productId: string): Promise<number | null> {
  const sql = await db();
  const r = await sql`select max(total) as m from kb_price_history where product_id = ${productId} and observed_at > now() - interval '120 days'`;
  return r[0]?.m ? Number(r[0].m) : null;
}

/** Streichpreise, die nie real verlangt wurden, entlarven */
function fakeDiscountNote(o: Offer, maxObserved: number | null): string {
  if (!o.list_price || !maxObserved) return '';
  if (o.list_price > maxObserved * 1.15 && o.list_price > o.total * 1.2) {
    const claimed = Math.round((1 - o.total / o.list_price) * 100);
    return `Achtung: Der Shop wirbt mit −${claimed} % gegenüber ${fmtEur(o.list_price)}, dieser Preis wurde aber nie beobachtet (max. ${fmtEur(maxObserved)}).`;
  }
  return '';
}
