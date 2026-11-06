import { db } from '../db.ts';

/**
 * Ergebnis einer Quelle festhalten.
 * Sperre (blocked_until) nur, wenn `block` gesetzt ist (Standard: Fehlertext enthält „blockiert“).
 * Die Pause wächst mit der Dauer der Störung: halbe Zeit seit dem letzten Erfolg, mindestens 30 Min., höchstens 6 Std.
 * So wird eine dauerhaft sperrende Seite nicht jede Stunde erneut angefragt (was Sperren eher verlängert),
 * kommt aber nach dem Aufheben der Sperre spätestens nach 6 Stunden wieder dran.
 */
export async function recordSourceResult(source: string, ok: boolean, error?: string, opts: { block?: boolean } = {}) {
  const sql = await db();
  if (ok) {
    await sql`insert into kb_source_health (source, last_ok_at, ok_count) values (${source}, now(), 1)
      on conflict (source) do update set last_ok_at = now(), ok_count = kb_source_health.ok_count + 1, blocked_until = null`;
  } else {
    const blocked = opts.block ?? /blockiert/.test(error ?? '');
    await sql`insert into kb_source_health (source, last_error_at, last_error, error_count, blocked_until)
      values (${source}, now(), ${error?.slice(0, 500) ?? null}, 1, ${blocked ? sql`now() + interval '30 minutes'` : null})
      on conflict (source) do update set last_error_at = now(), last_error = excluded.last_error,
        error_count = kb_source_health.error_count + 1,
        blocked_until = case when ${blocked}
          then now() + least(interval '6 hours', greatest(interval '30 minutes', (now() - coalesce(kb_source_health.last_ok_at, now())) / 2))
          else kb_source_health.blocked_until end`;
  }
}

export async function blockedSources(): Promise<Set<string>> {
  const sql = await db();
  const rows = await sql`select source from kb_source_health where blocked_until > now()`;
  return new Set(rows.map((r) => r.source as string));
}
