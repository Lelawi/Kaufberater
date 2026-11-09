// Shops mit eigener Suche, die von GitHub aus erreichbar sind (geprüft am 21.10.2026). Alle liefern nach Deutschland.
import { loadHtml, absUrl, extractProduct, embeddedJson } from '../util/extract.ts';
import { fetchPage } from '../util/http.ts';
import { parsePrice } from '../util/money.ts';
import { cleanText, conditionFromTitle } from './common.ts';
import { makeSearchShop, hitsFromJsonLd, noPriceError, type SearchHit, type SearchShopConfig } from './searchshops.ts';
import { parseShopPage } from './shops.ts';
import type { ListingRef, OfferData, SourceAdapter } from './types.ts';
import { searchQuery, type ProductQuery } from '../util/match.ts';

const enc = encodeURIComponent;
/** Modellnummer bevorzugt (Shops mit exakter Suche finden sonst nichts) */
const modelTerm = (q: ProductQuery) => (q.model && q.model.length >= 4 ? q.model : searchQuery(q));

/** HTML-Kacheln: Container + Link + Titel + Preis per Selektor */
function tiles(sel: { tile: string; link: string; title?: string; titleAttr?: string; price?: string }) {
  return (html: string, base: string): SearchHit[] => {
    const $ = loadHtml(html);
    const out: SearchHit[] = [];
    $(sel.tile).each((_, el) => {
      const t = $(el);
      const a = t.is('a') ? t : t.find(sel.link).first();
      const url = absUrl(a.attr('href'), base);
      const title = cleanText(sel.titleAttr ? t.find(sel.title ?? '*').first().attr(sel.titleAttr) ?? a.attr(sel.titleAttr) : sel.title ? t.find(sel.title).first().text() : a.text());
      if (!url || !title) return;
      const price = sel.price ? parsePrice(t.find(sel.price).first().text()) : null;
      out.push({ title, url: url.split('#')[0], price });
    });
    return out;
  };
}

