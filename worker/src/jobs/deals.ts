// Deal-Portale nach den Wunschprodukten durchsuchen, neue Deals speichern und melden
import { db } from '../db.ts';
import { DEAL_SOURCES } from '../adapters/registry.ts';
import { toQuery, type ProductRow } from '../products.ts';
import { recordSourceResult } from './health.ts';
import { createAlert } from './alerts.ts';
import { fmtEur } from '../util/money.ts';

export async function runDeals(deadline: number, opts: { productId?: string; portals?: string[] } = {}) {
  const sql = await db();
  const products = await sql<ProductRow[]>`
    select * from kb_products where status = 'watching'
      and (${opts.productId ?? null}::uuid is null or id = ${opts.productId ?? null}::uuid)
    order by random()`;
  const adapters = DEAL_SOURCES.filter((a) => !opts.portals || opts.portals.includes(a.key));
  const stats = { products: 0, found: 0, newDeals: 0, alerts: 0 };
  for (const p of products) {
    if (Date.now() > deadline) break;
    stats.products++;
    const q = toQuery(p);
    await Promise.all(adapters.map(async (ad) => {
      let deals;
      try { deals = await ad.search(q); await recordSourceResult(ad.key, true); }
      catch (e) { await recordSourceResult(ad.key, false, (e as Error).message); return; }
      for (const d of deals as any[]) {
        stats.found++;
        const notes = d.foreign ? `Händler in ${ad.country} – Lieferung nach DE prüfen` : null;
        const r = await sql`
          insert into kb_deals (product_id, user_id, portal, external_id, title, url, merchant, price, next_best_price, temperature,
                                comment_count, posted_at, expired, voucher_code, match_score, notes)
          values (${p.id}, ${p.user_id}, ${d.portal}, ${d.externalId}, ${d.title.slice(0, 500)}, ${d.url}, ${d.merchant ?? null}, ${d.price ?? null},
                  ${d.nextBestPrice ?? null}, ${d.temperature ?? null}, ${d.commentCount ?? null}, ${d.postedAt ?? null}, ${!!d.expired},
                  ${d.voucherCode ?? null}, ${d.score}, ${notes})
          on conflict (product_id, portal, external_id) do update set
            temperature = excluded.temperature, comment_count = excluded.comment_count, expired = excluded.expired,
            price = coalesce(excluded.price, kb_deals.price)
          returning (xmax = 0) as inserted`;
        const isNew = r[0]?.inserted;
        if (isNew) stats.newDeals++;
        // Deal als Preisstützpunkt in den Verlauf (auch alte – gibt Preisgeschichte)
        if (isNew && d.price) {
          await sql`insert into kb_price_history (product_id, user_id, series, shop, condition, observed_at, total)
                    values (${p.id}, ${p.user_id}, ${'deal:' + d.portal}, ${d.merchant ?? d.portal}, 'new', ${d.postedAt ?? new Date()}, ${d.price})`;
        }
        // Melden: neu, aktiv, jünger als 3 Tage, Lieferung nach DE möglich, und Preis interessant
        const fresh = d.postedAt && Date.now() - new Date(d.postedAt).getTime() < 3 * 86400_000;
        if (isNew && fresh && !d.expired && !d.foreign) {
          const ref = p.threshold_good ?? p.max_price ?? p.best_price;
          const interesting = !d.price || !ref || d.price <= ref * 1.02;
          if (interesting) {
            const level = d.price && p.threshold_instant && d.price <= p.threshold_instant ? 'instant'
              : d.price && p.threshold_top && d.price <= p.threshold_top ? 'top' : 'good';
            stats.alerts += await createAlert({
              userId: p.user_id, productId: p.id, kind: 'deal', level,
              title: `${ad.label}-Deal: ${p.name}${d.price ? ' für ' + fmtEur(d.price) : ''}`,
              body: `${d.title}${d.merchant ? ' – bei ' + d.merchant : ''}${d.temperature !== null ? ` (${Math.round(d.temperature)}°)` : ''}` +
                (d.voucherCode ? ` Gutscheincode: ${d.voucherCode}` : '') +
                (p.best_price && d.price ? `. Zum Vergleich: bester beobachteter Preis aktuell ${fmtEur(p.best_price)}.` : ''),
              url: d.url, dedupKey: `deal:${d.portal}:${d.externalId}`,
            });
          }
        }
      }
    }));
  }
  return stats;
}
