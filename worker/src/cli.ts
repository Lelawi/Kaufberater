// Einstiegspunkt: node worker/src/cli.ts <befehl> [argument]
import { closeDb, db, debugLog } from './db.ts';
import { fetchPage } from './util/http.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

/** Rohseiten zusätzlich als Dateien ablegen (werden vom Workflow in den Branch 'dumps' geschoben) */
let dumpNo = 0;
function dump(tag: string, url: string, body: string, meta: unknown) {
  mkdirSync(`dumps/${tag}`, { recursive: true });
  const name = String(++dumpNo).padStart(3, '0') + '_' + url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.]+/g, '_').slice(0, 80);
  writeFileSync(`dumps/${tag}/${name}.html`, body);
  writeFileSync(`dumps/${tag}/${name}.json`, JSON.stringify({ url, ...(meta as object) }, null, 1));
}

const [cmd = 'run', arg = ''] = process.argv.slice(2);

async function explore(arg: string) {
  // arg: "tag|url1 url2 ..." oder JSON [{url, country, headers, method, body}]
  let tag = 'explore';
  let reqs: { url: string; country?: string; headers?: Record<string, string>; method?: string; body?: string; json?: boolean }[] = [];
  const trimmed = arg.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) reqs = parsed; else { tag = parsed.tag ?? tag; reqs = parsed.requests; }
  } else {
    const [t, rest] = trimmed.includes('|') ? trimmed.split('|', 2) : ['explore', trimmed];
    tag = t;
    reqs = rest.split(/\s+/).filter(Boolean).map((url) => ({ url }));
  }
  for (const r of reqs) {
    if (/\.(woff2|png|jpg|webp|gz|zip)(\?|$)/.test(r.url)) {
      // Binärdateien unverändert ablegen
      const res = await fetch(r.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' } });
      mkdirSync(`dumps/${tag}`, { recursive: true });
      writeFileSync(`dumps/${tag}/${r.url.split('/').pop()!.split('?')[0]}`, Buffer.from(await res.arrayBuffer()));
      console.log('BIN', res.status, r.url);
      continue;
    }
    try {
      const p = await fetchPage(r.url, { country: r.country, headers: r.headers, method: r.method, body: r.body, json: r.json, retries: 0, allowStatus: [400, 401, 403, 404, 410, 429, 500, 503] });
      const hdr: Record<string, string> = {};
      p.headers.forEach((v, k) => { hdr[k] = v; });
      dump(tag, r.url, p.text, { status: p.status, finalUrl: p.url, headers: hdr });
      await debugLog(tag, { url: r.url, status: p.status, finalUrl: p.url, headers: hdr, body: p.text.slice(0, 200_000) });
      console.log('OK', p.status, r.url, p.text.length);
    } catch (e) {
      await debugLog(tag, { url: r.url, note: `FEHLER: ${(e as Error).message}` });
      console.log('FEHLER', r.url, (e as Error).message);
    }
  }
}

async function browseExplore(arg: string) {
  const { browse, closeBrowser } = await import('./util/browser.ts');
  const [tag, rest] = arg.includes('|') ? arg.split('|', 2) : ['browse', arg];
  try {
    for (const url of rest.split(/\s+/).filter(Boolean)) {
      try {
        const country = /amazon\.(fr|it|es|nl)/.exec(url)?.[1]?.toUpperCase() ?? 'DE';
        const p = await browse(url, { country, captureRe: /api|graphql|search|offer|price/i });
        dump(tag, url, p.html, { status: p.status, finalUrl: p.url, captured: p.json.slice(0, 30) });
        await debugLog(tag, { url, status: p.status, finalUrl: p.url, body: p.html.slice(0, 200_000) });
        console.log('::notice::OK ' + p.status + ' ' + url + ' ' + p.html.length);
      } catch (e) {
        await debugLog(tag, { url, note: `FEHLER: ${(e as Error).message}` });
        console.log('::warning::FEHLER ' + url + ' ' + (e as Error).message);
      }
    }
  } finally { await closeBrowser(); }
}

async function main() {
  const started = Date.now();
  try {
    switch (cmd) {
      case 'explore': await explore(arg); break;
      case 'browse': await browseExplore(arg); break;
      case 'run': { const { runAll } = await import('./run.ts'); await runAll(arg); break; }
      case 'adapter': { const { testAdapter } = await import('./devtools.ts'); await testAdapter(arg); break; }
      case 'deals': { const { testDeals } = await import('./devtools.ts'); await testDeals(arg); break; }
      case 'homecheck': {
        // Wenn der Raspberry Pi in den letzten 30 Minuten gelaufen ist, macht GitHub Pause (spart Freiminuten)
        const sql = await db();
        const r = await sql`select 1 from kb_runs where kind like 'run:%:home' and finished_at > now() - interval '30 minutes' limit 1`;
        const { appendFileSync } = await import('node:fs');
        if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip=${r.length > 0}\n`);
        console.log('Heim-Rechner aktiv:', r.length > 0);
        break;
      }
      default: throw new Error(`Unbekannter Befehl: ${cmd}`);
    }
  } catch (e) {
    console.error(e);
    try {
      const sql = await db();
      await sql`insert into kb_runs (kind, finished_at, error) values (${'cli:' + cmd}, now(), ${String((e as Error).stack ?? e).slice(0, 4000)})`;
    } catch { /* ignorieren */ }
    process.exitCode = 1;
  } finally {
    console.log(`fertig nach ${Math.round((Date.now() - started) / 1000)}s`);
    await closeDb();
  }
}

await main();
