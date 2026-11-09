// Rückfall für Produkte, die keine Quelle findet (9.11.2026, z. B. „Zuriga E2“ – nur im Hersteller-Shop):
// Hersteller-Shop raten (marke.de / marke.com, folgt Weiterleitungen wie zuriga.de → zuriga.com/de/de), dort nach
// Produktlinks suchen, deren Linktext/Adresse zum gesuchten Produkt passt, und die Seiten wie jeden Shop überwachen.
import { createHash } from 'node:crypto';
import { fetchPage } from '../util/http.ts';
import { loadHtml, absUrl } from '../util/extract.ts';
import { matchTitle, type ProductQuery } from '../util/match.ts';
import { cleanText } from './common.ts';
import { parseShopPage } from './shops.ts';
import { fuzzyScore } from '../util/naming.ts';
import type { Candidate } from './types.ts';

const PRODUCT_PATH = /\/(products?|produkte?|p|artikel|shop|item|dp|kaufen|maschinen?)\//i;

function brandOf(q: ProductQuery): string | null {
  const b = (q.brand ?? q.name.split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z0-9äöü-]/g, '').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');
  return b.length >= 3 ? b : null;
}

/** Produktlinks einer Seite mit Linktext (oder Adress-Teil) als Titel */
export function productLinks(html: string, base: string): { url: string; title: string }[] {
  const $ = loadHtml(html);
  const host = new URL(base).host;
  const seen = new Map<string, string>();
  $('a[href]').each((_, a) => {
    const url = absUrl($(a).attr('href'), base)?.split(/[?#]/)[0];
    if (!url || !PRODUCT_PATH.test(new URL(url).pathname) || new URL(url).host !== host) return;
    const text = cleanText($(a).attr('title') || $(a).attr('aria-label') || $(a).text());
    const slug = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '').replace(/[-_]+/g, ' ');
    // Adress-Teil zuerst: Linktexte kleben oft zusammen („ZURIGA E2ohne Dampf“), „zuriga-e2“ ist eindeutig
    const title = /[a-z]/i.test(slug) && !/^[0-9a-f]{16,}$/i.test(slug) ? `${slug} ${text}`.slice(0, 160) : text.slice(0, 160);
    if (title.length >= 3 && (!seen.has(url) || seen.get(url)!.length < title.length)) seen.set(url, title);
  });
  // Produktadressen, die nur in eingebetteten Seitendaten stehen (z. B. Nuxt/Shopware: „products/zeeu412/zuriga-e2-s“)
  const raw = html.replace(/\\u002F/gi, '/');
  for (const m of raw.matchAll(/["'(\s]((?:https?:\/\/[^"'\s]+)?\/?(?:[a-z]{2}\/[a-z]{2}\/)?(?:products?|produkte?)\/[a-z0-9]+\/[a-z0-9-]{3,})["'\s)]/gi)) {
    const url = absUrl(m[1].startsWith('/') || m[1].startsWith('http') ? m[1] : '/' + m[1], base)?.split(/[?#]/)[0];
    if (!url || new URL(url).host !== host || seen.has(url)) continue;
    // relative Pfade ohne Sprachteil an den Sprachteil der Basis hängen (zuriga.com/de/de/…)
    seen.set(url, decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '').replace(/[-_]+/g, ' '));
  }
  return [...seen.entries()].map(([url, title]) => ({ url, title: withJoined(title) }));
}

/** „zuriga e2 s“ → zusätzlich „e2s“, damit eingetippte Schreibweisen ohne Bindestrich passen */
function withJoined(title: string): string {
  const t = title.split(/[\s-]+/).filter(Boolean);
  const joined = t.map((w, i) => (i > 0 && w.length <= 2 && /\d/.test(t[i - 1] + w) ? t[i - 1] + w : '')).filter(Boolean);
  return joined.length ? `${title} ${joined.join(' ')}` : title;
}

export interface MakerResult { cands: Candidate[]; suggestions: { title: string; url: string; source: string; price: number | null }[] }

/** Titel ist eine Variante mit Zusatz, der nicht gesucht wurde („Zuriga E2“ ≠ „ZURIGA E2-S“) */
function otherVariant(query: string, title: string): boolean {
  const toks = (x: string) => {
    const t = x.toLowerCase().split(/[\s,()/]+/).filter(Boolean);
    return t.map((w) => w.replace(/-/g, '')).concat(t.map((w, i) => (i > 0 && w.length <= 2 ? t[i - 1] + w : '')).filter(Boolean));
  };
  const qt = new Set(toks(query));
  return toks(title).some((w) => /\d/.test(w) && !qt.has(w) && [...qt].some((q) => /\d/.test(q) && q.length >= 2 && w.startsWith(q) && w.length <= q.length + 2));
}

function dedupe(list: { url: string; title: string }[]) {
  const m = new Map<string, string>();
  for (const l of list) if (!m.has(l.url) || m.get(l.url)!.length < l.title.length) m.set(l.url, l.title);
  return [...m.entries()].map(([url, title]) => ({ url, title }));
}

export async function makerShopCandidates(q: ProductQuery): Promise<MakerResult> {
  const brand = brandOf(q);
  if (!brand) return { cands: [], suggestions: [] };
  for (const domain of [`https://www.${brand}.de/`, `https://www.${brand}.com/`]) {
    let home;
    try { home = await fetchPage(domain, { country: 'DE', minDelayMs: 2000, retries: 0, timeoutMs: 15_000 }); } catch { continue; }
    if (home.status >= 400 || !home.text) continue;
    // Startseite + typische Übersichtsseiten
    const pages = [home];
    const $home = loadHtml(home.text);
    const homeUrl = home.url;
    const overview = productLinks(home.text, homeUrl).length < 5
      ? [...new Set($home('a[href]').map((_, a) => absUrl($home(a).attr('href'), homeUrl)).get()
          .filter((u): u is string => !!u && /\/(products|produkte|shop|sortiment|kollektion|maschinen)\/?$/i.test(u.split(/[?#]/)[0])))].slice(0, 2)
      : [];
    for (const u of overview) { try { pages.push(await fetchPage(u, { country: 'DE', minDelayMs: 2000, retries: 0 })); } catch { /* egal */ } }
    let links = dedupe(pages.flatMap((p) => productLinks(p.text, p.url)));
    // Eine Ebene tiefer: Produktseiten verweisen oft auf Varianten (E2 → E2-S), die auf der Startseite fehlen
    const prelim = links.map((l) => ({ ...l, s: Math.max(matchTitle(q, `${q.brand ?? brand} ${l.title}`).score, fuzzyScore(q.name, l.title)) }))
      .sort((a, b) => b.s - a.s).slice(0, 2);
    for (const l of prelim) {
      try { const pg = await fetchPage(l.url, { country: 'DE', minDelayMs: 2000, retries: 0 }); links = dedupe([...links, ...productLinks(pg.text, pg.url)]); }
      catch { /* egal */ }
    }
    const all = links.map((l) => ({ ...l, score: matchTitle(q, `${q.brand ?? brand} ${l.title}`).score })).sort((a, b) => b.score - a.score);
    const scored = all.filter((l) => l.score >= 0.6).slice(0, 4);
    // Nichts eindeutig (z. B. Tippfehler „E2s“): die ähnlichsten Produkte des Herstellers als Auswahl „Meinst du …?“
    const loose = scored.length ? [] : all.map((l) => ({ ...l, fuzzy: fuzzyScore(q.name, l.title) }))
      .filter((l) => l.fuzzy >= 0.4).sort((a, b) => b.fuzzy - a.fuzzy).slice(0, 5);
    const out: Candidate[] = [];
    const suggestions: MakerResult['suggestions'] = [];
    for (const l of loose) {
      try {
        const page = await fetchPage(l.url, { country: 'DE', minDelayMs: 2000, retries: 0 });
        const o = parseShopPage(page.text, page.url);
        if (o?.title) suggestions.push({ title: o.title, url: page.url, source: 'shop', price: o.price ?? null });
      } catch { /* Seite nicht lesbar */ }
    }
    for (const l of scored) {
      try {
        const page = await fetchPage(l.url, { country: 'DE', minDelayMs: 2000, retries: 0 });
        const o = parseShopPage(page.text, page.url);
        if (!o?.price) continue;
        if (otherVariant(q.name, o.title ?? l.title)) continue;
        const r = matchTitle(q, o.title ?? l.title);
        if (out.some((x) => x.title === (o.title ?? l.title) && x.price === o.price)) continue;   // gleiche Ausführung unter zweiter Adresse
        out.push({ externalId: createHash('md5').update(page.url).digest('hex'), url: page.url, title: o.title ?? l.title, country: 'DE',
                   price: o.price, score: Math.max(r.score, l.score), reason: 'Hersteller-Shop', condition: 'new' });
      } catch { /* Seite nicht lesbar */ }
    }
    if (out.length || links.length) return { cands: out, suggestions };   // Shop gefunden – die andere Endung nicht mehr probieren
  }
  return { cands: [], suggestions: [] };
}
