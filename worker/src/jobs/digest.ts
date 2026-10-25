// Wochenüberblick am Sonntagabend: je Produkt aktueller Preis, Entwicklung zur Vorwoche und Abstand zur Schwelle „gut“.
// Die Push-Nachricht ist nur eine kurze Zusammenfassung; die App zeigt die Liste übersichtlich (kb_alerts.data).
import { db } from '../db.ts';
import { createAlert } from './alerts.ts';
import { nextShoppingEvent } from '../util/events.ts';

export interface DigestItem {
  id: string; name: string; image: string | null; quantity: number;
  price: number; before: number | null; diff: number | null;
  level: 'instant' | 'top' | 'good' | 'wait' | null; good: number | null; gap: number | null;
}

function levelOf(price: number, p: { threshold_instant: number | null; threshold_top: number | null; threshold_good: number | null; max_price: number | null; quantity: number }): DigestItem['level'] {
  const maxUnit = p.max_price ? p.max_price / Math.max(1, p.quantity) : null;
  const good = p.threshold_good ?? maxUnit;
  if (p.threshold_instant && price <= p.threshold_instant) return 'instant';
  if (p.threshold_top && price <= p.threshold_top) return 'top';
  if (good && price <= good) return 'good';
  return good ? 'wait' : null;
}

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
      select p.id, p.name, p.image_url, p.quantity, p.best_price, p.threshold_good, p.threshold_top, p.threshold_instant, p.max_price,
        (select min(h.total / case when p.quantity > 1 then h.pack_size else 1 end) from kb_price_history h
          where h.product_id = p.id and h.series = 'offer' and h.condition = 'new'
            and h.observed_at between now() - interval '8 days' and now() - interval '6 days') as before
      from kb_products p where p.user_id = ${u.user_id} and p.status = 'watching' and p.best_price is not null
      order by p.name`;
    if (!rows.length) continue;
    const items: DigestItem[] = rows.map((r) => {
      const price = Number(r.best_price);
      const before = r.before != null ? Math.round(Number(r.before) * 100) / 100 : null;
      const diff = before != null ? Math.round((price - before) * 100) / 100 : null;
      const good = r.threshold_good != null ? Number(r.threshold_good) : null;
      return {
        id: r.id, name: r.name, image: r.image_url ?? null, quantity: Number(r.quantity ?? 1), price, before, diff,
        level: levelOf(price, r as any), good, gap: good != null ? Math.round((price - good) * 100) / 100 : null,
      };
    });
    // Reihenfolge: Kaufsignale zuerst, dann günstiger geworden, dann der Rest
    const rank = (i: DigestItem) => (i.level === 'instant' ? 0 : i.level === 'top' ? 1 : i.level === 'good' ? 2 : 3);
    items.sort((a, b) => rank(a) - rank(b) || (a.diff ?? 0) - (b.diff ?? 0));
    const down = items.filter((i) => (i.diff ?? 0) <= -1).length;
    const up = items.filter((i) => (i.diff ?? 0) >= 1).length;
    const buy = items.filter((i) => i.level && i.level !== 'wait').length;
    const parts = [
      buy ? `${buy}× Kaufpreis erreicht` : null,
      down ? `↓ ${down} günstiger` : null,
      up ? `↑ ${up} teurer` : null,
      !down && !up ? 'Preise kaum verändert' : null,
      ev ? `${ev.name} in ${ev.days} Tagen` : null,
    ].filter(Boolean);
    sent += await createAlert({
      userId: u.user_id, productId: null, kind: 'digest', level: 'info',
      title: `Dein Wochenüberblick (${items.length} Produkte)`,
      body: parts.join(' · '),
      data: { items, event: ev ? { name: ev.name, days: ev.days, date: ev.date.toISOString().slice(0, 10) } : null },
      dedupKey: `digest:${week}`,
    });
  }
  return { sent };
}
