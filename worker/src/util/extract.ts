// Produktdaten aus Shopseiten lesen – über die standardisierten Produktdaten (schema.org JSON-LD),
// die fast alle Shops für Google einbetten. Damit funktioniert ein Großteil der Shops ohne Spezialcode.
import * as cheerio from 'cheerio';
import { parsePrice } from './money.ts';

export interface ProductInfo {
  title?: string;
  brand?: string;
  gtin?: string;
  mpn?: string;
  sku?: string;
  price?: number | null;
  listPrice?: number | null;
  currency?: string;
  inStock?: boolean | null;
  condition?: 'new' | 'refurbished' | 'used' | 'bware';
  seller?: string;
  shipping?: number | null;
  image?: string;
  url?: string;
}

export function loadHtml(html: string) { return cheerio.load(html); }

/** Alle JSON-LD-Blöcke einer Seite, flach (inkl. @graph) */
export function jsonLdNodes(html: string): any[] {
  const $ = cheerio.load(html);
  const out: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    for (const candidate of [raw, raw.replace(/[\u0000-\u001f]+/g, ' ')]) {
      try {
        const data = JSON.parse(candidate);
        flatten(data, out);
        break;
      } catch { /* nächster Versuch */ }
    }
  });
  return out;
}

function flatten(d: any, out: any[]) {
  if (!d) return;
  if (Array.isArray(d)) { d.forEach((x) => flatten(x, out)); return; }
  if (typeof d !== 'object') return;
  out.push(d);
  if (d['@graph']) flatten(d['@graph'], out);
  if (d.mainEntity) flatten(d.mainEntity, out);
  if (d.hasVariant) flatten(d.hasVariant, out);
}

function isType(n: any, t: string): boolean {
  const ty = n?.['@type'];
  return Array.isArray(ty) ? ty.includes(t) : ty === t;
}

function str(v: any): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return str(v.name ?? v['@value'] ?? v.value);
  return undefined;
}

export function conditionFrom(v: any): ProductInfo['condition'] | undefined {
  const s = String(v ?? '').toLowerCase();
  if (!s) return undefined;
  if (s.includes('refurb')) return 'refurbished';
  if (s.includes('used') || s.includes('gebraucht')) return 'used';
  if (s.includes('damaged')) return 'bware';
  if (s.includes('new') || s.includes('neu')) return 'new';
  return undefined;
}

export function availabilityFrom(v: any): boolean | null {
  const s = String(v ?? '').toLowerCase();
  if (!s) return null;
  if (/instock|limitedavailability|onlineonly|instoreonly|presale|preorder|backorder/.test(s)) {
    return !/backorder|preorder|presale/.test(s) ? true : true;
  }
  if (/outofstock|soldout|discontinued/.test(s)) return false;
  return null;
}

/** Bestes Produkt aus JSON-LD (bei mehreren: das mit Preis) */
export function productFromJsonLd(html: string): ProductInfo | null {
  const nodes = jsonLdNodes(html);
  const products = nodes.filter((n) => isType(n, 'Product') || isType(n, 'ProductGroup') || (n.offers && n.name));
  let best: ProductInfo | null = null;
  for (const p of products) {
    const info: ProductInfo = {
      title: str(p.name),
      brand: str(p.brand),
      gtin: str(p.gtin13 ?? p.gtin ?? p.gtin14 ?? p.gtin12 ?? p.gtin8 ?? p.ean),
      mpn: str(p.mpn),
      sku: str(p.sku),
      image: str(Array.isArray(p.image) ? p.image[0] : p.image?.url ?? p.image),
      condition: conditionFrom(p.itemCondition),
    };
    const offers = ([] as any[]).concat(p.offers ?? []);
    let price: number | null = null;
    for (const o of offers) {
      const sub = ([] as any[]).concat(o.offers ?? o);
      for (const so of sub) {
        const pr = parsePrice(so.price ?? so.lowPrice ?? so.priceSpecification?.price ?? (Array.isArray(so.priceSpecification) ? so.priceSpecification[0]?.price : undefined));
        if (pr && (price === null || pr < price)) {
          price = pr;
          info.currency = str(so.priceCurrency ?? so.priceSpecification?.priceCurrency) ?? 'EUR';
          info.inStock = availabilityFrom(so.availability);
          info.seller = str(so.seller);
          info.condition = conditionFrom(so.itemCondition) ?? info.condition;
          const ship = so.shippingDetails ? ([] as any[]).concat(so.shippingDetails)[0] : null;
          const sv = ship?.shippingRate?.value ?? ship?.shippingRate?.price;
          info.shipping = sv !== undefined ? (Number(sv) === 0 ? 0 : parsePrice(sv)) : null;
          const lp = ([] as any[]).concat(so.priceSpecification ?? []).find((ps: any) => /ListPrice|StrikethroughPrice|MSRP/i.test(String(ps.priceType ?? '')));
          if (lp) info.listPrice = parsePrice(lp.price);
          info.url = str(so.url);
        }
      }
    }
    info.price = price;
    if (!best || (info.price && !best.price)) best = info;
  }
  return best;
}

/** Einfache Meta-Tags (og:title, product:price:amount) als Rückfall */
export function productFromMeta(html: string): ProductInfo {
  const $ = cheerio.load(html);
  const meta = (k: string) => $(`meta[property="${k}"]`).attr('content') ?? $(`meta[name="${k}"]`).attr('content');
  return {
    title: meta('og:title') ?? ($('h1').first().text().trim() || undefined),
    price: parsePrice(meta('product:price:amount') ?? meta('og:price:amount') ?? $('[itemprop="price"]').first().attr('content') ?? $('[itemprop="price"]').first().text()),
    currency: meta('product:price:currency') ?? 'EUR',
    image: meta('og:image'),
    inStock: availabilityFrom(meta('product:availability') ?? $('[itemprop="availability"]').first().attr('href') ?? $('[itemprop="availability"]').first().attr('content')),
    gtin: $('[itemprop="gtin13"]').first().attr('content') ?? undefined,
    mpn: $('[itemprop="mpn"]').first().attr('content') ?? undefined,
  };
}

export function extractProduct(html: string): ProductInfo | null {
  const ld = productFromJsonLd(html);
  const meta = productFromMeta(html);
  if (ld && ld.price) return { ...meta, ...stripEmpty(ld) };
  if (meta.price) return { ...stripEmpty(ld ?? {}), ...stripEmpty(meta) } as ProductInfo;
  return ld ?? (meta.title ? meta : null);
}

function stripEmpty<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<T>;
}

/** Eingebettete Zustands-JSONs (Next.js __NEXT_DATA__, window.__PRELOADED_STATE__ usw.) */
export function embeddedJson(html: string, marker: string): any | null {
  if (marker === '__NEXT_DATA__') {
    const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) { try { return JSON.parse(m[1]); } catch { return null; } }
    return null;
  }
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const start = html.indexOf('{', idx);
  if (start < 0) return null;
  const end = matchBrace(html, start);
  if (end < 0) return null;
  try { return JSON.parse(html.slice(start, end + 1)); } catch { return null; }
}

function matchBrace(s: string, start: number): number {
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Sucht rekursiv nach Objekten, die eine Bedingung erfüllen (z.B. in __NEXT_DATA__) */
export function deepFind(obj: any, pred: (o: any) => boolean, out: any[] = [], depth = 0): any[] {
  if (!obj || typeof obj !== 'object' || depth > 40) return out;
  if (pred(obj)) out.push(obj);
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) deepFind(v, pred, out, depth + 1);
  return out;
}

export function absUrl(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try { return new URL(href, base).toString(); } catch { return undefined; }
}
