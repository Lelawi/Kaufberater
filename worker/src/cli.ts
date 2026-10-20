// Einstiegspunkt: node worker/src/cli.ts <befehl> [argument]
import { closeDb, db, debugLog } from './db.ts';
import { fetchPage } from './util/http.ts';

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
    try {
      const p = await fetchPage(r.url, { country: r.country, headers: r.headers, method: r.method, body: r.body, json: r.json, retries: 0, allowStatus: [400, 401, 403, 404, 410, 429, 500, 503] });
      const hdr: Record<string, string> = {};
      p.headers.forEach((v, k) => { hdr[k] = v; });
      await debugLog(tag, { url: r.url, status: p.status, finalUrl: p.url, headers: hdr, body: p.text });
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
        await debugLog(tag, { url, status: p.status, finalUrl: p.url, body: p.html, headers: { captured: p.json.slice(0, 20) } });
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
