// Prospekt-Angebote aller Ketten über Marktguru (9.11.2026): Lidl, Aldi, Kaufland, MediaMarkt, Saturn, Penny, Netto, Norma,
// dm, Rossmann … – dort tauchen Technik-Aktionen auf, die die Preisvergleiche nicht kennen (Lidl-/Aldi-Technik, Prospektpreise).
// Gleiche Quelle wie die Supermarkt-Angebote in MarsiHome (Function offers); Schlüssel stehen öffentlich auf marktguru.de.
// PLZ der Wohnung: kb_worker_config 'zip'. Sparsam: nur alle 4 Std. (in der heißen Phase bei jedem Deal-Lauf).
import { workerConfig } from '../db.ts';
import { hotWindow } from '../util/events.ts';
import { fetchPage } from '../util/http.ts';
import { dealQueries } from './pepper.ts';
import { matchTitle, type ProductQuery } from '../util/match.ts';
import type { DealAdapter, DealData } from './types.ts';

let keys: { api: string; client: string; at: number } | null = null;
async function marktguruKeys(force = false) {
  if (!force && keys && Date.now() - keys.at < 6 * 3600_000) return keys;
  const html = (await fetchPage('https://www.marktguru.de/', { country: 'DE', minDelayMs: 2000 })).text;
  const api = html.match(/"apiKey":"([^"]+)"/)?.[1], client = html.match(/"clientKey":"([^"]+)"/)?.[1];
  if (!api || !client) throw new Error('Marktguru-Schlüssel nicht gefunden');
  keys = { api, client, at: Date.now() };
  return keys;
}

interface MgOffer {
  id: number; price: number; oldPrice?: number | null; description?: string | null;
  product?: { name?: string }; brand?: { name?: string }; advertisers?: { name?: string }[];
  validityDates?: { from: string; to: string }[];
}

/** „MEDIMAX Saarbrücken“ → „MEDIMAX“, „ALDI SÜD“ → „Aldi Süd“ */
export function chainName(name: string): string {
  const n = name.toLowerCase();
  const known: [string, string][] = [['aldi süd', 'Aldi Süd'], ['aldi nord', 'Aldi Nord'], ['aldi', 'Aldi'], ['lidl', 'Lidl'], ['kaufland', 'Kaufland'],
    ['mediamarkt', 'MediaMarkt'], ['media markt', 'MediaMarkt'], ['saturn', 'Saturn'], ['medimax', 'MEDIMAX'], ['expert', 'expert'],
    ['euronics', 'Euronics'], ['penny', 'Penny'], ['netto', 'Netto'], ['norma', 'Norma'], ['rewe', 'REWE'], ['edeka', 'EDEKA'],
    ['globus', 'Globus'], ['real', 'real'], ['dm', 'dm'], ['rossmann', 'Rossmann'], ['müller', 'Müller'], ['obi', 'OBI'],
    ['hornbach', 'Hornbach'], ['bauhaus', 'Bauhaus'], ['toom', 'toom'], ['hagebau', 'hagebau'], ['tchibo', 'Tchibo']];
  return known.find(([k]) => n === k || n.startsWith(k + ' ') || n.startsWith(k + '-'))?.[1] ?? name;
}

export async function marktguruSearch(term: string, zip: string): Promise<MgOffer[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const k = await marktguruKeys(attempt > 0);
    const url = `https://api.marktguru.de/api/v1/offers/search?as=web&limit=60&zipCode=${encodeURIComponent(zip)}&q=${encodeURIComponent(term)}`;
    const p = await fetchPage(url, { country: 'DE', json: true, minDelayMs: 1500, headers: { 'x-apikey': k.api, 'x-clientkey': k.client }, allowStatus: [401, 403] });
    if (p.status === 401 || p.status === 403) continue;   // Schlüssel gewechselt
    return (JSON.parse(p.text)?.results ?? []) as MgOffer[];
  }
  throw new Error('Marktguru verweigert den Zugriff');
}

export const marktguruAdapter: DealAdapter = {
  key: 'marktguru', label: 'Prospekt', country: 'DE',
  async search(q: ProductQuery) {
    if (!hotWindow() && new Date().getUTCHours() % 4 !== 0) return [];
    const zip = (await workerConfig('zip').catch(() => undefined)) ?? '81369';
    const found = new Map<string, DealData & { score: number; reason: string }>();
    for (const term of dealQueries(q).slice(0, 2)) {
      for (const o of await marktguruSearch(term, zip)) {
        if (typeof o.price !== 'number') continue;
        const brand = o.brand?.name && !/nobrand/i.test(o.brand.name) ? o.brand.name : '';
        const title = [brand, o.product?.name, o.description].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        const r = matchTitle(q, title);
        if (r.score < 0.75) continue;   // 0,7 ließ Schwestervarianten durch (Review 11.11.)
        const from = o.validityDates?.map((d) => d.from).sort()[0];
        const to = o.validityDates?.map((d) => d.to).sort().pop();
        const merchant = chainName(o.advertisers?.[0]?.name ?? 'Prospekt');
        found.set(String(o.id), {
          portal: 'marktguru', externalId: String(o.id), title: `${merchant}-Prospekt: ${title}`.slice(0, 480),
          url: `https://www.marktguru.de/offers/${o.id}`, merchant, price: o.price, nextBestPrice: o.oldPrice ?? null,
          postedAt: from ? new Date(from) : null, expired: to ? Date.parse(to) < Date.now() : false,
          score: r.score, reason: r.reason,
        });
      }
    }
    return [...found.values()];
  },
};
