// Fällige Abfrageziele abrufen, Angebote speichern, Preisverlauf fortschreiben
import { db, debugLog } from '../db.ts';
import { sourceByKey, availableHere, IS_HOME } from '../adapters/registry.ts';
import { needsHomeUrl } from '../adapters/shops.ts';
import { toQuery } from '../products.ts';
import { blockedSources, recordSourceResult } from './health.ts';
import type { OfferData } from '../adapters/types.ts';
import { plausibleOffers } from '../util/plausible.ts';
import { hotWindow } from '../util/events.ts';
import { pageHistory, pageImage } from '../util/history.ts';
import { offerPackSize, packSize } from '../util/pack.ts';
import { norm } from '../util/match.ts';

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
  // In der heißen Phase höchstens 25 Minuten bis zur nächsten Abfrage
  const cap = hotWindow() ? 25 : 100_000;
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
        // Ausgeschlossene Varianten (z. B. „Essential“ nach der Rückfrage) gar nicht erst speichern
        const ex = (l.p_exclude ?? []).map(norm).filter(Boolean);
        const usable = plausibleOffers(offers.filter((o) => o.shipsToDE !== false && o.price > 0 && !ex.some((e) => norm(o.title).includes(e))));
        // Preisvergleich liefert plötzlich (fast) nichts, obwohl vorher viele Angebote da waren → Seite vermutlich unvollständig.
        // Dann nichts als „verschwunden“ markieren, sondern bald noch einmal versuchen.
        if (adapter.kind === 'aggregator' && usable.length <= 1) {
          const [{ n }] = await sql`select count(*)::int as n from kb_offers where listing_id = ${l.id} and not gone`;
          if (n >= 4) {
            stats.errors++;
            await sql`update kb_listings set last_checked_at = now(), last_error = ${'Seite ohne Angebotsliste – wird wiederholt'},
                       next_check_at = now() + interval '20 minutes' where id = ${l.id}`;
            continue;
          }
        }
        const r = await saveOffers(l, usable);
        // Vorschaubild für die Liste: das erste gefundene Produktbild (Preisvergleiche zuerst – dort sind es saubere Produktfotos)
        if (pageImage.has(l.url)) {
          const img = pageImage.get(l.url)!; pageImage.delete(l.url);
          await sql`update kb_products set image_url = ${img} where id = ${l.product_id}
                    and (image_url is null or (${adapter.kind === 'aggregator' && (packSize(l.title) ?? 1) === 1} and image_url not like '%idealo%' and image_url not like '%billiger%'))
                    and image_url is distinct from ${img}`;
        }
        if (pageHistory.has(l.url)) { await importHistory(l, pageHistory.get(l.url)).catch((e) => console.log('Preisverlauf:', e.message)); pageHistory.delete(l.url); }
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
                   next_check_at = now() + make_interval(mins => least(check_interval_minutes, ${cap})) where id = ${l.id}`;
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
        if ((e as any).body !== undefined) {
          const be = e as any;
          await debugLog('gesperrt:' + sourceKey, { url: be.url, status: be.status, headers: { response: be.headers, sent: be.sentHeaders }, body: be.body }).catch(() => {});
        }
        if (/blockiert/.test(msg)) return; // Quelle für diesen Lauf aufgeben
      }
    }
  }));
  return stats;
}

async function saveOffers(l: DueListing, offersIn: OfferData[]) {
  const sql = await db();
  // gleiche Angebots-Kennung nur einmal (günstigstes behalten) – sonst scheitert das Sammel-Speichern
  const byKey = new Map<string, OfferData>();
  for (const o of offersIn) {
    const cur = byKey.get(o.offerKey);
    if (!cur || o.price + (o.shipping ?? 0) < cur.price + (cur.shipping ?? 0)) byKey.set(o.offerKey, o);
  }
  const offers = [...byKey.values()];
  if (!offers.length) {
    await sql`update kb_offers set gone = true where listing_id = ${l.id} and not gone`;
    return { offers: 0, changes: 0 };
  }
  // Bisheriger Stand in einer Abfrage
  const prevRows = await sql`
    select o.offer_key, o.total, (select max(h.observed_at) from kb_price_history h where h.offer_id = o.id) as last_hist
    from kb_offers o where o.listing_id = ${l.id}`;
  const prev = new Map(prevRows.map((r) => [r.offer_key as string, r]));
  const rows = offers.map((o) => ({
    product_id: l.product_id, listing_id: l.id, user_id: l.user_id, offer_key: o.offerKey, source: l.source, shop: o.shop,
    country: o.country, condition: o.condition, title: o.title?.slice(0, 500) ?? null, url: o.url ?? l.url, price: o.price,
    shipping: o.shipping ?? null, total: Math.round((o.price + (o.shipping ?? 0)) * 100) / 100, list_price: o.listPrice ?? null,
    in_stock: o.inStock ?? null, delivery_text: o.deliveryText?.slice(0, 200) ?? null, seller: o.seller?.slice(0, 200) ?? null,
    shop_rating: o.shopRating ?? null, shop_reviews: o.shopReviews ?? null, gone: false,
    pack_size: offerPackSize(o.title, l.title),
  }));
  // Alle Angebote in einem Schritt speichern
  const saved = await sql`
    insert into kb_offers ${sql(rows)}
    on conflict (listing_id, offer_key) do update set
      shop = excluded.shop, country = excluded.country, condition = excluded.condition, title = coalesce(excluded.title, kb_offers.title),
      url = excluded.url, price = excluded.price, shipping = excluded.shipping, total = excluded.total, list_price = excluded.list_price,
      in_stock = excluded.in_stock, delivery_text = excluded.delivery_text, seller = excluded.seller,
      shop_rating = coalesce(excluded.shop_rating, kb_offers.shop_rating), shop_reviews = coalesce(excluded.shop_reviews, kb_offers.shop_reviews),
      pack_size = excluded.pack_size,
      last_seen_at = now(), gone = false
    returning id, offer_key`;
  const idByKey = new Map(saved.map((r) => [r.offer_key as string, r.id as string]));
  // Verlauf: bei Preisänderung und einmal pro Tag ein Stützpunkt
  let changes = 0;
  const hist = [];
  for (const r of rows) {
    const p = prev.get(r.offer_key);
    const changed = !p || Number(p.total) !== r.total;
    // mindestens ein Eintrag je Angebot und Kalendertag – sonst stimmt der Tagestiefstpreis im Diagramm nicht
    const stale = !p?.last_hist || berlinDay(new Date(p.last_hist)) !== berlinDay(new Date());
    if (changed && p) changes++;
    if (changed || stale) {
      hist.push({ product_id: l.product_id, user_id: l.user_id, offer_id: idByKey.get(r.offer_key) ?? null, series: 'offer',
        shop: r.shop, condition: r.condition, total: r.total, in_stock: r.in_stock, pack_size: r.pack_size });
    }
  }
  if (hist.length) await sql`insert into kb_price_history ${sql(hist)}`;
  // Angebote, die nicht mehr auftauchen, als verschwunden markieren
  await sql`update kb_offers set gone = true where listing_id = ${l.id} and not (offer_key = any(${rows.map((r) => r.offer_key)})) and not gone`;
  return { offers: rows.length, changes };
}

/** Preisverlauf vom Preisvergleich übernehmen (nur Tage, die noch fehlen; heute zählt die eigene Abfrage) */
async function importHistory(l: DueListing, hist: { date: string; price: number }[] | undefined) {
  if (!hist?.length) return;
  const sql = await db();
  const series = 'hist:' + l.source;
  const [{ last }] = await sql`select max((observed_at at time zone 'Europe/Berlin')::date)::text as last from kb_price_history
                               where product_id = ${l.product_id} and series = ${series} and shop = ${l.external_id}`;
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const rows = hist.filter((h) => h.date < today && (!last || h.date > last)).map((h) => ({
    product_id: l.product_id, user_id: l.user_id, series, shop: l.external_id, condition: 'new',
    observed_at: new Date(`${h.date}T12:00:00+01:00`), total: h.price, in_stock: null, pack_size: packSize(l.title) ?? 1,
  }));
  if (rows.length) await sql`insert into kb_price_history ${sql(rows)}`;
}

function berlinDay(d: Date) { return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }); }
