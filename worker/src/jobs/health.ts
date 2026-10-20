import { db } from '../db.ts';

export async function recordSourceResult(source: string, ok: boolean, error?: string) {
  const sql = await db();
  if (ok) {
    await sql`insert into kb_source_health (source, last_ok_at, ok_count) values (${source}, now(), 1)
      on conflict (source) do update set last_ok_at = now(), ok_count = kb_source_health.ok_count + 1, blocked_until = null`;
  } else {
    const blocked = /blockiert/.test(error ?? '');
    await sql`insert into kb_source_health (source, last_error_at, last_error, error_count, blocked_until)
      values (${source}, now(), ${error?.slice(0, 500) ?? null}, 1, ${blocked ? sql`now() + interval '30 minutes'` : null})
      on conflict (source) do update set last_error_at = now(), last_error = excluded.last_error,
        error_count = kb_source_health.error_count + 1,
        blocked_until = case when ${blocked} then now() + interval '30 minutes' else kb_source_health.blocked_until end`;
  }
}

export async function blockedSources(): Promise<Set<string>> {
  const sql = await db();
  const rows = await sql`select source from kb_source_health where blocked_until > now()`;
  return new Set(rows.map((r) => r.source as string));
}