const CONFIGS: SearchShopConfig[] = [
  {
    key: 'coolblue', label: 'Coolblue', base: 'https://www.coolblue.de', country: 'DE',
    searchUrl: (t) => `https://www.coolblue.de/suchen?query=${enc(t)}`,
  },
  {
    key: 'alternate', label: 'Alternate', base: 'https://www.alternate.de', country: 'DE', term: modelTerm,
    searchUrl: (t) => `https://www.alternate.de/listing.xhtml?q=${enc(t)}`,
    parseSearch: (html, base) => {
      const $ = loadHtml(html);
      const out: SearchHit[] = [];
      $('a.productBox[href*="/html/product/"]').each((_, a) => {
        const t = $(a);
        const title = cleanText(`${t.find('.product-name').first().text()} ${t.find('.product-name-sub').first().text()}`);
        const url = absUrl(t.attr('href'), base);
        if (url && title) out.push({ title, url, price: parsePrice(t.find('span.price').first().text()) });
      });
      return out;
    },
  },
  {
    key: 'berlet', label: 'Berlet', base: 'https://www.berlet.de', country: 'DE',
    searchUrl: (t) => `https://www.berlet.de/search-detail.htm?searchstr=${enc(t)}`,
    parseSearch: tiles({ tile: '.product-preview', link: 'a.imglink[href^="/product/"]', title: 'img.product-img', titleAttr: 'alt', price: '.preview-price strong' }),
  },
  {
    key: 'medimax', label: 'Medimax', base: 'https://www.medimax.de', country: 'DE',
    searchUrl: (t) => `https://www.medimax.de/search?text=${enc(t)}`,
    parseSearch: (html, base) => {
      const $ = loadHtml(html);
      const out: SearchHit[] = [];
      $('.cmsproductlist-desktop-layout-item[data-et-name]').each((_, el) => {
        const t = $(el);
        const url = absUrl(t.find('a.cmsproductlist-name-link').first().attr('href'), base);
        const title = cleanText(t.attr('data-et-name'));
        if (url && title) out.push({ title, url, price: parsePrice(t.attr('data-et-price')) });
      });
      return out;
    },
  },
  // Shopware-6-Shops (gleiche Technik, Suchparameter „search“)
  ...[['jacob', 'jacob', 'https://www.jacob.de'], ['technikdirekt', 'technikdirekt', 'https://www.technikdirekt.de']].map(([key, label, base]): SearchShopConfig => ({
    key, label, base, country: 'DE',
    searchUrl: (t) => `${base}/search?search=${enc(t)}`,
    parseSearch: (html, b) => {
      const $ = loadHtml(html);
      const out: SearchHit[] = [];
      $('.card.product-box').each((_, el) => {
        const t = $(el);
        let info: any = {};
        try { info = JSON.parse(t.attr('data-product-information') ?? '{}'); } catch { /* */ }
        let price = parsePrice(String(info.price ?? ''));
        if (!price) {
          try { price = parsePrice(String(JSON.parse(t.find('input[id^="etracker-wishlist-product-"]').attr('value') ?? '{}').price ?? '')); } catch { /* */ }
        }
        price = price ?? parsePrice(t.find('.product-price').first().text());
        const a = t.find('a.product-name, a.jacob-product-name, a[title][href*="/produkt"]').first();
        const url = absUrl(a.attr('href'), b);
        const title = cleanText(info.name || a.attr('title') || a.text());
        if (url && title) out.push({ title, url, price });
      });
      return out;
    },
    // Produktseite ohne Produktdaten (technikdirekt) → Preis aus der Seite
    parseProduct: (html, url) => parseShopPage(html, url) ?? priceFromHtml(html, url, '.product-detail-price, .product-price'),
  })),
  // BAUR und Quelle (Otto-Gruppe): Produktseite ohne Angebotsdaten → Preis aus HTML; Speditionskosten kommen dazu
  ...[['baur', 'BAUR', 'https://www.baur.de'], ['quelle', 'Quelle', 'https://www.quelle.de']].map(([key, label, base]): SearchShopConfig => ({
    key, label, base, country: 'DE',
    searchUrl: (t) => `${base}/s/${enc(t)}/`,
    parseProduct: (html, url) => {
      const o = parseShopPage(html, url) ?? priceFromHtml(html, url, '[data-name="p-price"] .price-value');
      if (o && /Speditionsgebühr|Speditionskosten/i.test(html)) o.deliveryText = 'zzgl. Speditionsgebühr';
      return o;
    },
  })),
  {
    key: 'voelkner', label: 'voelkner', base: 'https://www.voelkner.de', country: 'DE', kind: 'marketplace',
    searchUrl: (t) => `https://www.voelkner.de/search/search.html?keywords=${enc(t)}`,
    parseSearch: (html, base) => {
      const $ = loadHtml(html);
      const out: SearchHit[] = [];
      $('a.card--interactive[data-tracking-pid]').each((_, a) => {
        const t = $(a);
        const title = cleanText(t.find('.product__title').first().attr('title') || t.find('.product__title').first().text());
        const euro = t.find('.product__price__wrapper__euro').first().text().trim();
        const cent = t.find('.product__price__wrapper__cent').first().text().trim();
        const url = absUrl(t.attr('href'), base);
        if (url && title) out.push({ title, url, price: parsePrice(`${euro}${cent}`) });
      });
      return out;
    },
  },
  {
    key: 'rebuy', label: 'rebuy', base: 'https://www.rebuy.de', country: 'DE', kind: 'refurb',
    searchUrl: (t) => `https://www.rebuy.de/kaufen/suchen?q=${enc(t)}`,
    parseSearch: (html, base) => {
      const $ = loadHtml(html);
      const out: SearchHit[] = [];
      $('ry-product').each((_, el) => {
        const t = $(el);
        const url = absUrl(t.find('a[data-cy="product-link"]').first().attr('href'), base);
        const title = cleanText(t.find('.title').first().text());
        if (url && title) out.push({ title, url, price: parsePrice(t.find('[data-cy="product-price"]').first().text()), condition: 'refurbished' });
      });
      return out;
    },
  },
];

/** Preis per Selektor, falls die Seite keine Produktdaten (schema.org) hat */
function priceFromHtml(html: string, url: string, selector: string): OfferData | null {
  const $ = loadHtml(html);
  const price = parsePrice($(selector).first().text());
  if (!price) return null;
  const info = extractProduct(html);
  const title = cleanText(info?.title ?? $('h1').first().text());
  return { offerKey: 'page', shop: new URL(url).hostname, country: 'DE', condition: conditionFromTitle(title), title, url, price, inStock: info?.inStock ?? null };
}

