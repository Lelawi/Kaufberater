// "Ist das ein Deal?": Link oder Text aus der App schnell einschätzen (ohne KI, die Tiefenanalyse folgt später)
import { db } from '../db.ts';
import { fetchPage } from '../util/http.ts';
import { parseShopPage, needsHomeUrl } from '../adapters/shops.ts';
import { idealoAdapter, parseIdealoSearch } from '../adapters/idealo.ts';
import { matchTitle, type ProductQuery } from '../util/match.ts';
import { fmtEur, parsePrice } from '../util/money.ts';
import { createAlert } from './alerts.ts';
import { IS_HOME } from '../adapters/registry.ts';

export async function runQuickChecks(deadline: number) {
  const sql = await db();
  const jobs = await sql`select * from kb_quick_checks where status = 'queued' order by created_at limit 5`;
  let done = 0;
  for (const j of jobs) {
    if (Date.now() > deadline) break;
    await sql`update kb_quick_checks set status = 'running' where id = ${j.id}`;
    try {
      const r = await check(j.input as string);
      await sql`update kb_quick_checks set status = 'done', done_at = now(), product_name = ${r.name}, price = ${r.price},
                verdict = ${r.verdict}, summary = ${r.summary}, details = ${sql.json(r.details as any)} where id = ${j.id}`;
      await createAlert({ userId: j.user_id, productId: null, kind: 'quick_check', level: r.verdict === 'great' ? 'top' : 'info',
        title: `Schnellcheck: ${r.name ?? 'Angebot'}`, body: r.summary, url: r.url, dedupKey: `qc:${j.id}` });
      done++;
    } catch (e) {
      await sql`update kb_quick_checks set status = 'failed', done_at = now(), summary = ${'Konnte nicht geprüft werden: ' + (e as Error).message} where id = ${j.id}`;
    }
  }
  return { done };
}

async function check(input: string) {
  const urlMatch = input.match(/https?:\/\/\S+/);
  let name: string | null = null; let price: number | null = null; let shop: string | null = null; let url: string | null = null;
  if (urlMatch) {
    url = urlMatch[0];
    if (!IS_HOME && needsHomeUrl(url)) {
      // Seite hier nicht abrufbar → Name aus URL/Text ableiten
      name = decodeURIComponent(url.split('/').filter(Boolean).find((s) => /[a-z]{3,}-[a-z0-9-]{3,}/i.test(s)) ?? '').replace(/-/g, ' ').slice(0, 120) || null;
    } else {
      const p = await fetchPage(url, { retries: 1 });
      const o = parseShopPage(p.text, p.url);
      if (o) { name = o.title ?? null; price = o.price + (o.shipping ?? 0); shop = o.shop; }
    }
  }
  const textPrice = parsePrice(input.replace(urlMatch?.[0] ?? '', '').match(/(\d[\d.,]*)\s*(€|eur|euro)/i)?.[1]);
  price = price ?? textPrice;
  if (!name) name = input.replace(urlMatch?.[0] ?? '', '').replace(/(\d[\d.,]*)\s*(€|eur|euro)/i, '').trim().slice(0, 120) || null;
  if (!name) return { name, price, url, verdict: 'unknown', summary: 'Produkt nicht erkannt. Tipp: Link und Preis eingeben.', details: {} };

  // Mit idealo vergleichen
  const q: ProductQuery = { name };
  const s = await fetchPage(`https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=${encodeURIComponent(name.slice(0, 80))}`, { minDelayMs: 3000 });
  const cands = parseIdealoSearch(s.text, q).filter((c) => c.score >= 0.6).sort((a, b) => b.score - a.score);
  let best: number | null = null; let bestShop: string | null = null; let compareUrl: string | null = null; let offersCount = 0;
  if (cands[0]) {
    const offers = (await idealoAdapter.fetch({ id: 'qc', source: 'idealo', country: 'DE', external_id: cands[0].externalId, url: cands[0].url, condition: 'new' }, q))
      .filter((o) => o.condition === 'new');
    offersCount = offers.length;
    const sorted = offers.map((o) => ({ ...o, total: o.price + (o.shipping ?? 0) })).sort((a, b) => a.total - b.total);
    if (sorted[0]) { best = sorted[0].total; bestShop = sorted[0].shop; compareUrl = cands[0].url; }
  }
  let verdict: 'great' | 'good' | 'ok' | 'bad' | 'unknown' = 'unknown';
  let summary = '';
  if (price && best) {
    const diff = (price - best) / best;
    verdict = diff <= -0.05 ? 'great' : diff <= 0.01 ? 'good' : diff <= 0.06 ? 'ok' : 'bad';
    summary = verdict === 'great' ? `Sehr gut: ${fmtEur(price)} liegt ${Math.round(-diff * 100)} % unter dem günstigsten Preisvergleich-Angebot (${fmtEur(best)} bei ${bestShop}).`
      : verdict === 'good' ? `Gut: ${fmtEur(price)} entspricht etwa dem günstigsten Angebot im Preisvergleich (${fmtEur(best)} bei ${bestShop}).`
      : verdict === 'ok' ? `Okay, aber nicht top: Im Preisvergleich gibt es es ab ${fmtEur(best)} (${bestShop}).`
      : `Kein Deal: Bei ${bestShop} gibt es es für ${fmtEur(best)} – ${fmtEur(price - best)} günstiger.`;
  } else if (best) {
    summary = `Günstigster Preis im Preisvergleich: ${fmtEur(best)} bei ${bestShop} (${offersCount} Angebote). Gib den Preis mit an für eine Bewertung.`;
  } else {
    summary = 'Kein passendes Produkt im Preisvergleich gefunden. Die tägliche Tiefenanalyse schaut es sich genauer an.';
  }
  return { name, price, url, verdict, summary, details: { shop, best, bestShop, compareUrl, offersCount, matched: cands[0]?.title ?? null } };
}
