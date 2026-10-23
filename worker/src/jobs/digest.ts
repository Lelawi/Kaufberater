// Wochenüberblick am Sonntagabend: Preisentwicklung jedes Produkts und der nächste große Aktionstag
import { db } from '../db.ts';
import { createAlert } from './alerts.ts';
import { fmtEur } from '../util/money.ts';
import { nextShoppingEvent } from '../util/events.ts';

export async function runDigest(force = false) {
  const now = new Date();
  const berlin = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  if (!force && !(berlin.getDay() === 0 && berlin.getHours() >= 17)) return { sent: 0 };
  const sql = await db();
  const week = `${berlin.getFullYear()}-${Math.ceil((+berlin - +new Date(berlin.getFullYear(), 0, 1)) / 6048e5)}`;
  const users = await sql`select distinct user_id from kb_products where status = 'watching'`;
  let sent = 0;
  const ev = nextShoppingEvent(now);
  for (const u of users) {
    const rows = await sql`
      select p.name, p.best_price, p.threshold_good, p.quantity,
        (select min(h.total / case when p.quantity > 1 then h.pack_size else 1 end) from kb_price_history h where h.product_id = p.id and h.series = 'offer' and h.condition = 'new'
           and h.observed_at between now() - interval '8 days' and now() - interval '6 days') as before
      from kb_products p where p.user_id = ${u.user_id} and p.status = 'watching' and p.best_price is not null
      order by p.name`;
    if (!rows.length) continue;
    const lines = rows.slice(0, 8).map((r) => {
      const diff = r.before ? r.best_price - r.before : null;
      const trend = diff === null ? '' : diff < -1 ? ` (↓ ${fmtEur(-diff)})` : diff > 1 ? ` (↑ ${fmtEur(diff)})` : ' (unverändert)';
      const gap = r.threshold_good && r.best_price > r.threshold_good ? `, noch ${fmtEur(r.best_price - r.threshold_good)} bis „gut“` : r.threshold_good ? ', unter „gut“!' : '';
      return `${r.name}: ${fmtEur(r.best_price)}${r.quantity > 1 ? '/Stück' : ''}${trend}${gap}`;
    });
    const n = await createAlert({
      userId: u.user_id, productId: null, kind: 'system', level: 'info',
      title: 'Dein Wochenüberblick',
      body: lines.join(' · ') + (ev ? ` – Nächster Aktionstag: ${ev.name} in ${ev.days} Tagen.` : ''),
      dedupKey: `digest:${week}`,
    });
    sent += n;
  }
  return { sent };
}
