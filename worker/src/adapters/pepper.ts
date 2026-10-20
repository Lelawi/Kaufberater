// Deal-Portale des Pepper-Netzwerks (gleiche Technik): mydealz (DE), preisjaeger (AT), dealabs (FR),
// chollometro (ES), pepper.it (IT), pepper.pl (PL). Liefern auch abgelaufene Deals → Preisgeschichte.
import { fetchPage } from '../util/http.ts';
import { loadHtml } from '../util/extract.ts';
import { matchTitle, norm, type ProductQuery } from '../util/match.ts';
import type { DealAdapter, DealData } from './types.ts';

interface Portal { key: string; label: string; host: string; country: string }
const PORTALS: Portal[] = [
  { key: 'mydealz', label: 'mydealz', host: 'www.mydealz.de', country: 'DE' },
  { key: 'preisjaeger', label: 'Preisjäger', host: 'www.preisjaeger.at', country: 'AT' },
  { key: 'dealabs', label: 'Dealabs', host: 'www.dealabs.com', country: 'FR' },
  { key: 'chollometro', label: 'Chollometro', host: 'www.chollometro.com', country: 'ES' },
  { key: 'pepperit', label: 'Pepper.it', host: 'www.pepper.it', country: 'IT' },
];

/** Händler im Ausland, die verlässlich nach Deutschland liefern */
const SHIPS_TO_DE = ['amazon', 'ebay', 'ldlc', 'pccomponentes', 'galaxus', 'digitec', 'alza', 'coolblue', 'bol', 'notebooksbilliger', 'cyberport', 'proshop', 'lg', 'samsung', 'apple', 'dyson', 'aliexpress', 'otto', 'mediamarkt', 'saturn'];

export function shipsToDE(portalCountry: string, merchant: string | null | undefined, title: string): boolean {
  if (portalCountry === 'DE' || portalCountry === 'AT') return true;
  const m = norm(merchant ?? '').toLowerCase();
  if (!m) return /amazon/i.test(title);
  return SHIPS_TO_DE.some((s) => m === s || m.startsWith(s));
}

export function parsePepperList(html: string, portal: Portal): DealData[] {
  const $ = loadHtml(html);
  const out: DealData[] = [];
  $('[data-vue3]').each((_, el) => {
    let d: any;
    try { d = JSON.parse($(el).attr('data-vue3')!); } catch { return; }
    const t = d?.props?.thread;
    if (!t?.threadId || out.some((x) => x.externalId === t.threadId)) return;
    if (t.type && t.type !== 'Deal' && t.type !== 'Voucher') return;
    out.push({
      portal: portal.key,
      externalId: String(t.threadId),
      title: String(t.title ?? ''),
      url: `https://${portal.host}/deals/${t.titleSlug ?? 'x'}-${t.threadId}`,
      merchant: t.merchant?.merchantName ?? t.linkHost ?? null,
      price: typeof t.price === 'number' && t.price > 0 ? t.price : null,
      nextBestPrice: typeof t.nextBestPrice === 'number' && t.nextBestPrice > 0 ? t.nextBestPrice : null,
      temperature: typeof t.temperature === 'number' ? t.temperature : null,
      commentCount: t.commentCount ?? null,
      postedAt: t.publishedAt ? new Date(t.publishedAt * 1000) : null,
      expired: !!t.isExpired,
      voucherCode: t.voucherCode || null,
    });
  });
  return out;
}

/** Suchbegriffe: volle Modellnummer, Kurzform ohne Präfix, Name */
export function dealQueries(q: ProductQuery): string[] {
  const qs = new Set<string>();
  if (q.model) {
    qs.add(q.model);
    const short = q.model.replace(/^(OLED|QLED|UE|GQ|QE|KD|XR|TX|KQ)/i, '');
    if (short.length >= 4 && short !== q.model) qs.add(short);
  }
  for (const t of (q.terms ?? []).slice(0, 2)) qs.add(t);
  if (qs.size < 3) qs.add(q.name);
  return [...qs].slice(0, 3);
}

function makeAdapter(portal: Portal): DealAdapter {
  return {
    key: portal.key, label: portal.label, country: portal.country,
    async search(q: ProductQuery) {
      const found = new Map<string, DealData & { score: number; reason: string }>();
      for (const term of dealQueries(q)) {
        const p = await fetchPage(`https://${portal.host}/search?q=${encodeURIComponent(term)}`, { country: portal.country, minDelayMs: 4000 });
        for (const d of parsePepperList(p.text, portal)) {
          const r = matchTitle(q, d.title);
          if (r.score < 0.7) continue;
          if (!shipsToDE(portal.country, d.merchant, d.title)) (d as any).foreign = true;
          found.set(d.externalId, { ...d, score: r.score, reason: r.reason });
        }
      }
      return [...found.values()];
    },
  };
}

export const pepperAdapters: DealAdapter[] = PORTALS.map(makeAdapter);
export { PORTALS };
