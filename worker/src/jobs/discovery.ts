// Neue Produkte: bei allen Quellen suchen und passende Treffer als Abfrageziele speichern
import { db } from '../db.ts';
import { SOURCES, availableHere } from '../adapters/registry.ts';
import { toQuery, type ProductRow } from '../products.ts';
import { recordSourceResult } from './health.ts';
import type { Candidate, SourceAdapter } from '../adapters/types.ts';
import { variantCodes, modelKeys, packQueries } from '../util/match.ts';
import { cleanName, variantSuggestions, identifyOptions } from '../util/naming.ts';
import { ebayConfigured } from '../adapters/ebay.ts';

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
           or (${ebayConfigured()} and not exists (select 1 from kb_listings l where l.product_id = kb_products.id and l.source = 'ebay')
               and discovery_at < now() - interval '6 hours')
           or (${process.env.KB_RUNNER === 'home'} and not exists (select 1 from kb_listings l where l.product_id = kb_products.id and l.source in ('amazon','geizhals'))
               and discovery_at < now() - interval '6 hours'))
    order by discovery_at nulls first
    limit 10`;
  let listingsAdded = 0;
  for (const p of products) {
    if (Date.now() > deadline) break;
    await sql`update kb_products set discovery_status = 'running', discovery_at = now() where id = ${p.id}`;
    const q = toQuery(p);
    if ((p.quantity ?? 1) > 1) q.packQueries = packQueries(q);
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
    const goodTitles: string[] = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      ok++;
      const { source, cands } = r.value;
      const good = cands
        .filter((c: Candidate) => c.score >= MIN_SCORE)
        .sort((a: Candidate, b: Candidate) => b.score - a.score)
        // Mengen-Produkte: mehr Treffer behalten – das sind meist verschiedene Packungsgrößen (1er, 3er, 6er, 18er …)
        .slice(0, (source.kind === 'aggregator' ? 4 : MAX_PER_SOURCE) * ((p.quantity ?? 1) > 1 ? 3 : 1));
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
        if (c.score >= 0.8 && c.title) goodTitles.push(c.title);
      }
    }
    // Gefundene Modellvarianten (z. B. OLED77G68LW, OLED77G67LW) merken: verbessert die Deal-Suche und spätere Suchen
    const newTerms = [...learned].filter((v) => !(p.search_terms ?? []).map((x) => x.toUpperCase()).includes(v)).slice(0, 6);
    // Ist eine Quelle ausgefallen (z. B. kurz gesperrt), in ca. 6 Stunden noch einmal suchen statt erst in einer Woche
    const failed = results.length - ok;
    await sql`update kb_products set discovery_status = ${ok > 0 ? 'done' : 'failed'},
              discovery_at = ${failed > 0 ? sql`now() - interval '7 days' + interval '6 hours'` : sql`now()`},
              search_terms = ${[...(p.search_terms ?? []), ...newTerms]} where id = ${p.id}`;
    await tidyName(p, goodTitles).catch((e) => console.log('Name:', (e as Error).message));
    // Nichts eindeutig gefunden (z. B. „Bosch Heizungsthermostat Matter“ statt „Heizkörper-Thermostat II [+M]“):
    // ähnliche Produkte zur Auswahl anbieten
    const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.cands.map((c: Candidate) => ({ title: c.title ?? '', url: c.url, source: r.value.source.key, price: c.price ?? null })) : []));
    await offerChoices(p, all, sources).catch((e) => console.log('Auswahl:', (e as Error).message));
  }
  return { products: products.length, listingsAdded };
}

/** Sauberer Name aus den Treffern; ohne Modellnummer und bei mehreren Produktvarianten: Auswahl für die App */
async function tidyName(p: ProductRow, titles: string[]) {
  if (p.name_confirmed || p.name_auto) return;
  const sql = await db();
  if (titles.length) {
    const clean = cleanName(p.name, titles, p.brand);
    if (clean !== p.name) {
      await sql`update kb_products set name = ${clean}, name_original = coalesce(name_original, ${p.name}) where id = ${p.id} and not name_confirmed and name = ${p.name}`;
      p.name = clean;
    }
  }
  if (modelKeys(toQuery(p)).length) return;   // Modellnummer → eindeutig
  const listings = await sql`select id, title from kb_listings where product_id = ${p.id} and not rejected and active and title is not null and match_score >= 0.75`;
  const sugg = variantSuggestions(p.name, listings.map((l) => ({ id: l.id as string, title: l.title as string })));
  await sql`update kb_products set name_suggestions = ${sugg.length > 1 ? sql.json(sugg as any) : null} where id = ${p.id} and not name_confirmed`;
}

/** Keine passende Quelle → bis zu fünf ähnliche Produkte als Auswahl speichern (App fragt „Meinst du …?“) */
async function offerChoices(p: ProductRow, cands: { title: string; url: string; source: string; price: number | null }[], sources: SourceAdapter[]) {
  if (p.name_confirmed || p.name_auto) return;
  const sql = await db();
  const [{ n }] = await sql`select count(*)::int as n from kb_listings where product_id = ${p.id} and not rejected and match_score >= 0.75`;
  if (n > 0) return;
  let opts = identifyOptions(p.name, cands);
  if (opts.length < 3) {
    // Lockerer suchen: jeweils ein Wort weglassen und lange zusammengesetzte Wörter kürzen (Heizungsthermostat → Thermostat)
    const words = p.name.split(/\s+/).filter(Boolean);
    const variants = new Set<string>();
    for (let i = 0; i < words.length && words.length > 2; i++) variants.add(words.filter((_, j) => j !== i).join(' '));
    variants.add(words.map((w) => (w.length >= 12 ? w.slice(-Math.ceil(w.length / 2)) : w)).join(' '));
    const agg = sources.filter((s) => s.kind === 'aggregator' && s.search);
    const q = toQuery(p);
    for (const v of [...variants].slice(0, 4)) {
      for (const s of agg) {
        try { for (const c of await s.search!({ ...q, name: v, model: null, terms: [] })) cands.push({ title: c.title ?? '', url: c.url, source: s.key, price: c.price ?? null }); }
        catch { /* Quelle gerade nicht erreichbar */ }
      }
      opts = identifyOptions(p.name, cands);
      if (opts.length >= 5) break;
    }
  }
  await sql`update kb_products set name_suggestions = ${opts.length ? sql.json(opts as any) : null} where id = ${p.id} and not name_confirmed`;
}
