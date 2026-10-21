// CHECK24 Preisvergleich: von GitHub aus erreichbar und listet auch Händler, die uns direkt sperren
// (Amazon, Galaxus, Kaufland, computeruniverse …). Suche + Produktseite mit allen Angeboten, Versand, Lieferzeit und Preisverlauf.
import { fetchPage } from '../util/http.ts';
import { matchTitle, searchQuery, type ProductQuery } from '../util/match.ts';
import { pageHistory, type HistPoint } from '../util/history.ts';
import { cleanText, conditionFromTitle } from './common.ts';
import type { Candidate, ListingRef, OfferData, SourceAdapter } from './types.ts';

/** JSON-Objekt ab einer Textstelle lesen (zählt Klammern, beachtet Zeichenketten) */
function readJsonAt(s: string, from: number): any | null {
  const start = s.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

export function parseCheck24Search(html: string, q: ProductQuery): Candidate[] {
  const i = html.indexOf('__INIT_C9_SERP_STATE__');
  if (i < 0) return [];
  const resp = readJsonAt(html, html.indexOf('response:', i));
  const items: any[] = resp?.results?.items ?? [];
  return items.filter((it) => it.type === 'product' && it.dispatchable_url && it.title).map((it) => {
    const title = cleanText(it.title);
    const r = matchTitle(q, title);
    return {
      externalId: String(it.id), url: String(it.dispatchable_url).split('?')[0], title, country: 'DE',
      price: typeof it.price?.min === 'number' ? it.price.min : null, condition: conditionFromTitle(title), score: r.score, reason: r.reason,
    };
  });
}

/** Next.js-Datenstrom der Seite (self.__next_f.push) zu einem Text zusammensetzen */
function nextFlight(html: string): string {
  const parts: string[] = [];
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) { try { parts.push(JSON.parse(`"${m[1]}"`)); } catch { /* */ } }
  return parts.join('');
}

export function parseCheck24Product(html: string, pageUrl: string): { offers: OfferData[]; history: HistPoint[]; title?: string } {
  const flight = nextFlight(html);
  const ext = readJsonAt(flight, flight.indexOf('"initialExtended":'));
  const title = cleanText(flight.match(/"productName":"([^"]{5,200})"/)?.[1] ?? html.match(/<h1[^>]*>([^<]{5,200})</)?.[1] ?? '') || undefined;
  const offers: OfferData[] = [];
  for (const o of ext?.offers ?? []) {
    if (typeof o.price !== 'number' || !o.shopName) continue;
    const used = o.usedCondition ? String(o.usedCondition) : '';
    offers.push({
      offerKey: `c24:${o.id}`,
      shop: cleanText(o.shopName),
      country: 'DE',
      condition: !used ? 'new' : /b-ware|ausstellung|neuwertig/i.test(used) ? 'bware' : /refurb|generalüberholt|wie neu|sehr gut|gut/i.test(used) ? 'refurbished' : 'used',
      title,
      url: pageUrl,   // Klick-Adressen sind nur kurz gültig → zur CHECK24-Seite mit allen Händlern
      price: o.price,
      shipping: typeof o.deliveryCosts === 'number' ? o.deliveryCosts : null,
      inStock: true,
      deliveryText: o.deliveryInfo ? `Lieferung ${o.deliveryInfo}` : undefined,
      shopRating: typeof o.shopRating === 'number' ? o.shopRating : null,
      shopReviews: typeof o.shopReviewCount === "number" && o.shopReviewCount > 0 ? o.shopReviewCount : null,
    });
  }
  const history: HistPoint[] = (ext?.priceHistory ?? [])
    .filter((h: any) => /^\d{4}-\d{2}-\d{2}$/.test(h?.date) && typeof h?.price === 'number' && h.price > 0)
    .map((h: any) => ({ date: h.date, price: Math.round(h.price) / 100 }));
  return { offers, history, title };
}

export const check24Adapter: SourceAdapter = {
  key: 'check24', label: 'CHECK24', kind: 'aggregator', countries: ['DE'], minDelayMs: 3500,
  async search(q: ProductQuery) {
    const p = await fetchPage(`https://www.check24.de/suche/?q=${encodeURIComponent(searchQuery(q))}`, { minDelayMs: 3500 });
    return parseCheck24Search(p.text, q);
  },
  async fetch(l: ListingRef) {
    const p = await fetchPage(l.url, { minDelayMs: 3500 });
    const r = parseCheck24Product(p.text, l.url);
    if (r.history.length) pageHistory.set(l.url, r.history);
    return r.offers;
  },
};
