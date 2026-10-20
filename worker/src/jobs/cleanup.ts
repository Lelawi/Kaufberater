import { db } from '../db.ts';

/** Aufräumen: Debug-Daten, alte Läufe, sehr alte Benachrichtigungen; Preisverlauf ausdünnen */
export async function cleanup() {
  const sql = await db();
  const a = await sql`delete from kb_debug where created_at < now() - interval '2 days'`;
  const b = await sql`delete from kb_runs where started_at < now() - interval '14 days'`;
  const c = await sql`delete from kb_alerts where created_at < now() - interval '180 days' and read_at is not null`;
  // Verlauf älter als 60 Tage: nur ein Punkt pro Angebot und Tag behalten (der niedrigste)
  const d = await sql`
    delete from kb_price_history h using (
      select id, row_number() over (partition by product_id, coalesce(offer_id::text, series), date_trunc('day', observed_at) order by total, id) as rn
      from kb_price_history where observed_at < now() - interval '60 days' and series = 'offer'
    ) x where h.id = x.id and x.rn > 1`;
  return { debug: a.count, runs: b.count, alerts: c.count, history: d.count };
}
