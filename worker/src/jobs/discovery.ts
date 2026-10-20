// Neue Produkte: bei allen Quellen suchen und passende Treffer als Abfrageziele speichern
import { db } from '../db.ts';
import { SOURCES, availableHere } from '../adapters/registry.ts';
import { toQuery, type ProductRow } from '../products.ts';
import { recordSourceResult } from './health.ts';
import type { Candidate } from '../adapters/types.ts';
import { variantCodes } from '../util/match.ts';

const MIN_SCORE = 0.75;
const MAX_PER_SOURCE = 3;

export async function runDiscovery(deadline: number, onlyProductId?: string) {
  const sql = await db();
  const products = await sql<ProductRow[]>`
    select * from kb_products
    where status in ('watching','bought') and (not name_auto or created_at < now() - interval '1 hour')
      and (${onlyProductId ?? null}::uuid is null or id = ${onlyProductId ?? null}::uuid)
      and (discovery_status = 'pending'
           or (discovery_status in ('done','failed') and discovery_at < now() - interval '7 days')
           or ${onlyProductId ?? null}::uuid is not null
           or (${process.env.KB_RUNNER === 'home'} and not exists (select 1 from kb_listings l where l.product_id = kb_products.id and l.source in ('amazon','geizhals'))
               and discovery_at < now() - interval '6 hours'))
    order by discovery_at nulls first
    limit 10`;
  let listingsAdded = 0;
  for (const p of products) {
    if (Date.now() > deadline) break;
    await sql`update kb_products set discovery_status = 'running', discovery_at = now() where id = ${p.id}`;
    const q = toQuery(p);
    const sources = SOURCES.filter((s) => s.search && availableHere(s) && (p.include_refurb || s.kind !== 'refurb'));
    const results = await Promise.allSettled(sources.map(async (s) => {
      const t0 = Date.now();
      try {
        const cands = await s.search!(q);
        await recordSourceResult(s.key, true);
        return { source: s, cands, ms: Date.now() - t0 };
      } catch (e) {
        await recordSourceResult(s.key, false, (e as Error).message);
        throw e;
      }
    }));
    let ok = 0;
    const learned = new Set<string>();
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      ok++;
      const { source, cands } = r.value;
      const good = cands
        .filter((c: Candidate) => c.score >= MIN_SCORE)
        .sort((a: Candidate, b: Candidate) => b.score - a.score)
        .slice(0, source.kind === 'aggregator' ? 4 : MAX_PER_SOURCE);
      for (const c of good) {
        for (const v of variantCodes(q, c.title ?? '')) learned.add(v);
        const ins = await sql`
          insert into kb_listings (product_id, user_id, source, country, external_id, url, title, condition, discovered_by, match_score, next_check_at)
          values (${p.id}, ${p.user_id}, ${source.key}, ${c.country}, ${c.externalId}, ${c.url}, ${c.title?.slice(0, 500) ?? null},
                  ${c.condition ?? (source.kind === 'refurb' ? 'refurbished' : 'new')}, 'search', ${c.score}, now())
          on conflict (product_id, source, country, external_id) do update
            set url = excluded.url, title = excluded.title, match_score = greatest(kb_listings.match_score, excluded.match_score)
          returning (xmax = 0) as inserted`;
        if (ins[0]?.inserted) listingsAdded++;
      }
    }
    // Gefundene Modellvarianten (z. B. OLED77G68LW, OLED77G67LW) merken: verbessert die Deal-Suche und spätere Suchen
    const newTerms = [...learned].filter((v) => !(p.search_terms ?? []).map((x) => x.toUpperCase()).includes(v)).slice(0, 6);
    await sql`update kb_products set discovery_status = ${ok > 0 ? 'done' : 'failed'}, discovery_at = now(),
              search_terms = ${[...(p.search_terms ?? []), ...newTerms]} where id = ${p.id}`;
  }
  return { products: products.length, listingsAdded };
}
