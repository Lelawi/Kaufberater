import postgres from 'postgres';
const pw = process.env.KB_DB_PASSWORD!;
const ref = 'obxwqvmmirmbfktjvhxf';
for (const host of ['aws-1-eu-central-1.pooler.supabase.com', 'aws-0-eu-central-1.pooler.supabase.com']) {
  for (const port of [5432, 6543]) {
    const sql = postgres({ host, port, database: 'postgres', username: `kb_worker.${ref}`, password: pw, ssl: 'require', max: 1, connect_timeout: 10, prepare: port === 5432 });
    try {
      const r = await sql`select current_user as u, now() as t`;
      console.log('OK', host, port, r[0]);
      await sql`insert into kb_runs (kind, stats) values ('dbtest', ${sql.json({ host, port })})`;
    } catch (e) { console.log('FAIL', host, port, (e as Error).message); }
    await sql.end({ timeout: 2 });
  }
}
