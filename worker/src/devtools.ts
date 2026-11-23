// Entwicklungs-Werkzeuge: einzelne Quellen testen, ohne etwas zu speichern
import { SOURCES, DEAL_SOURCES } from './adapters/registry.ts';
import { matchTitle } from './util/match.ts';

/** arg: JSON {source, query:{name,model,brand,terms}, fetch?:boolean} */
export async function testAdapter(arg: string) {
  const a = JSON.parse(arg);
  for (const s of SOURCES.filter((x) => !a.source || a.source.split(',').includes(x.key))) {
    try {
      const c = s.search ? await s.search(a.query) : [];
      const good = c.filter((x) => x.score >= 0.75).sort((x, y) => y.score - x.score);
      console.log(`::notice::${s.key}: ${c.length} Treffer, ${good.length} passend: ` + good.slice(0, 4).map((x) => `${x.score.toFixed(2)} ${x.title.slice(0, 50)} [${x.externalId}]`).join(' | '));
      if (a.fetch && good[0]) {
        console.log(`::notice::${s.key} hole ${good[0].url}`);
        const offers = await s.fetch({ id: 't', source: s.key, country: good[0].country, external_id: good[0].externalId, url: good[0].url, condition: good[0].condition ?? 'new', title: good[0].title }, a.query);
        console.log(`::notice::${s.key} Angebote: ` + offers.slice(0, 8).map((o) => `${o.shop} ${o.price}+${o.shipping ?? '?'} ${o.condition}`).join(' | '));
      }
    } catch (e) { console.log(`::warning::${s.key}: ${(e as Error).message}`); }
  }
}

/** arg: Listing-ID (CHECK24) – Angebotsfelder + Klick-Ziel des günstigsten Angebots in kb_debug (nichts ins öffentliche Log) */
export async function probeCheck24(arg: string) {
  const { db, debugLog } = await import('./db.ts');
  const { fetchPage } = await import('./util/http.ts');
  const sql = await db();
  const [l] = await sql`select url from kb_listings where id = ${arg} and source = 'check24'`;
  if (!l) { console.log('::warning::kein CHECK24-Eintrag'); return; }
  const p = await fetchPage(l.url, { minDelayMs: 3500 });
  await debugLog('c24probe-page', { url: l.url, status: p.status, body: p.text });
  const parts: string[] = [];
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p.text))) { try { parts.push(JSON.parse(`"${m[1]}"`)); } catch { /* */ } }
  const flight = parts.join('');
  const i = flight.indexOf('"initialExtended":');
  const start = flight.indexOf('{', i);
  let depth = 0, inStr = false, esc = false, ext: any = null;
  for (let k = start; k >= 0 && k < flight.length; k++) {
    const c = flight[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { ext = JSON.parse(flight.slice(start, k + 1)); } catch { /* */ } break; } }
  }
  const offers: any[] = (ext?.offers ?? []).filter((o: any) => typeof o.price === 'number').sort((a: any, b: any) => a.price - b.price);
  const note: Record<string, unknown> = { keys: Object.keys(offers[0] ?? {}), first: offers[0] ?? null };
  const link = offers[0] && Object.values(offers[0]).find((v) => typeof v === 'string' && /^https?:\/\/|^\//.test(v) && /click|redirect|out|deeplink|go/i.test(v));
  if (typeof link === 'string') {
    try {
      const t = await fetchPage(new URL(link, l.url).toString(), { minDelayMs: 3500 });
      note.final = t.url; note.status = t.status; note.avail = (t.text.match(/schema\.org\/(InStock|OutOfStock|PreOrder|BackOrder|SoldOut|Discontinued|LimitedAvailability)/g) ?? []).slice(0, 5);
      await debugLog('c24probe-shop', { url: t.url, status: t.status, body: t.text.slice(0, 400_000) });
    } catch (e) { note.err = (e as Error).message; }
  }
  await debugLog('c24probe', { url: l.url, note: JSON.stringify(note).slice(0, 20_000) });
  console.log(`::notice::probe: ${offers.length} Angebote, Felder ${(note.keys as string[]).length}, Klick ${link ? 'ja' : 'nein'}`);
}

export async function testDeals(arg: string) {
  const a = JSON.parse(arg);
  for (const d of DEAL_SOURCES.filter((x) => !a.portal || a.portal.split(',').includes(x.key))) {
    try {
      const r = await d.search(a.query);
      console.log(`::notice::${d.key}: ${r.length} Deals: ` + r.slice(0, 6).map((x: any) => `${x.price ?? '?'}€ ${x.merchant ?? ''} ${x.expired ? '(abgelaufen)' : ''} ${x.title.slice(0, 40)}`).join(' | '));
    } catch (e) { console.log(`::warning::${d.key}: ${(e as Error).message}`); }
  }
  void matchTitle;
}
