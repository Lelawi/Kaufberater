// Bewertet die gesammelten Angebote: Endpreis nach Cashback/Gutscheinen, Bestpreise, Schwellen,
// Preisschutz nach dem Kauf, Ende des Zeitfensters, künstliche Rabatte, Bündel-Möglichkeiten
import { IMPORT_MARKET } from '../util/plausible.ts';
import { db } from '../db.ts';
import { fmtEur, round2 } from '../util/money.ts';
import { sameShop, normShop } from '../util/shop.ts';
import { cheapestBasket, basketText, type Basket } from '../util/pack.ts';
import { createAlert } from './alerts.ts';
import type { ProductRow } from '../products.ts';

interface Offer {
  shop_rating?: number | null; shop_reviews?: number | null;
  id: string; product_id: string; source: string; shop: string; country: string; condition: string; url: string | null;
  price: number; shipping: number | null; total: number; list_price: number | null; in_stock: boolean | null; title: string | null;
  pack_size: number;
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
    // Ausschlusswörter (z. B. nach „Welches Produkt meinst du?“) auf schon gespeicherte Quellen, Angebote und Deals anwenden
    if (p.exclude_terms?.length) {
      const pats = p.exclude_terms.filter((t) => t.trim().length >= 3).map((t) => `%${t.trim()}%`);
      if (pats.length) {
        await sql`update kb_listings set rejected = true where product_id = ${p.id} and not rejected and discovered_by <> 'user' and title ilike any(${pats})`;
        await sql`update kb_offers set gone = true where product_id = ${p.id} and not gone and title ilike any(${pats})`;
        await sql`delete from kb_price_history h using kb_deals d where d.product_id = ${p.id} and d.title ilike any(${pats})
                  and h.product_id = d.product_id and h.series = 'deal:' || d.portal and h.total = d.price`;
        await sql`delete from kb_deals where product_id = ${p.id} and title ilike any(${pats})`;
      }
    }
    // Angebote abgelehnter Quellen zählen nicht (auch wenn ihr Titel das Ausschlusswort nicht enthält)
    await sql`update kb_offers o set gone = true from kb_listings l where l.id = o.listing_id and l.rejected and o.product_id = ${p.id} and not o.gone`;
    // Preisverlauf von abgewählten/falschen Quellen entfernen – sonst verfälschen deren Preise Diagramm, Tiefstpreis und Schwellen
    const h1 = await sql`delete from kb_price_history h using kb_offers o, kb_listings l
                         where h.product_id = ${p.id} and h.offer_id = o.id and o.listing_id = l.id and l.rejected`;
    const h2 = await sql`delete from kb_price_history h using kb_listings l
                         where l.product_id = ${p.id} and l.rejected and h.product_id = ${p.id}
                           and h.series = 'hist:' || l.source and h.shop = l.external_id`;
    if (h1.count + h2.count > 0) {
      // Tiefstpreis neu aufbauen und vorläufige Schwellen neu berechnen lassen
      await sql`update kb_products set lowest_seen = null, lowest_seen_at = null,
                  threshold_good = case when threshold_source = 'auto' and not thresholds_manual then null else threshold_good end,
                  threshold_top = case when threshold_source = 'auto' and not thresholds_manual then null else threshold_top end,
                  threshold_instant = case when threshold_source = 'auto' and not thresholds_manual then null else threshold_instant end
                where id = ${p.id}`;
      p.lowest_seen = null;
      if (p.threshold_source === 'auto' && !p.thresholds_manual) { p.threshold_good = null; p.threshold_top = null; p.threshold_instant = null; }
    }
    const offers = await sql<Offer[]>`
      select id, product_id, source, shop, country, condition, url, price, shipping, total, list_price, in_stock, title, shop_rating, shop_reviews, pack_size
      from kb_offers where product_id = ${p.id} and not gone and coalesce(in_stock, true)
        and listing_id not in (select id from kb_listings where product_id = ${p.id} and rejected)
        and (disputed_total is null or disputed_total <> total) -- vom Nutzer als falsch gemeldeter Preis (bis er sich ändert)
      `;