/** Shopify-Shops: Suche über /search/suggest.json, Produkt über /products/<handle>.js (mit EAN) */
function shopify(key: string, label: string, base: string): SourceAdapter {
  return makeSearchShop({
    key, label, base, country: 'DE',
    searchUrl: (t) => `${base}/search/suggest.json?q=${enc(t)}&resources[type]=product&resources[limit]=10`,
    parseSearch: (text, b) => {
      try {
        const j = JSON.parse(text);
        return (j?.resources?.results?.products ?? []).map((p: any) => ({
          title: cleanText(p.title), url: absUrl(p.url ?? `/products/${p.handle}`, b)!.split('?')[0], price: parsePrice(String(p.price ?? '')),
        }));
      } catch { return []; }
    },
    parseProduct: (html, url) => parseShopPage(html, url),
  });
}

/** AliExpress (9.11.2026, Wunsch Nutzer für Singles Day): Die Suchseite bettet die Trefferliste als JSON ein
 *  ("itemList":{"content":[…]}), Produktseiten laden den Preis erst im Browser nach. Preisabfrage daher über die Suche nach
 *  dem gespeicherten Titel (Treffer mit gleicher Artikelnummer). Marktplatz: Importware/Länderversion möglich (plausible.ts). */
export function aliexpressHits(html: string): (SearchHit & { freeShipping?: boolean })[] {
  const list = embeddedJson(html, '"itemList":');
  // Lager außerhalb der EU („USA Stock“, „UK Warehouse“) – in Deutschland nicht bestellbar
  const foreignStock = /\b(us|usa|uk|cn|china|ru|au)\s*(stock|warehouse|lager|shipping|versand)\b/i;
  return ((list?.content ?? []) as any[]).filter((it) => it?.productId && it?.title?.displayTitle && !foreignStock.test(it.title.displayTitle)).map((it) => {
    const sale = it.prices?.salePrice;
    const price = typeof sale?.minPrice === 'number' ? sale.minPrice : parsePrice(String(sale?.formattedPrice ?? ''));
    const free = JSON.stringify(it.sellingPoints ?? []).includes('Free_Shipping');
    return {
      title: cleanText(it.title.displayTitle), url: `https://de.aliexpress.com/item/${it.productId}.html`,
      price: price ?? null, externalId: String(it.productId), condition: 'new' as const, freeShipping: free,
    };
  });
}
const aliSearchUrl = (t: string) => `https://de.aliexpress.com/w/wholesale-${enc(t.trim().replace(/\s+/g, '-'))}.html`;
const aliBase = makeSearchShop({
  key: 'aliexpress', label: 'AliExpress', base: 'https://de.aliexpress.com', country: 'DE', kind: 'marketplace',
  searchUrl: aliSearchUrl, parseSearch: aliexpressHits, minDelayMs: 6000,
});
const aliexpress: SourceAdapter = {
  ...aliBase,
  async fetch(l: ListingRef): Promise<OfferData[]> {
    // Suche schwankt: erst langer, dann kurzer Titel
    const words = (l.title ?? '').split(/\s+/).filter(Boolean);
    let hit: ReturnType<typeof aliexpressHits>[number] | undefined;
    let p: Awaited<ReturnType<typeof fetchPage>> | undefined;
    for (const n of [12, 6]) {
      if (!words.length) break;
      p = await fetchPage(aliSearchUrl(words.slice(0, n).join(' ')), { country: 'DE', minDelayMs: 6000 });
      hit = aliexpressHits(p.text).find((h) => h.externalId === l.external_id);
      if (hit?.price || words.length <= 6) break;
    }
    if (!hit?.price) throw noPriceError(p?.url ?? l.url, p?.status ?? 0, p?.text ?? '');
    return [{
      offerKey: 'page', shop: 'AliExpress', country: 'DE', condition: 'new', title: hit.title, url: l.url, price: hit.price,
      shipping: hit.freeShipping ? 0 : null, inStock: true, seller: 'Marktplatz',
    }];
  },
};

export const shopSearchAdapters: SourceAdapter[] = [
  ...CONFIGS.map(makeSearchShop),
  shopify('hifiprofis', 'HiFi-Profis', 'https://www.hifi-profis-da.de'),
  // OBI (geprüft 23.10.2026): Suchseite mit schema.org-Trefferliste, Produktseiten mit Produktdaten
  makeSearchShop({ key: 'obi', label: 'OBI', base: 'https://www.obi.de', country: 'DE', searchUrl: (t) => `https://www.obi.de/search/${enc(t)}/` }),
  aliexpress,
];

export { hitsFromJsonLd };
