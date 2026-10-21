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
