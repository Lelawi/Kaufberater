import type { ProductQuery } from './util/match.ts';

export interface ProductRow {
  id: string;
  user_id: string;
  name: string;
  brand: string | null;
  model: string | null;
  ean: string | null;
  status: string;
  include_refurb: boolean;
  search_terms: string[];
  exclude_terms: string[];
  threshold_good: number | null;
  threshold_top: number | null;
  threshold_instant: number | null;
  max_price: number | null;
  best_price: number | null;
  best_refurb_price: number | null;
  lowest_seen: number | null;
  bought_price: number | null;
  bought_at: Date | null;
  return_until: Date | null;
  window_end: Date | null;
  window_type: string;
  quantity: number;
  best_basket?: any;
}

export function toQuery(p: Pick<ProductRow, 'id' | 'name' | 'brand' | 'model' | 'ean' | 'search_terms' | 'exclude_terms'>): ProductQuery {
  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    model: p.model,
    ean: p.ean,
    terms: p.search_terms ?? [],
    exclude: p.exclude_terms ?? [],
  };
}
