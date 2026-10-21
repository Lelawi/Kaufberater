// eBay über die offizielle, kostenlose Browse-Schnittstelle (developer.ebay.com, 5.000 Abfragen/Tag).
// Aktiv, sobald EBAY_APP_ID und EBAY_CERT_ID als GitHub-Secrets hinterlegt sind.
// Pro Produkt gibt es ein Abfrageziel „eBay-Suche“; jede Abfrage liefert die aktuell passenden Sofortkauf-Angebote
// mit Lieferung nach Deutschland. Verkäufernamen werden bewusst NICHT gespeichert (eBay-Datenschutzregel).
import { matchTitle, searchQuery, type ProductQuery } from '../util/match.ts';
import type { Candidate, Condition, ListingRef, OfferData, SourceAdapter } from './types.ts';

const API = 'https://api.ebay.com';
let token: { value: string; until: number } | null = null;

export function ebayConfigured(): boolean {
  return !!(process.env.EBAY_APP_ID && process.env.EBAY_CERT_ID);
}

async function accessToken(): Promise<string> {
  if (token && Date.now() < token.until - 60_000) return token.value;
  const basic = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');
  const r = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`eBay-Anmeldung fehlgeschlagen (${r.status}) – App-ID/Cert-ID prüfen`);
  const j = await r.json() as { access_token: string; expires_in: number };
  token = { value: j.access_token, until: Date.now() + j.expires_in * 1000 };
  return token.value;
}

/** eBay-Zustandscodes → unsere Zustände */
export function ebayCondition(id: string | undefined, text?: string): Condition {
  const n = Number(id);
  if (n === 1000) return 'new';
  if (n === 1500 || n === 1750) return 'bware';                 // neu, sonstige / mit Fehlern
  if (n >= 2000 && n < 3000) return 'refurbished';              // generalüberholt (Hersteller/Verkäufer/Zustand)
  if (n >= 3000) return 'used';
  return /neu/i.test(text ?? '') ? 'new' : 'used';
}

export interface EbayItem {
  itemId: string; title: string; itemWebUrl: string; condition?: string; conditionId?: string;
  price?: { value: string; currency: string };
  shippingOptions?: { shippingCost?: { value: string; currency: string }; shippingCostType?: string }[];
  seller?: { feedbackPercentage?: string; feedbackScore?: number };
  itemLocation?: { country?: string };
  buyingOptions?: string[];
}

/** Antwort der Suche → Angebote (nur passende Titel, nur Euro, nur Sofortkauf) */
export function ebayOffers(items: EbayItem[], q: ProductQuery, minScore = 0.8): OfferData[] {
  const out: OfferData[] = [];
  for (const it of items) {
    if (!it.price || it.price.currency !== 'EUR') continue;
    if (it.buyingOptions && !it.buyingOptions.includes('FIXED_PRICE')) continue;
    const m = matchTitle(q, it.title);
    if (m.score < minScore) continue;
    const ship = it.shippingOptions?.[0]?.shippingCost;
    const pct = it.seller?.feedbackPercentage ? Number(it.seller.feedbackPercentage) : null;
    out.push({
      offerKey: `ebay:${it.itemId}`,
      shop: 'eBay',
      country: it.itemLocation?.country ?? 'DE',
      condition: ebayCondition(it.conditionId, it.condition),
      title: it.title,
      url: it.itemWebUrl,
      price: Number(it.price.value),
      shipping: ship ? Number(ship.value) : null,
      inStock: true,
      deliveryText: it.itemLocation?.country && it.itemLocation.country !== 'DE' ? `Versand aus ${it.itemLocation.country}` : undefined,
      // Bewertung des Verkäufers (Prozent → 1–5) und Anzahl Bewertungen – für die Regel „nur seriöse Händler“
      shopRating: pct != null ? Math.round((pct / 20) * 10) / 10 : null,
      shopReviews: it.seller?.feedbackScore ?? null,
    });
  }
  // Übersichtlich bleiben: die 8 günstigsten Neuware-Angebote und 4 günstigsten sonstigen
  const total = (o: OfferData) => o.price + (o.shipping ?? 0);
  const neu = out.filter((o) => o.condition === 'new').sort((a, b) => total(a) - total(b)).slice(0, 8);
  const rest = out.filter((o) => o.condition !== 'new').sort((a, b) => total(a) - total(b)).slice(0, 4);
  return [...neu, ...rest];
}

async function searchItems(term: string, conditions: string): Promise<EbayItem[]> {
  const params = new URLSearchParams({
    q: term.slice(0, 100), limit: '50',
    filter: `deliveryCountry:DE,priceCurrency:EUR,buyingOptions:{FIXED_PRICE},conditions:{${conditions}}`,
    sort: 'price',
  });
  const r = await fetch(`${API}/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${await accessToken()}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE', 'Accept-Language': 'de-DE' },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 429) throw new Error('eBay: Tageslimit erreicht');
  if (!r.ok) throw new Error(`eBay-Suche ${r.status}`);
  const j = await r.json() as { itemSummaries?: EbayItem[] };
  return j.itemSummaries ?? [];
}

export const ebayAdapter: SourceAdapter = {
  key: 'ebay', label: 'eBay', kind: 'marketplace', countries: ['DE'], minDelayMs: 1000,
  async search(q: ProductQuery): Promise<Candidate[]> {
    // Ein Abfrageziel je Produkt (die Angebote selbst wechseln ständig)
    const term = searchQuery(q);
    return [{ externalId: `q:${term.toLowerCase()}`, url: `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(term)}&LH_BIN=1`,
              title: `eBay-Suche: ${term}`, country: 'DE', condition: 'new', score: 1, reason: 'Suche über eBay-Schnittstelle' }];
  },
  async fetch(l: ListingRef, q: ProductQuery): Promise<OfferData[]> {
    const term = l.external_id.startsWith('q:') ? l.external_id.slice(2) : searchQuery(q);
    // Neuware immer; Refurbished/B-Ware in derselben Abfrage (eBay-Codes 1000 neu, 1500 neu-sonstige, 2000–2500 generalüberholt)
    const items = await searchItems(term, 'NEW|OPEN_BOX|CERTIFIED_REFURBISHED|EXCELLENT_REFURBISHED|VERY_GOOD_REFURBISHED|GOOD_REFURBISHED');
    return ebayOffers(items, q);
  },
};