    // 1) Effektiver Endpreis je Angebot
    const enriched = offers.map((o) => ({ o, ...effective(o, vouchers, rates) }));
    if (enriched.length) {
      // alle Endpreise in einer Abfrage aktualisieren
      const upd = enriched.map((e) => ({ id: e.o.id, eff: e.eff, notes: e.notes || null }));
      await sql`update kb_offers o set effective_total = v.eff, effective_notes = v.notes
                from jsonb_to_recordset(${sql.json(upd as any)}) as v(id uuid, eff numeric, notes text)
                where o.id = v.id and (o.effective_total is distinct from v.eff or o.effective_notes is distinct from v.notes)`;
    }

    // 2) Bestpreise
    const newOnes = enriched.filter((e) => e.o.condition === 'new').sort((a, b) => a.eff - b.eff);
    const refurb = enriched.filter((e) => e.o.condition !== 'new').sort((a, b) => a.eff - b.eff);
    // Für Bestpreis und Meldungen nur Händler mit ordentlichen Bewertungen (unbekannte Bewertung zählt als ok)
    // Unsicher = kaum Bewertungen (< 20) oder schlecht bewertet bei wenigen Bewertungen. Große Ketten mit
    // tausenden Bewertungen bleiben drin, auch wenn ihr Schnitt mäßig ist.
    // Import-Marktplätze (AliExpress …) zählen nie als Bestpreis/Meldung: Versand aus dem Ausland, Länderversion, keine
    // deutsche Garantie (9.11.: Klipsch „USA Stock“ bei AliExpress als „Sofort zuschlagen“ gemeldet – in DE nicht lieferbar)
    const trusted = (e: (typeof enriched)[number]) =>
      !IMPORT_MARKET.test(e.o.shop) &&
      !(e.o.shop_reviews != null && e.o.shop_reviews < 20) &&
      !(e.o.shop_rating != null && e.o.shop_rating < 3.5 && (e.o.shop_reviews ?? 0) < 500);
    // Mengen-Produkte (z. B. 40 Lampen): je Händler den günstigsten Einkauf aus allen Packungsgrößen berechnen;
    // verglichen wird dann der Preis pro benötigtem Stück (eff), gemeldet auch die Gesamtsumme (sum)
    const quantity = Math.max(1, Number(p.quantity ?? 1));
    const multi = quantity > 1;
    const pickBest = (list: typeof enriched): Cand | undefined => {
      const ok = list.filter(trusted);
      if (!multi) { const e = ok[0]; return e ? { ...e, sum: e.eff } : undefined; }
      const byShop = new Map<string, typeof enriched>();
      for (const e of ok) { const k = normShop(e.o.shop) || e.o.shop; byShop.set(k, [...(byShop.get(k) ?? []), e]); }
      let bestC: Cand | undefined;
      for (const group of byShop.values()) {
        const b = cheapestBasket(group.map((e) => ({ id: e.o.id, shop: e.o.shop, pack: Number(e.o.pack_size ?? 1), price: Number(e.o.price), shipping: e.o.shipping })), quantity);
        if (!b) continue;
        const main = group.find((e) => e.o.id === b.items[0].id)!;
        // Gutscheine/Cashback auf die ganze Bestellung (nicht je Packung)
        const ef = effective({ ...main.o, price: b.goods, shipping: b.shipping, total: b.total }, vouchers, rates);
        const c: Cand = { o: main.o, eff: round2(ef.eff / quantity), sum: ef.eff, notes: ef.notes, basket: b };
        if (!bestC || c.sum < bestC.sum) bestC = c;
      }
      return bestC;
    };
    const best = pickBest(newOnes);
    const bestR = p.include_refurb ? pickBest(refurb) : undefined;
    const prevLowest = p.lowest_seen;
    const basketJson = best?.basket ? { ...best.basket, effective: best.sum, unit: best.eff, need: quantity, text: basketText(best.basket) } : null;
    await sql`update kb_products set
      best_price = ${best?.eff ?? null}, best_offer_id = ${best?.o.id ?? null}, best_basket = ${basketJson ? sql.json(basketJson as any) : null},
      best_refurb_price = ${bestR?.eff ?? null}, best_refurb_offer_id = ${bestR?.o.id ?? null},
      lowest_seen = case when ${best?.eff ?? null}::numeric is not null and (lowest_seen is null or ${best?.eff ?? null}::numeric < lowest_seen) then ${best?.eff ?? null}::numeric else lowest_seen end,
      lowest_seen_at = case when ${best?.eff ?? null}::numeric is not null and (lowest_seen is null or ${best?.eff ?? null}::numeric < lowest_seen) then now() else lowest_seen_at end,
      last_checked_at = now()
      where id = ${p.id}`;

