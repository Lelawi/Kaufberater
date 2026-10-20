// refurbed.de: geprüfte Refurbished-Geräte (Handys, Tablets, Laptops …) mit Garantie
import { fetchPage } from '../util/http.ts';
import { jsonLdNodes, loadHtml } from '../util/extract.ts';
import { matchTitle, type ProductQuery } from '../util/match.ts';
import { parsePrice } from '../util/money.ts';
import type { Candidate, ListingRef, OfferData, SourceAdapter } from './types.ts';

const BASE = 'https://www.refurbed.de';

export function parseRefurbedSearch(html: string, q: ProductQuery): Candidate[] {
  const $ = loadHtml(html);
  const out: Candidate[] = [];
  $('a[href^="/p/"]').each((_, a) => {
    const href = ($(a).attr('href') ?? '').split('?')[0];
    const m = href.match(/^\/p\/([a-z0-9-]+)\/$/);   // Produktgruppe (ohne Varianten-Kennung)
    if (!m || out.some((c) => c.externalId === m[1])) return;
    const title = m[1].replace(/-/g, ' ');
    // Speicher/Farbe stehen erst in den Varianten → hier nur Modell vergleichen
    const r = matchTitle({ ...q, brand: null, name: q.name.replace(/\b\d{2,4}\s*(GB|TB)\b/gi, '').trim() }, title);
    out.push({ externalId: m[1], url: BASE + href, title, country: 'DE', condition: 'refurbished', score: r.score, reason: r.reason });
  });
  return out;
}

export function parseRefurbedProduct(html: string, q: ProductQuery): OfferData[] {
  const out: OfferData[] = [];
  for (const n of jsonLdNodes(html)) {
    const variants = n['@type'] === 'ProductGroup' ? (n.hasVariant ?? []) : [];
    for (const v of variants) {
      const o = v.offers; if (!o) continue;
      if (/OutOfStock|SoldOut/i.test(String(o.availability ?? ''))) continue;
      const price = parsePrice(o.price);
      if (!price) continue;
      if (matchTitle({ ...q, brand: null }, String(v.name ?? '')).score < 0.75) continue;   // falsche Speichergröße o. Ä.
      out.push({
        offerKey: `v:${v.sku}`, shop: 'refurbed', country: 'DE', condition: 'refurbished', title: v.name,
        url: o.url ?? BASE, price, shipping: 0, inStock: true, deliveryText: 'Refurbished, mit Garantie',
      });
    }
  }
  return out;
}

export const refurbedAdapter: SourceAdapter = {
  key: 'refurbed', label: 'refurbed', kind: 'refurb', countries: ['DE'], minDelayMs: 3000,
  async search(q) {
    const p = await fetchPage(`${BASE}/search/?query=${encodeURIComponent(q.name)}`, { minDelayMs: 3000 });
    return parseRefurbedSearch(p.text, q);
  },
  async fetch(l: ListingRef, q) {
    const p = await fetchPage(l.url, { minDelayMs: 3000 });
    return parseRefurbedProduct(p.text, q);
  },
};
