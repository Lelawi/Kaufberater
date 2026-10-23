// Einmalig: Packungsgrößen für bereits gespeicherte Angebote, Deals und Preisverlauf nachtragen
import { db } from '../db.ts';
import { packSize } from '../util/pack.ts';

export async function packBackfill() {
  const sql = await db();
  // Erledigt-Merker: ein früherer Lauf mit Ergebnis dieses Schritts (kb_worker_config darf der Worker nicht lesen)
  const [done] = await sql`select 1 from kb_runs where stats -> 'packs' ? 'offers' limit 1`;
  if (done) return null;
  const listings = await sql`select id, product_id, source, external_id, title from kb_listings`;
  const lPack = new Map(listings.map((l) => [l.id as string, packSize(l.title as string) ?? 1]));
  const offers = await sql`select id, listing_id, title from kb_offers`;
  const o = offers.map((x) => ({ id: x.id, pack: packSize(x.title as string) ?? lPack.get(x.listing_id as string) ?? 1 }));
  const deals = await sql`select id, title from kb_deals`;
  const d = deals.map((x) => ({ id: x.id, pack: packSize(x.title as string) ?? 1 }));
  const l = listings.map((x) => ({ product_id: x.product_id, series: 'hist:' + x.source, shop: x.external_id, pack: lPack.get(x.id as string) ?? 1 }));
  const r1 = o.length ? await sql`update kb_offers t set pack_size = v.pack from jsonb_to_recordset(${sql.json(o as any)}) as v(id uuid, pack int)
                                   where t.id = v.id and t.pack_size <> v.pack` : { count: 0 };
  const r2 = d.length ? await sql`update kb_deals t set pack_size = v.pack from jsonb_to_recordset(${sql.json(d as any)}) as v(id uuid, pack int)
                                   where t.id = v.id and t.pack_size <> v.pack` : { count: 0 };
  // Verlauf: eigene Abfragen über das Angebot, Preisvergleich-Verlauf über die Quelle, Deals über den Deal
  const r3 = await sql`update kb_price_history h set pack_size = o.pack_size from kb_offers o where h.offer_id = o.id and h.pack_size <> o.pack_size`;
  const r4 = l.length ? await sql`update kb_price_history h set pack_size = v.pack
                                   from jsonb_to_recordset(${sql.json(l as any)}) as v(product_id uuid, series text, shop text, pack int)
                                   where h.product_id = v.product_id and h.series = v.series and h.shop = v.shop and h.pack_size <> v.pack` : { count: 0 };
  const r5 = await sql`update kb_price_history h set pack_size = d.pack_size from kb_deals d
                       where h.product_id = d.product_id and h.series = 'deal:' || d.portal and h.total = d.price
                         and h.observed_at = coalesce(d.posted_at, h.observed_at) and h.pack_size <> d.pack_size`;
  return { offers: r1.count, deals: r2.count, offerHist: r3.count, compareHist: r4.count, dealHist: r5.count };
}