    if (p.status === 'bought') {
      // 3) Preisschutz: nach dem Kauf deutlich günstiger?
      if (best && p.bought_price) {
        const diff = p.bought_price - best.sum;
        if (diff >= Math.max(10, p.bought_price * 0.03)) {
          const sameShopBest = newOnes.find((e) => sameShop(e.o.shop, p.bought_shop));
          const days = p.return_until ? Math.ceil((new Date(p.return_until).getTime() - Date.now()) / 86400000) : null;
          stats.alerts += await createAlert({
            userId: p.user_id, productId: p.id, kind: 'price_protection', level: 'top',
            title: `${p.name}: jetzt ${fmtEur(diff)} günstiger als dein Kauf`,
            body: `Du hast ${fmtEur(p.bought_price)} bezahlt. Jetzt: ${fmtEur(best.sum)} bei ${best.o.shop}${multi ? ` (für ${quantity} Stück)` : ''}` +
              (sameShopBest ? ` (bei ${sameShopBest.o.shop}: ${fmtEur(sameShopBest.eff)} – frag dort nach Preisanpassung)` : '') +
              (days !== null ? `. Rückgabe noch ${days} Tag(e) möglich: zurückschicken und neu kaufen lohnt sich.` : '.'),
            url: best.o.url, dedupKey: `pp:${p.id}:${Math.floor(best.sum / 5)}`,
          });
        }
      }
      continue;
    }

    if (!best && !bestR) continue;

    // 4) Schwellen
    const fakeNote = best && !multi ? fakeDiscountNote(best.o, await maxSeen(p.id)) : '';
    // Schwellen gelten bei Mengen-Produkten pro Stück, der Höchstpreis für die ganze Menge
    const levels: [string, number | null][] = [['instant', p.threshold_instant], ['top', p.threshold_top], ['good', p.threshold_good ?? (p.max_price ? p.max_price / quantity : null)]];
    const where = (c: Cand) => `${c.o.shop}${c.o.country !== 'DE' ? ` (${c.o.country})` : ''}`;
    const perPiece = multi ? '/Stück' : '';
    for (const cand of [best, bestR].filter(Boolean) as Cand[]) {
      const isRefurb = cand.o.condition !== 'new';
      // Wunschpreis erreicht → dafür kommt unten eine eigene Meldung, nicht zweimal für dasselbe Angebot melden
      if (p.max_price && cand.sum <= p.max_price) continue;
      const hit = levels.find(([, t]) => t !== null && cand.eff <= (isRefurb ? t! * 0.9 : t!));
      if (!hit) continue;
      const [level] = hit;
      // nicht erneut melden, wenn in den letzten 7 Tagen schon ein gleich guter/besserer Preis gemeldet wurde
      // (sonst kommt nach einem Tag dieselbe oder sogar eine schlechtere Meldung noch einmal)
      const recent = await sql`select 1 from kb_alerts where product_id = ${p.id} and kind = 'threshold'
        and created_at > now() - interval '7 days'
        and dedup_key like ${`thr:${p.id}:${isRefurb ? 'r' : 'n'}:%`}
        and split_part(dedup_key, ':', 5)::numeric <= ${Math.floor(cand.eff)} limit 1`;
      if (recent.length) continue;
      stats.alerts += await createAlert({
        userId: p.user_id, productId: p.id, kind: 'threshold', level: level as any,
        title: `${LEVEL_LABEL[level]} ${isRefurb ? '(Refurbished) ' : ''}${p.name}: ${fmtEur(cand.eff)}${perPiece}`,
        body: (cand.basket
          ? `${quantity} Stück bei ${where(cand)}: ${basketText(cand.basket)} = ${fmtEur(cand.basket.total)}` +
            (cand.notes ? `, nach ${cand.notes} effektiv ${fmtEur(cand.sum)}` : '') +
            (cand.basket.pieces > quantity ? ` (du bekommst ${cand.basket.pieces} Stück)` : '')
          : `Bei ${where(cand)}: ${fmtEur(cand.o.total)}` + (cand.notes ? `, nach ${cand.notes} effektiv ${fmtEur(cand.eff)}` : '')) +
          (p.lowest_seen ? `. Bisher günstigster beobachteter Preis: ${fmtEur(p.lowest_seen)}${perPiece}.` : '.') +
          (fakeNote && !isRefurb ? ` ${fakeNote}` : ''),
        url: cand.o.url, dedupKey: `thr:${p.id}:${isRefurb ? 'r' : 'n'}:${level}:${Math.floor(cand.eff)}`,
      });
    }

