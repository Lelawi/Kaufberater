// Amazon DE/FR/IT/ES/NL/BE. Blockt Rechenzentren → läuft nur auf dem Heim-Rechner.
// Ausländische Amazon-Shops liefern fast alles nach Deutschland (Versandkosten werden mitgelesen).
import { fetchPage, setCookie } from '../util/http.ts';
import { loadHtml } from '../util/extract.ts';
import { matchTitle, searchQuery, type ProductQuery } from '../util/match.ts';
import { parsePrice } from '../util/money.ts';
import { cleanText, conditionFromTitle } from './common.ts';
import type { Candidate, ListingRef, OfferData, SourceAdapter } from './types.ts';

const MARKETS: Record<string, string> = { DE: 'amazon.de', FR: 'amazon.fr', IT: 'amazon.it', ES: 'amazon.es', NL: 'amazon.nl', BE: 'amazon.com.be' };

function prepare(country: string) {
  const host = `www.${MARKETS[country]}`;
  // Lieferadresse Deutschland (München) und Währung Euro voreinstellen
  setCookie(host, 'i18n-prefs', 'EUR');
  if (country === 'DE') setCookie(host, 'lc-acbde', 'de_DE');
}

export function parseAmazonSearch(html: string, q: ProductQuery, country: string): Candidate[] {
  const $ = loadHtml(html);
  const out: Candidate[] = [];
  $('div[data-asin][data-component-type="s-search-result"]').each((_, el) => {
    const asin = $(el).attr('data-asin');
    if (!asin) return;
    if ($(el).find('.puis-sponsored-label-text, [aria-label*="Gesponsert"], [aria-label*="Sponsorisé"]').length) return;
    const title = cleanText($(el).find('h2').first().text());
    const price = parsePrice($(el).find('.a-price .a-offscreen').first().text());
    const r = matchTitle(q, title);
    out.push({ externalId: asin, url: `https://www.${MARKETS[country]}/dp/${asin}`, title, country, price, score: r.score, reason: r.reason });
  });
  return out;
}

export function parseAmazonProduct(html: string, url: string, country: string): OfferData[] {
  const $ = loadHtml(html);
  const title = cleanText($('#productTitle').text());
  const priceText = $('#corePrice_feature_div .a-price .a-offscreen').first().text() ||
    $('#corePriceDisplay_desktop_feature_div .a-price .a-offscreen').first().text() ||
    $('#apex_desktop .a-price .a-offscreen').first().text() ||
    $('#price_inside_buybox').first().text() || $('#priceblock_ourprice, #priceblock_dealprice').first().text();
  const price = parsePrice(priceText);
  const out: OfferData[] = [];
  const avail = cleanText($('#availability').text());
  const inStock = avail ? !/derzeit nicht verfügbar|nicht auf lager|actuellement indisponible|non disponibile|no disponible/i.test(avail) : null;
  if (price) {
    const seller = cleanText($('#sellerProfileTriggerId').text()) || cleanText($('#merchantInfoFeature_feature_div .offer-display-feature-text').text()) || 'Amazon';
    const deliveryBlock = cleanText($('#mir-layout-DELIVERY_BLOCK, #deliveryBlockMessage').first().text());
    let shipping: number | null = null;
    if (/kostenlos|gratuit|gratuita|gratis|free/i.test(deliveryBlock)) shipping = 0;
    else {
      const m = deliveryBlock.match(/([\d.,]+)\s*€/);
      if (m) shipping = parsePrice(m[1]);
    }
    const list = parsePrice($('.basisPrice .a-offscreen, [data-a-strike="true"] .a-offscreen').first().text());
    out.push({
      offerKey: 'buybox', shop: `Amazon.${country.toLowerCase() === 'de' ? 'de' : MARKETS[country].split('.').slice(1).join('.')}`,
      country, condition: 'new', title, url, price, shipping, listPrice: list, inStock: inStock ?? true,
      seller, deliveryText: deliveryBlock.slice(0, 120),
    });
  }
  // Amazon Warehouse / gebraucht: "Gebraucht - Wie neu ab X €"
  const usedText = cleanText($('#usedAccordionRow, #used_buybox_desktop, [id*="usedBuySection"]').first().text());
  const usedPrice = parsePrice(usedText.match(/([\d.,]+)\s*€/)?.[1]);
  if (usedPrice) {
    out.push({ offerKey: 'used', shop: `Amazon.${MARKETS[country].split('.').slice(1).join('.')} (gebraucht/Warehouse)`, country, condition: conditionFromTitle(usedText) === 'new' ? 'used' : conditionFromTitle(usedText), title, url, price: usedPrice, inStock: true });
  }
  return out;
}

function make(country: string): SourceAdapter {
  return {
    key: country === 'DE' ? 'amazon' : `amazon_${country.toLowerCase()}`,
    label: MARKETS[country], kind: 'shop', countries: [country], minDelayMs: 6000, needsHome: true,
    async search(q) {
      prepare(country);
      const p = await fetchPage(`https://www.${MARKETS[country]}/s?k=${encodeURIComponent(searchQuery(q))}`, { country, minDelayMs: 6000 });
      return parseAmazonSearch(p.text, q, country);
    },
    async fetch(l: ListingRef) {
      prepare(country);
      const p = await fetchPage(`https://www.${MARKETS[country]}/dp/${l.external_id}?th=1&psc=1`, { country, minDelayMs: 6000 });
      const offers = parseAmazonProduct(p.text, `https://www.${MARKETS[country]}/dp/${l.external_id}`, country);
      if (!offers.length && /captcha/i.test(p.text)) throw new Error('blockiert (Captcha) bei Amazon');
      return offers;
    },
  };
}

export const amazonAdapters: SourceAdapter[] = ['DE', 'FR', 'IT', 'ES', 'NL'].map(make);
