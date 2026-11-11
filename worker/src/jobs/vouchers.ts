// Gutscheine & Aktionen der Händler von mydealz (geprüfte Gutscheinseiten, keine Gutschein-Spam-Seiten).
// Läuft einmal täglich für die Händler, die bei den beobachteten Produkten vorne liegen.
import { createHash } from 'node:crypto';
import { db } from '../db.ts';
import { fetchPage, HttpError } from '../util/http.ts';
import { loadHtml } from '../util/extract.ts';
import { normShop } from '../util/shop.ts';
import { parsePrice } from '../util/money.ts';
import { parsePepperList } from '../adapters/pepper.ts';

const SLUG_OVERRIDES: Record<string, string> = { galaxus: 'galaxus.de', amazon: 'amazon-de', mediamarkt: 'mediamarkt-de', saturn: 'saturn-de' };

export interface ShopVoucher { title: string; code: boolean; value: number | null; valueType: 'eur' | 'percent' | null; cashbackPercent: number | null; minOrder: number | null; general: boolean }

/** Mindestbestellwert aus Titel/Beschreibung: „11 € ab 100 €“, „200 EUR MBW“, „Mindestbestellwert: 50 €“ */
export function minOrderOf(text: string): number | null {
  const m = text.match(/(?:\bab|MBW:?|Mindestbestellwert:?|Mindestbestellwert von)\s*(\d{2,4}(?:[.,]\d{2})?)\s*(?:€|EUR|Euro)/i)
    ?? text.match(/(\d{2,4})\s*(?:€|EUR|Euro)\s*MBW/i);
  return m ? parsePrice(m[1]) : null;
}

/** Allgemeine Aktion des Shops (gilt für den ganzen Einkauf, ohne Bedingung an die Person) – wird beim Preis
 *  eingerechnet (11.11.: „Singles Day 11 % Direktabzug“, „11 € ab 100 €“ stehen nicht am Produkt).
 *  Nicht: „bis zu …“, Cashback, Newsletter/Neukunden/Club/App, Versand, nur für bestimmte Marken/Kategorien. */
export function isGeneralPromo(title: string): boolean {
  if (!/(\d+(?:[.,]\d+)?)\s*(?:%|€|euro)/i.test(title)) return false;
  if (/bis zu|cashback|newsletter|neukunde|erstbestellung|erste bestellung|registrier|club|\bapp\b|mitglied|student|versand|payback|punkte|gewinn|rezension|bewertung|sammle|outlet|refurbished|trade-?in|eintausch|altgerät/i.test(title)) return false;
  // „… im LG TV Set“, „… für Heimkinosysteme“, „… beim Kauf von …“ → nur für bestimmte Produkte
  if (/\b(?:für|im|beim|zum kauf|auf ausgewählte)\s+(?!(?:alles|den einkauf|deinen einkauf|die bestellung|deine bestellung)\b)[A-ZÄÖÜa-zäöü]/.test(title.replace(/\bzum singles ?days?\b/i, ''))) return false;
  // „auf …“ nur, wenn der ganze Einkauf gemeint ist
  const auf = title.match(/\bauf\s+(.{0,40})/i);
  if (auf && !/^(?:alles|alle artikel|fast alles|nahezu alles|das (?:gesamte |komplette )?(?:[\w-]+-)?sortiment|(?:deine|ihre|die|den) (?:gesamte[n]? )?(?:bestellung|einkäufe|einkauf|warenkorb))/i.test(auf[1])) return false;
  return true;
}

