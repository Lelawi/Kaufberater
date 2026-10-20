// Fällige Abfrageziele abrufen, Angebote speichern, Preisverlauf fortschreiben
import { db } from '../db.ts';
import { sourceByKey, availableHere, IS_HOME } from '../adapters/registry.ts';
import { needsHomeUrl } from '../adapters/shops.ts';
import { toQuery } from '../products.ts';
import { blockedSources, recordSourceResult } from './health.ts';
import type { OfferData } from '../adapters/types.ts';

interface DueListing {
  id: string; product_id: string; user_id: string; source: string; country: string; external_id: string; url: string;
  condition: 'new' | 'refurbished' | 'used' | 'bware'; title: string | null; check_interval_minutes: number; error_count: number;
  p_name: string; p_name_auto: boolean; p_brand: string | null; p_model: string | null; p_ean: string | null; p_terms: string[]; p_exclude: string[];
}

export async function runChecks(deadline: number, opts: { productId?: string; limit?: number } = {}) {
  const sql = await db();
  const blocked = await blockedSources();
  const due = await sql<DueListing[]>`
    select l.id, l.product_id, l.user_id, l.source, l.country, l.external_id, l.url, l.condition, l.title,
           l.check_interval_minutes, l.error_count,
           p.name as p_name, p.name_auto as p_name_auto, p.brand as p_brand, p.model as p_model, p.ean as p_ean,
           p.search_terms as p_terms, p.exclude_terms as p_exclude
    from kb_listings l join kb_products p on p.id = l.product_id
    where l.active and not l.rejected
      and (l.next_check_at <= now() or ${opts.productId ?? null}::uuid is not null)
      and (${opts.productId ?? null}::uuid is null or l.product_id = ${opts.productId ?? null}::uuid)
      and (p.status = 'watching' or (p.status = 'bought' and p.return_until >= current_date))
    order by l.next_check_at
    limit ${opts.limit ?? 500}`;

  // Pro Quelle nacheinander (höflich), verschiedene Quellen parallel
  const bySource = new Map<string, DueListing[]>();
  for (const l of due) {
    if (blocked.has(l.source)) continue;
    const ad = sourceByKey(l.source);
    if (!ad || !availableHere(ad)) continue;
    if (l.source === 'shop' && !IS_HOME && needsHomeUrl(l.url)) continue;
    const arr = bySource.get(l.source) ?? [];
    arr.push(l);
    bySource.set(l.source, arr);
  }
  const stats = { listings: 0, ok: 0, errors: 0, offers: 0, priceChanges: 0 };
  await Promise.all([...bySource.entries()].map(async ([sourceKey, listings]) => {
    const adapter = sourceByKey(sourceKey);
    if (!adapter) return;
    for (const l of listings) {
      if (Date.now() > deadline) return;
      stats.listings++;
      try {
        const offers = await adapter.fetch(
          { id: l.id, source: l.source, country: l.country, external_id: l.external_id, url: l.url, condition: l.condition, title: l.title },
          toQuery({ id: l.product_id, name: l.p_name, brand: l.p_brand, model: l.p_model, ean: l.p_ean, search_terms: l.p_terms, exclude_terms: l.p_exclude }),
        );
        const r = await saveOffers(l, offers.filter((o) => o.shipsToDE !== false && o.price > 0));
        // Nur per Link eingetragen? Dann den richtigen Produktnamen von der Seite übernehmen und danach überall suchen
        const pageTitle = offers.find((o) => o.title)?.title;
        if (l.p_name_auto && pageTitle) {
          const name = pageTitle.replace(/\s*[|–-]\s*(kaufen|online|bei|im|günstig).*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 100);
          const model = name.match(/\b([A-Z]{0,6}\d{2,}[A-Z0-9-]{2,})\b/)?.[1] ?? null;
          await sql`update kb_products set name = ${name}, name_auto = false, model = coalesce(model, ${model}), discovery_status = 'pending' where id = ${l.product_id} and name_auto`;
          l.p_name_auto = false;
        }
        stats.offers += r.offers; stats.priceChanges += r.changes; stats.ok++;
        await sql`update kb_listings set last_checked_at = now(), last_ok_at = now(), last_error = null, error_count = 0,
                   next_check_at = now() + make_interval(mins => check_interval_minutes) where id = ${l.id}`;
        await recordSourceResult(sourceKey, true);
      } catch (e) {
        stats.errors++;
        const msg = (e as Error).message.slice(0, 500);
        // Bei Fehlern seltener versuchen (max. 1x pro Tag), nach 20 Fehlern in Folge deaktivieren
        await sql`update kb_listings set last_checked_at = now(), last_error = ${msg}, error_count = error_count + 1,
                   next_check_at = now() + make_interval(mins => least(1440, check_interval_minutes * power(2, least(error_count + 1, 7))::int)),
                   active = error_count + 1 < 20
                 where id = ${l.id}`;
        if ((e as any).status === 404) await sql`update kb_listings set active = false where id = ${l.id}`;
        await recordSourceResult(sourceKey, false, msg);
        if (/blockiert/.test(msg)) return; // Quelle für diesen Lauf aufgeben
      }
    }
  }));
  return stats;
}