    // 4b) Eigener Wunschpreis (Höchstpreis) erreicht – unabhängig von den Schwellen
    if (p.max_price) {
      for (const cand of [best, bestR].filter(Boolean) as Cand[]) {
        if (cand.sum > p.max_price) continue;
        const isRefurb = cand.o.condition !== 'new';
        stats.alerts += await createAlert({
          userId: p.user_id, productId: p.id, kind: 'threshold', level: 'instant',
          title: `Dein Wunschpreis ist erreicht: ${p.name}${isRefurb ? ' (Refurbished)' : ''} für ${fmtEur(cand.sum)}${multi ? ` (${quantity} Stück)` : ''}`,
          body: `Bei ${where(cand)}${cand.basket ? `: ${basketText(cand.basket)}` : ''}. Dein Höchstpreis: ${fmtEur(p.max_price)}.` + (cand.notes ? ` Effektiv nach ${cand.notes}.` : ''),
          url: cand.o.url, dedupKey: `max:${p.id}:${isRefurb ? 'r' : 'n'}:${Math.floor(cand.sum / 10)}`,
        });
      }
    }

    // 5) Ohne Schwellen (noch keine Analyse): neuer Tiefstpreis deutlich unter bisherigem Minimum
    if (best && p.threshold_good === null && p.max_price === null && prevLowest && best.eff < prevLowest * 0.95) {
      stats.alerts += await createAlert({
        userId: p.user_id, productId: p.id, kind: 'threshold', level: 'good',
        title: `Neuer Tiefstpreis: ${p.name} für ${fmtEur(best.eff)}${perPiece}`,
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
          userId: p.user_id, productId: p.id, kind: 'analysis', level: lvl === 'instant' || lvl === 'top' ? 'top' : lvl === 'good' ? 'good' : 'info',
          title: `Jetzt ist der empfohlene Kaufzeitraum: ${p.name}`,
          body: `${rec.best_buy_window ?? ''}. Aktuell bester Preis: ${fmtEur(best.eff)}${perPiece} bei ${best.o.shop}${multi ? ` (${quantity} Stück: ${fmtEur(best.sum)})` : ''}` +
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
          body: `Aktuell bester Preis: ${fmtEur(multi ? best.sum : best.eff)} bei ${best.o.shop}${multi ? ` für ${quantity} Stück` : ''}. Wenn du es bis dahin brauchst, ist jetzt der Moment.`,
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

type Cand = { o: Offer; eff: number; sum: number; notes: string; basket?: Basket };

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
