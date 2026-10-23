// Deal-Portale nach den Wunschprodukten durchsuchen, neue Deals speichern und melden
import { db } from '../db.ts';
import { DEAL_SOURCES } from '../adapters/registry.ts';
import { toQuery, type ProductRow } from '../products.ts';
import { recordSourceResult } from './health.ts';
import { createAlert } from './alerts.ts';
import { fmtEur } from '../util/money.ts';
import { IMPORT_MARKET } from '../util/plausible.ts';
import { hotWindow } from '../util/events.ts';
import { packSize } from '../util/pack.ts';

export async function runDeals(deadline: number, opts: { productId?: string; portals?: string[] } = {}) {
  const sql = await db();
  // In der heißen Phase (Black Week, Singles Day) Deal-Portale alle 15 statt 50 Minuten abfragen
  const everyMin = hotWindow() ? 15 : 50;
  const products = await sql<ProductRow[]>`
    select * from kb_products where status = 'watching'
      and (${opts.productId ?? null}::uuid is null or id = ${opts.productId ?? null}::uuid)
      and (${opts.productId ?? null}::uuid is not null or deals_checked_at is null or deals_checked_at < now() - make_interval(mins => ${everyMin}))
    order by deals_checked_at nulls first
    limit ${Number(process.env.KB_DEALS_PER_RUN ?? 20)}`;
  const adapters = DEAL_SOURCES.filter((a) => !opts.portals || opts.portals.includes(a.key));
  const stats = { products: 0, found: 0, newDeals: 0, alerts: 0 };
  for (const p of products) {
    if (Date.now() > deadline) break;
    stats.products++;
    const q = toQuery(p);
    const multi = (p.quantity ?? 1) > 1;
    await sql`update kb_products set deals_checked_at = now() where id = ${p.id}`;
    await Promise.all(adapters.map(async (ad) => {
      let deals;
      try { deals = await ad.search(q); await recordSourceResult(ad.key, true); }
      catch (e) { await recordSourceResult(ad.key, false, (e as Error).message); return; }
      for (const d of deals as any[]) {
        stats.found++;
        const importWare = IMPORT_MARKET.test(d.merchant ?? '') || IMPORT_MARKET.test(d.title);
        const pack = packSize(d.title) ?? 1;
        // Mengen-Produkte: Deal-Preis pro Stück vergleichen (Schwellen und Bestpreis gelten dann pro Stück)
        const cmp: number | null = d.price ? (multi ? Math.round(d.price / pack * 100) / 100 : d.price) : null;
        const notes = d.foreign ? `Händler in ${ad.country} – Lieferung nach DE prüfen` : importWare ? 'Marktplatz/Import – Garantie und Länderversion prüfen' : null;
        const r = await sql`
          insert into kb_deals (product_id, user_id, portal, external_id, title, url, merchant, price, next_best_price, temperature,
                                comment_count, posted_at, expired, voucher_code, match_score, notes, pack_size)
          values (${p.id}, ${p.user_id}, ${d.portal}, ${d.externalId}, ${d.title.slice(0, 500)}, ${d.url}, ${d.merchant ?? null}, ${d.price ?? null},
                  ${d.nextBestPrice ?? null}, ${d.temperature ?? null}, ${d.commentCount ?? null}, ${d.postedAt ?? null}, ${!!d.expired},
                  ${d.voucherCode ?? null}, ${d.score}, ${notes}, ${pack})
          on conflict (product_id, portal, external_id) do update set
            temperature = excluded.temperature, comment_count = excluded.comment_count, expired = excluded.expired,
            price = coalesce(excluded.price, kb_deals.price), notes = excluded.notes, match_score = excluded.match_score
          returning (xmax = 0) as inserted`;
        const isNew = r[0]?.inserted;
        if (isNew) stats.newDeals++;
        // Deal als Preisstützpunkt in den Verlauf (auch alte – gibt Preisgeschichte)
        if (isNew && d.price) {
          await sql`insert into kb_price_history (product_id, user_id, series, shop, condition, observed_at, total, pack_size)
                    values (${p.id}, ${p.user_id}, ${'deal:' + d.portal}, ${d.merchant ?? d.portal}, 'new', ${d.postedAt ?? new Date()}, ${d.price}, ${pack})`;
        }
        // Melden: neu, aktiv, jünger als 3 Tage, Lieferung nach DE möglich, und Preis interessant
        const fresh = d.postedAt && Date.now() - new Date(d.postedAt).getTime() < 3 * 86400_000;
        if (isNew && fresh && !d.expired && !d.foreign) {
          // Höchstpreis gilt für die ganze Menge → pro Stück umrechnen
          const maxUnit = p.max_price ? (multi ? p.max_price / p.quantity : p.max_price) : null;
          const ref = Math.max(p.threshold_good ?? 0, maxUnit ?? 0) || p.best_price;
          const interesting = !cmp || !ref || cmp <= ref * 1.02;
          if (interesting) {
            const level = cmp && ((p.threshold_instant && cmp <= p.threshold_instant) || (maxUnit && cmp <= maxUnit)) ? 'instant'
              : cmp && p.threshold_top && cmp <= p.threshold_top ? 'top' : 'good';
            stats.alerts += await createAlert({
              userId: p.user_id, productId: p.id, kind: 'deal', level,
              title: `${ad.label}-Deal: ${p.name}${d.price ? ' für ' + fmtEur(d.price) : ''}${multi && pack > 1 && cmp ? ` (${pack} Stück, ${fmtEur(cmp)}/Stück)` : ''}`,
              body: `${d.title}${d.merchant ? ' – bei ' + d.merchant : ''}${d.temperature !== null ? ` (${Math.round(d.temperature)}°)` : ''}` +
                (d.voucherCode ? ` Gutscheincode: ${d.voucherCode}` : '') +
                (importWare ? ' Achtung: Marktplatz/Import – Garantie und Länderversion prüfen.' : '') +
                (p.best_price && d.price ? `. Zum Vergleich: bester beobachteter Preis aktuell ${fmtEur(p.best_price)}${multi ? ' pro Stück' : ''}.` : ''),
              url: d.url, dedupKey: `deal:${d.portal}:${d.externalId}`,
            });
          }
        }
      }
    }));
  }
  return stats;
}