export function parseVoucherPage(html: string): ShopVoucher[] {
  const $ = loadHtml(html);
  const list = $('[data-testid="offer-card-list-container"]').first();
  const out: ShopVoucher[] = [];
  list.find('h3').each((_, h) => {
    const title = $(h).text().replace(/\s+/g, ' ').trim();
    if (!title) return;
    if (/abgelaufen/i.test(title)) return false;   // ab hier nur noch abgelaufene Gutscheine
    // Karte = größter Vorfahr, der nur diese eine Überschrift enthält (vorher lief es bis zur ganzen Liste hoch)
    let card = $(h);
    for (let i = 0; i < 8 && card.parent().length && !card.parent().is(list) && card.parent().find('h3').length === 1; i++) card = card.parent();
    const text = card.text().replace(/\s+/g, ' ');
    const cb = title.match(/(\d+(?:,\d+)?)\s*%\s*Cashback auf Deine Einkäufe/i);
    const pct = title.match(/(\d+(?:,\d+)?)\s*%/);
    const eur = title.match(/(\d+(?:[.,]\d+)?)\s*€/);
    out.push({
      title, code: /Code anzeigen|Gutscheincode/i.test(text + title),
      value: pct ? Number(pct[1].replace(',', '.')) : eur ? parsePrice(eur[1]) : null,
      valueType: pct ? 'percent' : eur ? 'eur' : null,
      cashbackPercent: cb ? Number(cb[1].replace(',', '.')) : null,
      minOrder: minOrderOf(title) ?? minOrderOf(text),
      general: isGeneralPromo(title),
    });
  });
  return out;
}

export async function runVouchers(force = false) {
  const sql = await db();
  // alle 8 Std. – Aktionstage (Singles Day, Black Friday) gelten oft nur einen Tag
  const last = await sql`select max(last_seen_at) as t from kb_shop_vouchers where source = 'mydealz'`;
  if (!force && last[0]?.t && Date.now() - new Date(last[0].t).getTime() < 8 * 3600_000) return { skipped: true };
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
          await sql`insert into kb_shop_vouchers (shop, source, external_id, title, code, value, value_type, min_order, conditions, url, last_seen_at, expired)
                    values (${n}, 'mydealz', ${id}, ${v.title.slice(0, 300)}, ${null}, ${v.value}, ${v.valueType}, ${v.minOrder}, ${v.general ? 'allgemein' : null}, ${p.url}, now(), false)
                    on conflict (source, external_id) do update set last_seen_at = now(), expired = false, shop = excluded.shop,
                      min_order = excluded.min_order, conditions = excluded.conditions, value = excluded.value, value_type = excluded.value_type`;
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
    // Aktionen, die als Deal gepostet werden („15 € auf das gesamte Sortiment ab 200 € MBW“, „11 % Direktabzug“)
    try {
      const p = await fetchPage(`https://www.mydealz.de/search?q=${encodeURIComponent(n)}`, { minDelayMs: 4000, retries: 0 });
      pages++;
      const threads = parsePepperList(p.text, { key: 'mydealz', label: 'mydealz', host: 'www.mydealz.de', country: 'DE' });
      for (const t of threads) {
        if (t.expired || !t.postedAt || Date.now() - t.postedAt.getTime() > 7 * 86400_000) continue;
        if (normShop(t.merchant ?? '') !== n) continue;
        if (!/gutschein|rabatt|direktabzug|aktion|%\s*(?:auf|extra)|€\s*ab|mbw|sortiment|warenkorb/i.test(t.title)) continue;
        if (!isGeneralPromo(t.title)) continue;
        const pct = t.title.match(/(\d+(?:,\d+)?)\s*%/);
        const eur = t.title.match(/(\d+(?:[.,]\d+)?)\s*(?:€|-?Euro)/i);
        await sql`insert into kb_shop_vouchers (shop, source, external_id, title, value, value_type, min_order, conditions, url, last_seen_at, expired)
                  values (${n}, 'mydealz-deal', ${t.externalId}, ${t.title.slice(0, 300)}, ${pct ? Number(pct[1].replace(',', '.')) : eur ? parsePrice(eur[1]) : null},
                          ${pct ? 'percent' : 'eur'}, ${minOrderOf(t.title)}, 'allgemein', ${t.url}, now(), false)
                  on conflict (source, external_id) do update set last_seen_at = now(), expired = false`;
        found++;
      }
      await sql`update kb_shop_vouchers set expired = true where source = 'mydealz-deal' and shop = ${n} and last_seen_at < now() - interval '1 hour'`;
    } catch { /* Suche ist nur Zusatz */ }
  }
  return { shops: shops.length, pages, found };
}
