// Geizhals (DE + EU-Ansicht): sehr viele Händler, eigene Preisverläufe. Blockt Rechenzentren → Heim-Rechner.
import { fetchPage } from '../util/http.ts';
import { loadHtml } from '../util/extract.ts';
import { matchTitle, searchQuery, type ProductQuery } from '../util/match.ts';
import { parsePrice } from '../util/money.ts';
import { cleanText, conditionFromTitle } from './common.ts';
import type { Candidate, ListingRef, OfferData, SourceAdapter } from './types.ts';

// hloc = Händlerstandorte; Lieferung nach DE wird über die DE-Ansicht sichergestellt
const LOC = '&hloc=de&hloc=at&hloc=eu';

export function parseGeizhalsSearch(html: string, q: ProductQuery): Candidate[] {
  const $ = loadHtml(html);
  const out: Candidate[] = [];
  $('a[href*="-a"][href$=".html"], a.listview__name-link, a.productlist__link').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const m = href.match(/-a(\d{5,9})\.html/);
    if (!m || out.some((c) => c.externalId === m[1])) return;
    const title = cleanText($(a).text() || $(a).attr('title'));
    if (title.length < 4) return;
    const r = matchTitle(q, title);
    out.push({ externalId: m[1], url: new URL(href, 'https://geizhals.de/').toString().split('?')[0], title, country: 'DE', score: r.score, reason: r.reason });
  });
  return out;
}

export function parseGeizhalsOffers(html: string, pageUrl: string): OfferData[] {
  const $ = loadHtml(html);
  const out: OfferData[] = [];
  $('#offer__list .offer, .offerlist .offer, [id^="offer__"]').each((_, el) => {
    const row = $(el);
    const price = parsePrice(row.find('.offer__price .gh_price, .gh_price').first().text());
    if (!price) return;
    const shop = cleanText(row.find('.merchant__logo-caption, .offer__merchant a, .merchant__name').first().text()) ||
      cleanText(row.find('img[alt]').first().attr('alt')) || 'unbekannt';
    const shipText = cleanText(row.find('.offer__delivery-costs, .versand, [class*="shipping"]').first().text());
    let shipping: number | null = null;
    if (/frei|kostenlos/i.test(shipText)) shipping = 0; else { const m = shipText.match(/([\d.,]+)/); if (m) shipping = parsePrice(m[1]); }
    const title = cleanText(row.find('.offer__name, .offer__title, .notrans').first().text());
    const link = row.find('a.offer__link, a[href*="redir"], a[href*="/redir/"]').first().attr('href');
    const avail = cleanText(row.find('.offer__availability, .delivery__text, [class*="avail"]').first().text());
    const id = row.attr('id') ?? row.attr('data-offer-id') ?? shop;
    out.push({
      offerKey: `gh:${id}`, shop, country: /\(AT\)|\.at\b/i.test(shop) ? 'AT' : 'DE', condition: conditionFromTitle(title), title,
      url: link ? new URL(link, pageUrl).toString() : pageUrl, price, shipping,
      inStock: avail ? !/nicht lieferbar|nicht verfügbar/i.test(avail) : true, deliveryText: avail.slice(0, 120),
    });
  });
  return out;
}

export const geizhalsAdapters: SourceAdapter[] = [{
  key: 'geizhals', label: 'Geizhals', kind: 'aggregator', countries: ['DE', 'AT', 'EU'], minDelayMs: 5000, needsHome: true,
  async search(q) {
    const p = await fetchPage(`https://geizhals.de/?fs=${encodeURIComponent(searchQuery(q))}${LOC}`, { minDelayMs: 5000 });
    return parseGeizhalsSearch(p.text, q);
  },
  async fetch(l: ListingRef) {
    const p = await fetchPage(`${l.url}?${LOC.slice(1)}`, { minDelayMs: 5000 });
    return parseGeizhalsOffers(p.text, p.url);
  },
}];
