// Gutscheine & Aktionen der Händler von mydealz (geprüfte Gutscheinseiten, keine Gutschein-Spam-Seiten).
// Läuft einmal täglich für die Händler, die bei den beobachteten Produkten vorne liegen.
import { createHash } from 'node:crypto';
import { db } from '../db.ts';
import { fetchPage, HttpError } from '../util/http.ts';
import { loadHtml } from '../util/extract.ts';
import { normShop } from '../util/shop.ts';
import { parsePrice } from '../util/money.ts';

const SLUG_OVERRIDES: Record<string, string> = { galaxus: 'galaxus.de', amazon: 'amazon-de', mediamarkt: 'mediamarkt-de', saturn: 'saturn-de' };

export interface ShopVoucher { title: string; code: boolean; value: number | null; valueType: 'eur' | 'percent' | null; cashbackPercent: number | null }

export function parseVoucherPage(html: string): ShopVoucher[] {
  const $ = loadHtml(html);
  const list = $('[data-testid="offer-card-list-container"]').first();
  const out: ShopVoucher[] = [];
  list.find('h3').each((_, h) => {
    const title = $(h).text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    if (/abgelaufen/i.test(title)) return false;   // ab hier nur noch abgelaufene Gutscheine
    let card = $(h);
    for (let i = 0; i < 8 && card.parent().length && !card.parent().is(list); i++) card = card.parent();
    const text = card.text().replace(/\s+/g, ' ');
    const cb = title.match(/(\d+(?:,\d+)?)\s*%\s*Cashback auf Deine Einkäufe/i);
    const pct = title.match(/(\d+(?:,\d+)?)\s*%/);
    const eur = title.match(/(\d+(?:[.,]\d+)?)\s*€/);
    out.push({
      title, code: /Code anzeigen|Gutscheincode/i.test(text + title),
      value: pct ? Number(pct[1].replace(',', '.')) : eur ? parsePrice(eur[1]) : null,
      valueType: pct ? 'percent' : eur ? 'eur' : null,
      cashbackPercent: cb ? Number(cb[1].replace(',', '.')) : null,
    });
  });
  return out;
}

export async function runVouchers(force = false) {
  const sql = await db();
  // höchstens einmal am Tag
  const last = await sql`select max(last_seen_at) as t from kb_shop_vouchers where source = 'mydealz'`;
  if (!force && last[0]?.t && Date.now() - new Date(last[0].t).getTime() < 20 * 3600_000) return { skipped: true };
  const shops = await sql`
    select distinct on (lower(o.shop)) o.shop from (
      select shop, row_number() over (partition by product_id order by effective_total) rn
      from kb_offers where not gone and condition = 'new' and product_id in (select id from kb_products where status = 'watching')
    ) o where o.rn <= 6`;
  let found = 0; let pages = 0;
  for (const { shop } of shops) {
    const n = normShop(shop).replace(/(onlineshop|shop)$/, '');
    if (!n || n.length < 3) continue;
    const slugs = SLUG_OVERRIDES[n] ? [SLUG_OVERRIDES[n]] : [`${n}-de`, `${n}.de`];
    for (const slug of slugs) {
      try {
        const p = await fetchPage(`https://www.mydealz.de/gutscheine/${slug}`, { minDelayMs: 4000, retries: 0 });
        pages++;
        const vs = parseVoucherPage(p.text);
        for (const v of vs) {
          const id = createHash('md5').update(v.title).digest('hex');
          await sql`insert into kb_shop_vouchers (shop, source, external_id, title, code, value, value_type, url, last_seen_at, expired)
                    values (${n}, 'mydealz', ${id}, ${v.title.slice(0, 300)}, ${null}, ${v.value}, ${v.valueType}, ${p.url}, now(), false)
                    on conflict (source, external_id) do update set last_seen_at = now(), expired = false, shop = excluded.shop`;
          if (v.cashbackPercent) {
            await sql`insert into kb_cashback_rates (portal, shop, rate_text, rate_percent, url, updated_at)
                      values ('mydealz Cashback', ${n}, ${v.cashbackPercent.toLocaleString('de-DE') + ' %'}, ${v.cashbackPercent}, ${p.url}, now())
                      on conflict (portal, shop) do update set rate_text = excluded.rate_text, rate_percent = excluded.rate_percent, updated_at = now()`;
          }
          found++;
        }
        // nicht mehr gelistete Gutscheine dieses Shops als abgelaufen markieren
        await sql`update kb_shop_vouchers set expired = true where source = 'mydealz' and shop = ${n} and last_seen_at < now() - interval '1 hour'`;
        break;
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) continue;
        break;
      }
    }
  }
  return { shops: shops.length, pages, found };
}
