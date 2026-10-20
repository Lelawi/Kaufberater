// billiger.de: zweiter großer Preisvergleich (andere Händlerauswahl als idealo)
import { fetchPage } from '../util/http.ts';
import { loadHtml, jsonLdNodes } from '../util/extract.ts';
import { matchTitle, searchQuery, type ProductQuery } from '../util/match.ts';
import { parsePrice } from '../util/money.ts';
import { cleanText, conditionFromTitle } from './common.ts';
import type { Candidate, ListingRef, OfferData, SourceAdapter } from './types.ts';

const BASE = 'https://www.billiger.de';

export function parseBilligerSearch(html: string, q: ProductQuery): Candidate[] {
  const $ = loadHtml(html);
  const out: Candidate[] = [];
  $('a[href^="/products/"], a[href^="https://www.billiger.de/products/"]').each((_, a) => {
    const href = $(a).attr('href')!;
    const m = href.match(/\/products\/(\d+)-/);
    if (!m || out.some((c) => c.externalId === m[1])) return;
    const slugTitle = href.split('?')[0].replace(/.*\/products\/\d+-/, '').replace(/-/g, ' ');
    const title = cleanText($(a).attr('title') || $(a).text()) || slugTitle;
    const r = matchTitle(q, `${title} ${slugTitle}`);
    out.push({ externalId: m[1], url: new URL(href, BASE).toString().split('?')[0], title, country: 'DE', score: r.score, reason: r.reason });
  });
  return out;
}

export function parseBilligerOffers(html: string, pageUrl: string): { offers: OfferData[]; gtin?: string } {
  const $ = loadHtml(html);
  const gtin = jsonLdNodes(html).find((n) => n.gtin13)?.gtin13 as string | undefined;
  const out: OfferData[] = [];
  $('[data-offer-row]').each((_, el) => {
    const row = $(el);
    const id = row.attr('data-offer-id');
    const text = cleanText(row.text());
    const shop = cleanText(row.find('[data-open-shop-info]').attr('aria-label')?.replace(/\s*Shop-Infos?$/, '')) ||
      cleanText(row.find('img[alt^="Shop "]').attr('alt')?.replace(/^Shop /, '')) || 'unbekannt';
    // "2.699,00 €* ab 79,90 € Versand 2.778,90 € Gesamt"
    const price = parsePrice(text.match(/([\d.]+,\d{2})\s*€\*/)?.[1]);
    if (!price) return;
    const shipM = text.match(/ab\s*([\d.]+,\d{2})\s*€\s*Versand/);
    const shipping = shipM ? parsePrice(shipM[1]) ?? 0 : null;
    const title = cleanText(row.find('[data-offer-title], h3, .line-clamp-2').first().text()) || text.split(/\d+[.,]\d{2}\s*€/)[0].slice(0, 200);
    const link = row.find('a[href*="/modules/cpc"], a[href*="redirect"], a[data-econda-marker*="ZumAnbieter"], a:contains("Zum Anbieter")').attr('href');
    const delivery = text.match(/Lieferzeit:\s*([^]+?)(?:Abholung|Shop-Info|Zum Anbieter|$)/)?.[1]?.trim();
    out.push({
      offerKey: `o:${row.attr('data-shop-id') ?? shop}`,
      shop, country: 'DE', condition: conditionFromTitle(title), title,
      url: link ? new URL(link, BASE).toString() : pageUrl,
      price, shipping: shipping === 0 && shipM ? 0 : shipping,
      inStock: !/nicht lieferbar|ausverkauft/i.test(text),
      deliveryText: delivery?.slice(0, 120),
      offerId: id,
    } as OfferData);
  });
  return { offers: out, gtin };
}

async function search(q: ProductQuery): Promise<Candidate[]> {
  const p = await fetchPage(`${BASE}/search?searchstring=${encodeURIComponent(searchQuery(q))}`, { minDelayMs: 3000 });
  return parseBilligerSearch(p.text, q);
}

async function fetchOffers(l: ListingRef): Promise<OfferData[]> {
  const p = await fetchPage(l.url, { minDelayMs: 3000 });
  const r = parseBilligerOffers(p.text, p.url);
  if (!r.offers.length) {
    // Rückfall: Angebotsliste aus den Produktdaten (ohne Versand)
    for (const n of jsonLdNodes(p.text)) {
      for (const o of ([] as any[]).concat(n.offers?.offers ?? [])) {
        const price = parsePrice(o.price);
        if (price) r.offers.push({ offerKey: `ld:${o.seller?.name}`, shop: o.seller?.name ?? 'unbekannt', country: 'DE', condition: 'new', url: p.url, price });
      }
    }
  }
  return r.offers;
}

export const billigerAdapter: SourceAdapter = {
  key: 'billiger', label: 'billiger.de', kind: 'aggregator', countries: ['DE'], minDelayMs: 3000,
  search, fetch: fetchOffers,
};
