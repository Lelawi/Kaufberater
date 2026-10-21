import type { ProductQuery } from '../util/match.ts';

export type Condition = 'new' | 'refurbished' | 'used' | 'bware';

/** Ein Treffer bei der Produktsuche – wird zu einem Abfrageziel (kb_listings) */
export interface Candidate {
  externalId: string;
  url: string;
  title: string;
  country: string;
  condition?: Condition;
  price?: number | null;
  score: number;           // 0..1, wie sicher das das gesuchte Produkt ist
  reason?: string;
  gtin?: string;
}

/** Ein konkretes Angebot (Preis bei einem Händler) */
export interface OfferData {
  offerKey: string;        // eindeutig innerhalb eines Listings
  shop: string;
  country: string;
  condition: Condition;
  title?: string;
  url?: string;
  price: number;
  shipping?: number | null;
  listPrice?: number | null;
  inStock?: boolean | null;
  deliveryText?: string;
  seller?: string;
  shipsToDE?: boolean;     // false = wird ausgefiltert
  shopRating?: number | null;   // Shop-Bewertung 1–5 (falls bekannt)
  shopReviews?: number | null;  // Anzahl Shop-Bewertungen
}

/** Treffer in Deal-Portalen */
export interface DealData {
  portal: string;
  externalId: string;
  title: string;
  url: string;
  merchant?: string;
  price?: number | null;
  nextBestPrice?: number | null;
  temperature?: number | null;
  commentCount?: number | null;
  postedAt?: Date | null;
  expired?: boolean;
  voucherCode?: string | null;
}

export interface ListingRef {
  id: string;
  source: string;
  country: string;
  external_id: string;
  url: string;
  condition: Condition;
  title?: string | null;
}

export interface SourceAdapter {
  key: string;
  label: string;
  kind: 'shop' | 'aggregator' | 'refurb' | 'marketplace';
  countries: string[];
  /** Mindestabstand zwischen zwei Anfragen an diese Quelle */
  minDelayMs?: number;
  /** Quelle blockt Rechenzentren → läuft nur auf dem Heim-Rechner (Raspberry Pi) */
  needsHome?: boolean;
  search?(q: ProductQuery): Promise<Candidate[]>;
  fetch(listing: ListingRef, q: ProductQuery): Promise<OfferData[]>;
}

export interface DealAdapter {
  key: string;
  label: string;
  country: string;
  search(q: ProductQuery): Promise<DealData[]>;
}
