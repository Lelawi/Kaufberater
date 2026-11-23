// Als „nicht lieferbar“ gemeldete Angebote beobachten: Preisvergleiche zeigen oft noch Angebote, die beim Shop nicht
// mehr bestellbar sind (23.11.). Die Meldung bleibt bis zu 30 Tage stehen und wird früher aufgehoben, wenn sich etwas tut:
//  - Preis ändert sich spürbar (Shop hat das Angebot angefasst)
//  - Shop-Seite zeigte seit der Meldung „nicht auf Lager“ und jetzt wieder „auf Lager“
// Ist das Angebot danach das günstigste, gibt es eine Meldung „Wieder lieferbar?“.
import { db } from '../db.ts';
import { createAlert } from './alerts.ts';
import { fmtEur } from '../util/money.ts';

export interface Lifted { id: string; productId: string; reason: 'price' | 'stock' }

/** Spürbare Preisänderung: ≥ 1 % und ≥ 1 € */
function priceMoved(now: number, then: number): boolean {
  return Math.abs(now - then) >= Math.max(1, then * 0.01);
}

export async function liftRestocked(productId?: string): Promise<Lifted[]> {
  const sql = await db();
  const only = productId ? sql`and product_id = ${productId}` : sql``;
  // Neue Angebots-ID beim selben Händler zum gleichen Preis (Preisvergleiche vergeben IDs neu) → Meldung übernehmen
  await sql`
    update kb_offers n set disputed_total = o.disputed_total, disputed_at = o.disputed_at, disputed_reason = 'stock'
    from kb_offers o
    where n.listing_id = o.listing_id and n.shop = o.shop and n.condition = o.condition and n.id <> o.id
      and n.disputed_reason is null and not n.gone and n.first_seen_at > o.disputed_at
      and o.disputed_reason = 'stock' and o.disputed_at > now() - interval '30 days'
      and abs(n.total - o.disputed_total) < greatest(1, o.disputed_total * 0.01)
      ${productId ? sql`and n.product_id = ${productId}` : sql``}`;
  const rows = await sql`
    select id, product_id, total, disputed_total, disputed_out, in_stock from kb_offers
    where disputed_reason = 'stock' and not gone and last_seen_at > disputed_at ${only}`;
  const lifted: Lifted[] = [];
  for (const r of rows) {
    const reason = priceMoved(Number(r.total), Number(r.disputed_total)) ? 'price'
      : r.disputed_out && r.in_stock === true ? 'stock' : null;
    if (reason) lifted.push({ id: r.id, productId: r.product_id, reason });
  }
  if (lifted.length) {
    await sql`update kb_offers set disputed_total = null, disputed_at = null, disputed_reason = null, disputed_out = false
              where id = any(${lifted.map((l) => l.id)}::uuid[])`;
  }
  // Nach 30 Tagen ohne Lebenszeichen still aufheben (zählt dann wieder normal)
  await sql`update kb_offers set disputed_total = null, disputed_at = null, disputed_reason = null, disputed_out = false
            where disputed_reason = 'stock' and disputed_at < now() - interval '30 days' ${only}`;
  return lifted;
}

/** Nach der Bewertung: aufgehobene Angebote, die jetzt Bestpreis sind, melden */
export async function announceRestocked(lifted: Lifted[]): Promise<number> {
  if (!lifted.length) return 0;
  const sql = await db();
  const rows = await sql`
    select o.id, o.product_id, o.shop, o.url, coalesce(o.effective_total, o.total) as price, p.user_id
    from kb_offers o join kb_products p on p.id = o.product_id
    where o.id = any(${lifted.map((l) => l.id)}::uuid[]) and p.best_offer_id = o.id and p.status = 'watching'`;
  let n = 0;
  for (const r of rows) {
    const why = lifted.find((l) => l.id === r.id)?.reason === 'stock' ? 'Der Shop meldet wieder „auf Lager“' : 'Der Preis hat sich geändert – vermutlich wieder bestellbar';
    n += await createAlert({
      userId: r.user_id, productId: r.product_id, kind: 'threshold', level: 'good',
      title: `Wieder lieferbar? ${r.shop} ${fmtEur(Number(r.price))}`,
      body: `Als nicht lieferbar gemeldet, jetzt wieder günstigstes Angebot. ${why}.`,
      url: r.url, dedupKey: `restock:${r.id}:${Math.round(Number(r.price))}`,
      data: { price: Number(r.price), shop: r.shop },
    });
  }
  return n;
}
