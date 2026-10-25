// Preistendenz aus dem eigenen Verlauf: Steigen die Preise seit Monaten (z. B. wiederholte Preiserhöhungen),
// lohnt Warten meist nicht – dann sollen Schwellen und Empfehlung das berücksichtigen.
import { db } from '../db.ts';

export interface Trend { trend: 'rising' | 'falling' | 'stable'; pct: number; days: number }

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Tagestiefstpreise (Neuware) → Tendenz. Vergleicht den Median der letzten 30 Tage mit dem Median von vor 90–180 Tagen
 * (Ausreißer-Tage mit kurzen Deals zählen so kaum). Braucht Daten über mindestens 90 Tage.
 */
export function computeTrend(points: { day: string; price: number }[], today = new Date()): Trend | null {
  if (points.length < 20) return null;
  const age = (d: string) => (Number(today) - Number(new Date(d + 'T12:00:00Z'))) / 864e5;
  const recent = points.filter((p) => age(p.day) <= 30).map((p) => p.price);
  const old = points.filter((p) => age(p.day) >= 90 && age(p.day) <= 180).map((p) => p.price);
  if (recent.length < 5 || old.length < 10) return null;
  const pct = Math.round(((median(recent) - median(old)) / median(old)) * 1000) / 10;
  const days = Math.round(Math.max(...points.map((p) => age(p.day))));
  return { trend: pct >= 5 ? 'rising' : pct <= -5 ? 'falling' : 'stable', pct, days: Math.min(days, 180) };
}

export async function runTrends(opts: { productId?: string } = {}) {
  const sql = await db();
  const products = await sql`select id, quantity from kb_products where status = 'watching'
                             and (${opts.productId ?? null}::uuid is null or id = ${opts.productId ?? null}::uuid)`;
  let set = 0;
  for (const p of products) {
    const rows = await sql`select day::text as day, min_new as price from kb_price_series(${p.id}, 200) where min_new is not null`;
    const t = computeTrend(rows.map((r) => ({ day: r.day as string, price: Number(r.price) })));
    await sql`update kb_products set price_trend = ${t?.trend ?? null}, price_trend_pct = ${t?.pct ?? null}, price_trend_days = ${t?.days ?? null}
              where id = ${p.id} and (price_trend is distinct from ${t?.trend ?? null} or price_trend_pct is distinct from ${t?.pct ?? null}::numeric)`;
    if (t) set++;
  }
  return { set };
}
