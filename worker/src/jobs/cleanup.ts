import { db } from '../db.ts';
import { createAlert } from './alerts.ts';
import { IS_HOME } from '../adapters/registry.ts';

/** Aufräumen: Debug-Daten, alte Läufe, sehr alte Benachrichtigungen; Preisverlauf ausdünnen */
export async function cleanup() {
  const sql = await db();
  const a = await sql`delete from kb_debug where created_at < now() - interval '2 days'`;
  const b = await sql`delete from kb_runs where started_at < now() - interval '40 days'`;
  const c = await sql`delete from kb_alerts where created_at < now() - interval '180 days' and read_at is not null`;
  // Verlauf älter als 60 Tage: nur ein Punkt pro Angebot und Tag behalten (der niedrigste)
  const d = await sql`
    delete from kb_price_history h using (
      select id, row_number() over (partition by product_id, coalesce(offer_id::text, series), date_trunc('day', observed_at) order by total, id) as rn
      from kb_price_history where observed_at < now() - interval '60 days' and series = 'offer'
    ) x where h.id = x.id and x.rn > 1`;
  const broken = await healthAlerts();
  return { debug: a.count, runs: b.count, alerts: c.count, history: d.count, broken };
}

/** Meldet, wenn eine Quelle seit über einem Tag nicht mehr funktioniert (z. B. weil eine Webseite umgebaut wurde) */
async function healthAlerts() {
  const sql = await db();
  const homeOnly = ['amazon', 'amazon_fr', 'amazon_it', 'amazon_es', 'amazon_nl', 'geizhals'];
  const bad = await sql`select source, last_ok_at, last_error from kb_source_health
    where last_error_at > now() - interval '6 hours' and (last_ok_at is null or last_ok_at < now() - interval '24 hours')
      and ok_count + error_count > 3`;
  const relevant = bad.filter((b) => IS_HOME || !homeOnly.includes(b.source as string));
  if (!relevant.length) return 0;
  const users = await sql`select distinct user_id from kb_products where status = 'watching'`;
  const day = new Date().toISOString().slice(0, 10);
  for (const u of users) {
    await createAlert({
      userId: u.user_id, productId: null, kind: 'system', level: 'warning',
      title: `Quelle gestört: ${relevant.map((r) => r.source).join(', ')}`,
      body: `Seit über einem Tag keine Daten (${String(relevant[0].last_error ?? '').slice(0, 120)}). Vermutlich hat die Webseite ihren Aufbau geändert – die anderen Quellen laufen weiter.`,
      dedupKey: `health:${relevant.map((r) => r.source).join(',')}:${day}`,
    });
  }
  return relevant.length;
}
