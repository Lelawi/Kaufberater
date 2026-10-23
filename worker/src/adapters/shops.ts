// Allgemeiner Shop-Abruf: jede Produktseite, die standardisierte Produktdaten (schema.org) einbettet – das sind die
// meisten Shops. Für Shops mit Besonderheiten gibt es kleine Zusatzregeln (Preis-Selektor usw.).
import { fetchPage } from '../util/http.ts';
import { extractProduct, loadHtml } from '../util/extract.ts';
import { rememberImage } from '../util/history.ts';
import { parsePrice } from '../util/money.ts';
import { hostOf } from '../util/shop.ts';
import { cleanText, conditionFromTitle } from './common.ts';
import type { ListingRef, OfferData, SourceAdapter } from './types.ts';

interface ShopRule {
  name: string;
  country: string;
  price?: string;          // CSS-Selektor für den Preis, falls Produktdaten fehlen
  title?: string;
  outOfStock?: RegExp;
  shipping?: number;       // pauschale Versandkosten, falls bekannt
  needsHome?: boolean;     // blockt Rechenzentren
  browser?: boolean;       // braucht echten Browser
}

/** Bekannte Shops. Unbekannte Shops funktionieren trotzdem über die Produktdaten. */
export const SHOP_RULES: Record<string, ShopRule> = {
  'expert.de': { name: 'expert', country: 'DE', price: '.exp_price, .display-price-label', outOfStock: /nicht verfügbar|ausverkauft/i },
  'galaxus.de': { name: 'Galaxus', country: 'DE' },
  'alternate.de': { name: 'Alternate', country: 'DE', price: '.price, #price-wrapper .price' },
  'coolblue.de': { name: 'Coolblue', country: 'DE' },
  'lg.com': { name: 'LG Shop', country: 'DE' },
  'samsung.com': { name: 'Samsung Shop', country: 'DE' },
  'apple.com': { name: 'Apple Store', country: 'DE' },
  'refurbed.de': { name: 'refurbed', country: 'DE' },
  'mediamarkt.de': { name: 'MediaMarkt', country: 'DE', needsHome: true },
  'saturn.de': { name: 'Saturn', country: 'DE', needsHome: true },
  'otto.de': { name: 'Otto', country: 'DE', needsHome: true },
  'cyberport.de': { name: 'Cyberport', country: 'DE', needsHome: true },
  'notebooksbilliger.de': { name: 'notebooksbilliger', country: 'DE', needsHome: true },
  'kaufland.de': { name: 'Kaufland', country: 'DE', needsHome: true },
  'euronics.de': { name: 'Euronics', country: 'DE', needsHome: true },
  'conrad.de': { name: 'Conrad', country: 'DE', needsHome: true },
  'proshop.de': { name: 'Proshop', country: 'DE', needsHome: true },
  'computeruniverse.net': { name: 'computeruniverse', country: 'DE', needsHome: true },
  'alza.de': { name: 'Alza', country: 'DE', needsHome: true },
  'backmarket.de': { name: 'Back Market', country: 'DE', needsHome: true },
  'ebay.de': { name: 'eBay', country: 'DE', needsHome: true, price: '.x-price-primary span' },
  'ldlc.com': { name: 'LDLC', country: 'FR' },
  'pccomponentes.com': { name: 'PcComponentes', country: 'ES' },
};

export function ruleFor(url: string): ShopRule | undefined {
  const host = hostOf(url);
  const key = Object.keys(SHOP_RULES).find((k) => host === k || host.endsWith('.' + k));
  return key ? SHOP_RULES[key] : undefined;
}

export function needsHomeUrl(url: string): boolean {
  return !!ruleFor(url)?.needsHome || /amazon\.|geizhals\.|^amzn\.|^a\.co$/.test(hostOf(url));
}

export function parseShopPage(html: string, url: string): OfferData | null {
  const rule = ruleFor(url);
  const info = extractProduct(html);
  let price = info?.price ?? null;
  const $ = loadHtml(html);
  if (!price && rule?.price) price = parsePrice($(rule.price).first().text());
  if (!price) return null;
  const title = cleanText(info?.title ?? (rule?.title ? $(rule.title).first().text() : $('h1').first().text()));
  let inStock = info?.inStock ?? null;
  if (rule?.outOfStock && rule.outOfStock.test($('body').text().slice(0, 300_000))) inStock = inStock ?? false;
  const host = hostOf(url);
  return {
    offerKey: 'page',
    shop: rule?.name ?? host,
    country: rule?.country ?? (host.match(/\.(fr|it|es|nl|at|be|pl)$/)?.[1]?.toUpperCase() ?? 'DE'),
    condition: info?.condition && info.condition !== 'new' ? info.condition : conditionFromTitle(title),
    title, url,
    price,
    shipping: info?.shipping ?? rule?.shipping ?? null,
    listPrice: info?.listPrice ?? null,
    inStock,
    seller: info?.seller,
  };
}

export const shopAdapter: SourceAdapter = {
  key: 'shop', label: 'Shop direkt', kind: 'shop', countries: ['DE', 'AT', 'FR', 'IT', 'ES', 'NL'], minDelayMs: 4000,
  async fetch(l: ListingRef) {
    const rule = ruleFor(l.url);
    let html: string; let finalUrl = l.url;
    if (rule?.browser) {
      const { browse } = await import('../util/browser.ts');
      const p = await browse(l.url, { country: l.country });
      html = p.html; finalUrl = p.url;
    } else {
      const p = await fetchPage(l.url, { country: l.country, minDelayMs: 4000 });
      html = p.text; finalUrl = p.url;
    }
    rememberImage(l.url, html);
    const o = parseShopPage(html, finalUrl);
    if (!o) throw new Error('kein Preis auf der Seite gefunden');
    if (l.condition !== 'new' && o.condition === 'new') o.condition = l.condition;
    return [o];
  },
};

export const sources: SourceAdapter[] = [shopAdapter];
