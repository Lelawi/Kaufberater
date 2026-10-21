// idealo.de: Preisvergleich mit hunderten Händlern (inkl. MediaMarkt, Otto, Amazon …), erreichbar aus Rechenzentren
import { debugLog } from '../db.ts';
import { fetchPage } from '../util/http.ts';
import { loadHtml, extractProduct } from '../util/extract.ts';
import { matchTitle, searchQuery, type ProductQuery } from '../util/match.ts';
import { parsePrice } from '../util/money.ts';
import { cleanText, conditionFromTitle } from './common.ts';
import type { Candidate, ListingRef, OfferData, SourceAdapter } from './types.ts';

const BASE = 'https://www.idealo.de';

export function parseIdealoSearch(html: string, q: ProductQuery): Candidate[] {
  const $ = loadHtml(html);
  const out: Candidate[] = [];
  $('a[href*="/preisvergleich/OffersOfProduct/"]').each((_, a) => {
    const href = $(a).attr('href')!;
    const m = href.match(/OffersOfProduct\/(\d+)_/);
    if (!m) return;
    const title = cleanText($(a).find('[class*="productSummary__title"]').text() || $(a).attr('title') || $(a).text());
    if (!title || out.some((c) => c.externalId === m[1])) return;
    const tile = $(a).closest('[class*="resultItemTile"]').first();
    const price = parsePrice(tile.find('[class*="detailedPriceInfo__price"]').first().text());
    const r = matchTitle(q, title);
    out.push({ externalId: m[1], url: new URL(href, BASE).toString().split('?')[0], title, country: 'DE', price, score: r.score, reason: r.reason });
  });
  return out;
}

export function parseIdealoOffers(html: string, pageUrl: string): OfferData[] {
  const $ = loadHtml(html);
  const out: OfferData[] = [];
  $('.productOffers-listItem').each((_, el) => {
    const it = $(el);
    const priceText = it.find('.productOffers-listItemOfferPrice').first().text();
    const price = parsePrice(priceText);
    if (!price) return;
    const shipText = it.find('div.productOffers-listItemOfferShippingDetails').first().text() || it.find('.productOffers-listItemOfferShippingDetails').first().attr('title') || '';
    const totalIncl = /inkl\.?\s*Versand/i.test(shipText) ? parsePrice(shipText) : null;
    const shipping = totalIncl !== null ? Math.max(0, Math.round((totalIncl - price) * 100) / 100) : null;
    let shop = '';
    try {
      const mtrx = JSON.parse(it.attr('data-mtrx-click') ?? '{}');
      shop = mtrx.shop_name ?? '';
    } catch { /* ignorieren */ }
    if (!shop) shop = cleanText(it.find('[data-shop-name]').attr('data-shop-name')?.split(' - ')[0]);
    const title = cleanText(it.find('.productOffers-listItemTitleInner').attr('title') || it.find('.productOffers-listItemTitleInner').text());
    const href = it.find('a.productOffers-listItemTitle').attr('href') ?? it.find('a[href*="relocator"]').attr('href');
    const sid = href?.match(/[?&]sid=(\d+)/)?.[1];
    const offerKey = href?.match(/offerKey=([a-f0-9]+)/)?.[1];
    const delivery = cleanText(it.find('.productOffers-listItemOfferDeliveryStatusDatesRange, .productOffers-listItemOfferDeliveryStatusDates').first().text()) || undefined;
    const marketplace = /marktplatz/i.test(shop);
    const shopRating = parsePrice(it.find('.productOffers-listItemOfferShopV2Stars, .starAndRatingWrapper').first().text());
    const shopReviews = Number(cleanText(it.find('.productOffers-listItemOfferShopV2NORatings--numberOfRatings').first().text()).replace(/\D/g, '')) || null;
    out.push({
      offerKey: sid ? `sid:${sid}${marketplace ? ':' + (offerKey ?? '').slice(0, 8) : ''}` : `key:${offerKey ?? shop}`,
      shop: shop.replace(/\s*\(DE\)\s*$/, '') || 'unbekannt',
      country: /\.(at|it|fr|es|nl|pl|cz|be)\b/.test(shop) ? shop.match(/\.(at|it|fr|es|nl|pl|cz|be)\b/)![1].toUpperCase() : 'DE',
      condition: conditionFromTitle(title),
      title,
      url: href ? new URL(href, pageUrl).toString() : pageUrl,
      price,
      shipping,
      inStock: true,
      deliveryText: delivery,
      shopRating: shopRating && shopRating <= 5 ? shopRating : null,
      shopReviews,
    });
  });
  return out;
}

async function search(q: ProductQuery): Promise<Candidate[]> {
  const terms = new Set([searchQuery(q), ...(q.terms ?? []).slice(0, 3)]);
  const all: Candidate[] = [];
  for (const t of terms) {
    const p = await fetchPage(`${BASE}/preisvergleich/MainSearchProductCategory.html?q=${encodeURIComponent(t)}`, { minDelayMs: 3000 });
    for (const c of parseIdealoSearch(p.text, q)) if (!all.some((x) => x.externalId === c.externalId)) all.push(c);
  }
  return all;
}

async function fetchOffers(l: ListingRef): Promise<OfferData[]> {
  const p = await fetchPage(l.url, { minDelayMs: 3000 });
  const offers = parseIdealoOffers(p.text, p.url);
  if (!offers.length) {
    // Zur Fehlersuche festhalten, wie die leere Seite aussah (idealo liefert gelegentlich Seiten ohne Angebotsliste)
    const title = p.text.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim() ?? '';
    await debugLog('idealo-leer', { url: l.url, finalUrl: p.url, body: p.text.slice(0, 300_000),
      note: JSON.stringify({ bytes: p.text.length, title, hasList: /productOffers-list/.test(p.text), captcha: /captcha|challenge|robot/i.test(p.text) }) });
    // Produkt ohne Angebote oder Seitenaufbau geändert → Bestpreis aus Produktdaten
    const info = extractProduct(p.text);
    if (info?.price) {
      offers.push({ offerKey: 'best', shop: 'idealo (Bestpreis)', country: 'DE', condition: 'new', title: info.title, url: p.url, price: info.price, inStock: info.inStock ?? true });
    }
  }
  return offers;
}

export const idealoAdapter: SourceAdapter = {
  key: 'idealo', label: 'idealo.de', kind: 'aggregator', countries: ['DE'], minDelayMs: 3000,
  search, fetch: fetchOffers,
};