async function saveOffers(l: DueListing, offers: OfferData[]) {
  const sql = await db();
  let changes = 0;
  const keys: string[] = [];
  for (const o of offers) {
    const total = Math.round((o.price + (o.shipping ?? 0)) * 100) / 100;
    keys.push(o.offerKey);
    const prev = await sql`select id, total from kb_offers where listing_id = ${l.id} and offer_key = ${o.offerKey}`;
    const row = await sql`
      insert into kb_offers (product_id, listing_id, user_id, offer_key, source, shop, country, condition, title, url, price, shipping, total,
                             list_price, in_stock, delivery_text, seller, last_seen_at, gone)
      values (${l.product_id}, ${l.id}, ${l.user_id}, ${o.offerKey}, ${l.source}, ${o.shop}, ${o.country}, ${o.condition}, ${o.title?.slice(0, 500) ?? null},
              ${o.url ?? l.url}, ${o.price}, ${o.shipping ?? null}, ${total}, ${o.listPrice ?? null}, ${o.inStock ?? null},
              ${o.deliveryText?.slice(0, 200) ?? null}, ${o.seller?.slice(0, 200) ?? null}, now(), false)
      on conflict (listing_id, offer_key) do update set
        shop = excluded.shop, country = excluded.country, condition = excluded.condition, title = coalesce(excluded.title, kb_offers.title),
        url = excluded.url, price = excluded.price, shipping = excluded.shipping, total = excluded.total, list_price = excluded.list_price,
        in_stock = excluded.in_stock, delivery_text = excluded.delivery_text, seller = excluded.seller, last_seen_at = now(), gone = false
      returning id`;
    const offerId = row[0].id as string;
    const changed = !prev.length || Number(prev[0].total) !== total;
    // Verlauf: bei Preisänderung oder spätestens alle 24h ein Stützpunkt
    const recent = changed ? [] : await sql`select 1 from kb_price_history where offer_id = ${offerId} and observed_at > now() - interval '24 hours' limit 1`;
    if (changed || !recent.length) {
      if (changed && prev.length) changes++;
      await sql`insert into kb_price_history (product_id, user_id, offer_id, series, shop, condition, total, in_stock)
                values (${l.product_id}, ${l.user_id}, ${offerId}, 'offer', ${o.shop}, ${o.condition}, ${total}, ${o.inStock ?? null})`;
    }
  }
  // Angebote, die nicht mehr auftauchen, als verschwunden markieren
  if (keys.length) {
    await sql`update kb_offers set gone = true where listing_id = ${l.id} and not (offer_key = any(${keys})) and not gone`;
  } else {
    await sql`update kb_offers set gone = true where listing_id = ${l.id} and not gone`;
  }
  return { offers: offers.length, changes };
}
