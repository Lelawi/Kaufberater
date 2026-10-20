// Datenbankverbindung (Supabase-Pooler, eingeschränkter Benutzer kb_worker)
import postgres from 'postgres';

const REF = 'obxwqvmmirmbfktjvhxf';
const HOSTS = ['aws-1-eu-central-1.pooler.supabase.com', 'aws-0-eu-central-1.pooler.supabase.com'];

export type Sql = postgres.Sql<{}>;

let sqlInstance: Sql | null = null;

export async function db(): Promise<Sql> {
  if (sqlInstance) return sqlInstance;
  const password = process.env.KB_DB_PASSWORD;
  if (!password) throw new Error('KB_DB_PASSWORD fehlt');
  const hosts = process.env.KB_DB_HOST ? [process.env.KB_DB_HOST] : HOSTS;
  let lastErr: unknown;
  for (const host of hosts) {
    const sql = postgres({
      host, port: 5432, database: 'postgres', username: `kb_worker.${REF}`, password,
      ssl: 'require', max: 4, connect_timeout: 15, idle_timeout: 20,
      onnotice: () => {},
      types: { numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) } } as any,
    });
    try {
      await sql`select 1`;
      sqlInstance = sql;
      return sql;
    } catch (e) {
      lastErr = e;
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  }
  throw lastErr;
}

export async function closeDb() {
  if (sqlInstance) await sqlInstance.end({ timeout: 5 });
  sqlInstance = null;
}

const configCache = new Map<string, string>();
export async function workerConfig(key: string): Promise<string | undefined> {
  if (configCache.has(key)) return configCache.get(key);
  const sql = await db();
  const rows = await sql`select value from kb_worker_config where key = ${key}`;
  const v = rows[0]?.value as string | undefined;
  if (v !== undefined) configCache.set(key, v);
  return v;
}

/** Schreibt Rohdaten zur Fehlersuche in kb_debug (wird regelmäßig aufgeräumt). */
export async function debugLog(tag: string, data: { url?: string; status?: number; finalUrl?: string; headers?: unknown; body?: string; note?: string }) {
  try {
    const sql = await db();
    await sql`insert into kb_debug (tag, url, status, final_url, headers, body, note)
      values (${tag}, ${data.url ?? null}, ${data.status ?? null}, ${data.finalUrl ?? null},
              ${data.headers ? sql.json(data.headers as any) : null}, ${data.body?.slice(0, 3_000_000) ?? null}, ${data.note ?? null})`;
  } catch (e) {
    console.log('debugLog fehlgeschlagen', (e as Error).message);
  }
}
