// Shops mit eigener Suche: pro Shop nur eine kleine Konfiguration (Such-Adresse + wie die Treffer ausgelesen werden).
// Gefundene Produktseiten werden danach wie jede Shopseite über die eingebetteten Produktdaten (schema.org) abgefragt.
import { fetchPage } from '../util/http.ts';
import { jsonLdNodes, loadHtml, embeddedJson, deepFind, absUrl, extractProduct } from '../util/extract.ts';
import { matchTitle, searchQuery, type ProductQuery } from '../util/match.ts';
import { parsePrice } from '../util/money.ts';
import { cleanText, conditionFromTitle } from './common.ts';
import { parseShopPage } from './shops.ts';
import type { Candidate, Condition, ListingRef, OfferData, SourceAdapter } from './types.ts';

export interface SearchHit { title: string; url: string; price?: number | null; externalId?: string; condition?: Condition }

export interface SearchShopConfig {
  key: string;                 // Quellen-Kennung (kb_listings.source)
  label: string;               // Anzeigename des Shops
  base: string;                // https://www.shop.de
  country: string;             // Land des Shops
  kind?: 'shop' | 'refurb' | 'marketplace';
  searchUrl: (term: string) => string;
  /** Eigene Auswertung der Suchseite; ohne: JSON-LD (ItemList/Product) und dann Links nach productLink */
  parseSearch?: (html: string, base: string) => SearchHit[];
  /** Muster für Produkt-Links in der Trefferliste (Rückfall) */
  productLink?: RegExp;
  /** Eigene Auswertung der Produktseite; ohne: schema.org-Produktdaten */
  parseProduct?: (html: string, url: string) => OfferData | null;
  shipping?: number;           // pauschale Versandkosten, falls die Seite keine nennt
  needsHome?: boolean;
  minDelayMs?: number;
  /** Suchbegriff anpassen (z. B. nur Modellnummer) */
  term?: (q: ProductQuery) => string;
}

/** Treffer aus JSON-LD (ItemList mit Produkten oder einzelne Product-Knoten) */
export function hitsFromJsonLd(html: string, base: string): SearchHit[] {
  const out: SearchHit[] = [];
  const push = (p: any) => {
    const url = absUrl(p?.url ?? p?.offers?.url ?? p?.['@id'], base);
    const title = cleanText(p?.name);
    if (!url || !title) return;
    const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
    const price = parsePrice(offer?.price ?? offer?.lowPrice);
    out.push({ title, url, price: price ?? null });
  };
  for (const n of jsonLdNodes(html)) {
    if (n['@type'] === 'ItemList' || Array.isArray(n.itemListElement)) {
      for (const it of n.itemListElement ?? []) push(it.item ?? it);
    } else if (n['@type'] === 'Product') push(n);
  }
  return out;
}

/** Treffer aus Links, deren Adresse wie eine Produktseite aussieht (Titel aus Linktext/title-Attribut) */
export function hitsFromLinks(html: string, base: string, re: RegExp): SearchHit[] {
  const $ = loadHtml(html);
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href')!;
    if (!re.test(href)) return;
    const url = absUrl(href, base)?.split('#')[0];
    if (!url || seen.has(url)) return;
    const title = cleanText($(a).attr('title') || $(a).attr('aria-label') || $(a).text());
    if (title.length < 8) return;
    seen.add(url);
    out.push({ title, url });
  });
  return out;
}

/** Treffer aus eingebettetem Zustands-JSON: alle Objekte mit Name + Link (+ Preis) */
export function hitsFromState(html: string, base: string, marker: string, keys: { name: string; url: string; price?: string }): SearchHit[] {
  const state = embeddedJson(html, marker);
  if (!state) return [];
  const objs = deepFind(state, (o) => typeof o?.[keys.name] === 'string' && typeof o?.[keys.url] === 'string');
  return objs.map((o) => ({
    title: cleanText(o[keys.name]), url: absUrl(o[keys.url], base) ?? '',
    price: keys.price ? parsePrice(String(deepGet(o, keys.price) ?? '')) ?? null : null,
  })).filter((h) => h.url && h.title);
}

function deepGet(o: any, path: string): any {
  return path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
}

export function makeSearchShop(cfg: SearchShopConfig): SourceAdapter {
  const delay = cfg.minDelayMs ?? 4000;
  return {
    key: cfg.key, label: cfg.label, kind: cfg.kind ?? 'shop', countries: [cfg.country], minDelayMs: delay, needsHome: cfg.needsHome,
    async search(q: ProductQuery): Promise<Candidate[]> {
      const term = cfg.term ? cfg.term(q) : searchQuery(q);
      const p = await fetchPage(cfg.searchUrl(term), { country: cfg.country, minDelayMs: delay });
      let hits = cfg.parseSearch ? cfg.parseSearch(p.text, cfg.base) : hitsFromJsonLd(p.text, cfg.base);
      if (!hits.length && cfg.productLink) hits = hitsFromLinks(p.text, cfg.base, cfg.productLink);
      // Suche leitet manchmal direkt auf die Produktseite weiter
      if (!hits.length) {
        const info = extractProduct(p.text);
        if (info?.title && info.price) hits = [{ title: info.title, url: p.url, price: info.price }];
      }
      const seen = new Set<string>();
      return hits.filter((h) => !seen.has(h.url) && seen.add(h.url)).slice(0, 30).map((h) => {
        const r = matchTitle(q, h.title);
        return {
          externalId: h.externalId ?? new URL(h.url).pathname.replace(/\/$/, '').slice(-120),
          url: h.url, title: h.title, country: cfg.country, price: h.price ?? null,
          condition: h.condition ?? (cfg.kind === 'refurb' ? 'refurbished' : conditionFromTitle(h.title)),
          score: r.score, reason: r.reason,
        };
      });
    },
    async fetch(l: ListingRef): Promise<OfferData[]> {
      const p = await fetchPage(l.url, { country: cfg.country, minDelayMs: delay });
      const o = cfg.parseProduct ? cfg.parseProduct(p.text, p.url) : parseShopPage(p.text, p.url);
      if (!o) throw new Error('kein Preis auf der Seite gefunden');
      o.shop = cfg.label;
      o.country = cfg.country;
      o.offerKey = 'page';
      if (o.shipping == null && cfg.shipping != null) o.shipping = cfg.shipping;
      if (l.condition !== 'new' && o.condition === 'new') o.condition = l.condition;
      return [o];
    },
  };
}
