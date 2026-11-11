// "Ist das ein Deal?": Link oder Text aus der App schnell einschätzen (ohne KI, die Tiefenanalyse folgt später)
import { db } from '../db.ts';
import { fetchPage } from '../util/http.ts';
import { parseShopPage, needsHomeUrl } from '../adapters/shops.ts';
import { idealoAdapter, parseIdealoSearch } from '../adapters/idealo.ts';
import { billigerAdapter } from '../adapters/billiger.ts';
import { pepperAdapters } from '../adapters/pepper.ts';
import { matchTitle, guessModel, type ProductQuery } from '../util/match.ts';
import type { OfferData } from '../adapters/types.ts';
import { plausibleOffers, PRICE_ERROR } from '../util/plausible.ts';
import { fmtEur, parsePrice } from '../util/money.ts';
import { createAlert } from './alerts.ts';
import { IS_HOME } from '../adapters/registry.ts';
import { packSize } from '../util/pack.ts';

export async function runQuickChecks(deadline: number) {
  const sql = await db();
  let done = 0;
  // Mehrmals nachsehen: was während des Laufs dazukommt, wird gleich mit erledigt (sonst wartet es bis zum nächsten Lauf)
  for (let round = 0; round < 4 && Date.now() < deadline; round++) {
  const jobs = await sql`select * from kb_quick_checks where status = 'queued' order by created_at limit 5`;
  if (!jobs.length) break;
  for (const j of jobs) {
    if (Date.now() > deadline) break;
    await sql`update kb_quick_checks set status = 'running' where id = ${j.id}`;
    try {
      const r = await check(j.input as string, j.user_id as string);
      await sql`update kb_quick_checks set status = 'done', done_at = now(), product_name = ${r.name}, price = ${r.price},
                verdict = ${r.verdict}, summary = ${r.summary}, details = ${sql.json(r.details as any)} where id = ${j.id}`;
      await createAlert({ userId: j.user_id, productId: null, kind: 'quick_check', level: r.verdict === 'great' ? 'top' : 'info',
        title: `Schnellcheck: ${r.name ?? 'Angebot'}`, body: r.summary, url: r.url, dedupKey: `qc:${j.id}` });
      done++;
    } catch (e) {
      await sql`update kb_quick_checks set status = 'failed', done_at = now(), summary = ${'Konnte nicht geprüft werden: ' + (e as Error).message} where id = ${j.id}`;
    }
  }
  }
  // Hängengebliebene (Lauf abgebrochen) wieder einreihen
  await sql`update kb_quick_checks set status = 'queued' where status = 'running' and created_at < now() - interval '20 minutes' and created_at > now() - interval '6 hours' and done_at is null`;
  return { done };
}

async function check(input: string, userId: string) {
  const urlMatch = input.match(/https?:\/\/\S+/);
  let name: string | null = null; let price: number | null = null; let shop: string | null = null; let url: string | null = null;
  let listPrice: number | null = null; let gtin: string | null = null;
  if (urlMatch) {
    url = urlMatch[0];
    if (!IS_HOME && needsHomeUrl(url)) {
      // Seite hier nicht abrufbar → Name aus dem Link ableiten (z. B. amazon.de/Sony-WH-1000XM6-…/dp/…)
      const slug = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean).find((x) => /[a-z]{3,}-[a-z0-9-]{3,}/i.test(x)) ?? '';
      name = slug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
      shop = new URL(url).hostname.replace(/^www\./, '');
    } else {
      try {
        const p = await fetchPage(url, { retries: 1 });
        const o = parseShopPage(p.text, p.url);
        if (o) { name = o.title ?? null; price = o.price + (o.shipping ?? 0); shop = o.shop; listPrice = o.listPrice ?? null; gtin = (o as any).gtin ?? null; }
      } catch (e) { console.log('Schnellcheck: Seite nicht lesbar –', (e as Error).message); }   // dann zählt der mitgeteilte Text
    }
  }
  const rest = input.replace(urlMatch?.[0] ?? '', '');
  const textPrice = parsePrice(rest.match(/(\d[\d.,]*)\s*(€|eur|euro)/i)?.[1]);
  price = textPrice ?? price;   // eingetippter Preis hat Vorrang (z. B. Preis im Laden)
  if (!name) name = rest.replace(/(\d[\d.,]*)\s*(€|eur|euro)/i, '').replace(/\b(für|fuer|bei|um)\s*$/i, '')
    .replace(/^(schau dir (das|dies) (mal )?an|sieh dir (das|dies) an|check (this|that) out|guck mal)\s*[:!-]?\s*/i, '')
    .replace(/\s*[-|–]\s*(amazon\.de|amazon)\s*$/i, '').trim().slice(0, 120) || null;
  if (!name) return { name, price, url, verdict: 'unknown', summary: 'Produkt nicht erkannt. Tipp: Link und Preis eingeben.', details: {} };

  const model = guessModel(name) ?? guessModel(rest) ?? (url ? guessModel(decodeURIComponent(url)) : null);
  const q: ProductQuery = { name, model, ean: gtin };
  // Mit Modellnummer muss sie im Treffer vorkommen (verhindert z. B. WF-1000XM6 statt WH-1000XM6)
  const strong = (reason?: string) => !model || /Modellnummer|Herstellernummer|EAN/.test(reason ?? '');

  // Preisvergleich: idealo und billiger.de
  const compare: { src: string; title: string; url: string; offers: OfferData[] }[] = [];
  const sources = [
    { src: 'idealo', search: async () => parseIdealoSearch((await fetchPage(`https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=${encodeURIComponent((model ?? name).slice(0, 80))}`, { minDelayMs: 3000 })).text, q), ad: idealoAdapter },
    { src: 'billiger', search: () => billigerAdapter.search!(q), ad: billigerAdapter },
  ];
  await Promise.all(sources.map(async (s) => {
    try {
      const cands = (await s.search()).filter((c) => c.score >= 0.75 && strong(c.reason)).sort((a, b) => b.score - a.score);
      const c = cands[0];
      if (!c) return;
      const offers = await s.ad.fetch({ id: 'qc', source: s.src, country: 'DE', external_id: c.externalId, url: c.url, condition: 'new' }, q);
      compare.push({ src: s.src, title: c.title, url: c.url, offers: plausibleOffers(offers.filter((o) => o.condition === 'new' && o.price > 0 && o.shipsToDE !== false)) });
    } catch (e) { console.log(`Schnellcheck ${s.src}:`, (e as Error).message); }
  }));
  // Nur vertrauenswürdige Shops als Maßstab (gleiche Regel wie bei der Überwachung)
  const trusted = (o: OfferData) => !(o.shopReviews != null && o.shopReviews < 20) && !(o.shopRating != null && o.shopRating < 3.5 && (o.shopReviews ?? 0) < 500);
  const all = compare.flatMap((c) => c.offers.map((o) => ({ ...o, total: Math.round((o.price + (o.shipping ?? 0)) * 100) / 100, src: c.src, page: c.url })));
  const sorted = all.filter(trusted).sort((a, b) => a.total - b.total);
  const bestO = sorted[0] ?? null;
  const best = bestO?.total ?? null; const bestShop = bestO?.shop ?? null;
  const compareUrl = (compare.find((c) => c.src === 'idealo') ?? compare[0])?.url ?? null;
  const matched = (compare.find((c) => c.src === 'idealo') ?? compare[0])?.title ?? null;

  // Bisher bester mydealz-Deal (zum Einordnen)
  let dealLow: { price: number; merchant: string | null; date: string | null; url: string } | null = null;
  try {
    const mydealz = pepperAdapters.find((a) => a.key === 'mydealz');
    const deals = mydealz ? (await mydealz.search({ ...q, name: model ?? name })).filter((d) => d.price && !(d as any).foreign && (!model || strong((d as any).reason))) : [];
    const year = Date.now() - 365 * 864e5;
    // Importware-Marktplätze und unplausibel billige Deals (oft andere Variante/Fälschung) nicht als Maßstab nehmen
    const recent = deals.filter((d) => (!d.postedAt || d.postedAt.getTime() > year) && !PRICE_ERROR.test(d.title))
      .filter((d) => !best || d.price! >= best * 0.55)
      .sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
    if (recent[0]) dealLow = { price: recent[0].price!, merchant: recent[0].merchant ?? null, date: recent[0].postedAt?.toISOString().slice(0, 10) ?? null, url: recent[0].url };
  } catch (e) { console.log('Schnellcheck mydealz:', (e as Error).message); }

  // Steht das Produkt schon auf der Wunschliste?
  const sql = await db();
  const mine = await sql`select id, name, model, brand, search_terms, threshold_good, threshold_top, threshold_instant, lowest_seen, quantity from kb_products where user_id = ${userId} and status = 'watching'`;
  const watched = mine.map((p) => ({ p, r: matchTitle({ name: p.name, model: p.model, brand: p.brand, terms: p.search_terms ?? [] }, `${name} ${model ?? ''}`) }))
    .filter((x) => x.r.score >= 0.85).sort((a, b) => b.r.score - a.r.score)[0]?.p ?? null;

  let verdict: 'great' | 'good' | 'ok' | 'bad' | 'unknown' = 'unknown';
  const parts: string[] = [];
  if (price && best) {
    const diff = (price - best) / best;
    verdict = diff <= -0.05 ? 'great' : diff <= 0.01 ? 'good' : diff <= 0.06 ? 'ok' : 'bad';
    parts.push(verdict === 'great' ? `Sehr gut: ${fmtEur(price)} liegt ${Math.round(-diff * 100)} % unter dem günstigsten seriösen Angebot im Preisvergleich (${fmtEur(best)} bei ${bestShop}).`
      : verdict === 'good' ? `Gut: ${fmtEur(price)} entspricht etwa dem günstigsten seriösen Angebot (${fmtEur(best)} bei ${bestShop}).`
      : verdict === 'ok' ? `Okay, aber nicht top: Im Preisvergleich gibt es das ab ${fmtEur(best)} (${bestShop}).`
      : `Kein Deal: Bei ${bestShop} gibt es das für ${fmtEur(best)} – ${fmtEur(price - best)} günstiger.`);
  } else if (best) {
    parts.push(`Günstigstes seriöses Angebot im Preisvergleich: ${fmtEur(best)} bei ${bestShop} (${all.length} Angebote). Gib den Preis mit an für eine Bewertung.`);
  } else {
    parts.push(model ? `Für ${model} nichts Passendes im Preisvergleich gefunden.` : 'Kein passendes Produkt im Preisvergleich gefunden. Tipp: mit Modellnummer eingeben.');
  }
  if (dealLow) {
    parts.push(`Bester mydealz-Deal im letzten Jahr: ${fmtEur(dealLow.price)}${dealLow.merchant ? ` bei ${dealLow.merchant}` : ''}${dealLow.date ? ` (${dealLow.date.split('-').reverse().join('.')})` : ''}.`);
    if (price && (verdict === 'good' || verdict === 'ok') && price > dealLow.price * 1.08) parts.push('Es ging also schon deutlich günstiger – wenn es nicht eilt, lohnt sich Warten.');
  }
  if (listPrice && best && listPrice > best * 1.3) parts.push(`Vorsicht: Der Streichpreis ${fmtEur(listPrice)} ist ein Mondpreis – der Rabatt wirkt größer, als er ist.`);
  if (watched) {
    const th = [['Sofort zuschlagen', watched.threshold_instant], ['Top', watched.threshold_top], ['Gut', watched.threshold_good]].filter(([, v]) => v != null) as [string, number][];
    // Mengen-Produkte: Schwellen gelten pro Stück – Packungsgröße der Seite berücksichtigen
    const unit = price && watched.quantity > 1 ? price / (packSize(name) ?? 1) : price;
    const hit = unit ? th.find(([, v]) => unit <= Number(v)) : null;
    parts.push(`Steht auf deiner Wunschliste („${watched.name}“)${hit ? ` – der Preis erreicht deine Schwelle „${hit[0]}“ (${fmtEur(Number(hit[1]))}${watched.quantity > 1 ? '/Stück' : ''})` : th.length ? ` – deine Schwelle „Gut“ liegt bei ${fmtEur(Number(watched.threshold_good ?? th[th.length - 1][1]))}${watched.quantity > 1 ? ' pro Stück' : ''}` : ''}.`);
    if (hit && verdict === 'unknown') verdict = 'good';
  }
  return { name, price, url, verdict, summary: parts.join(' '),
    details: { shop, best, bestShop, bestUrl: bestO?.url ?? null, compareUrl, offersCount: all.length, matched, model, dealLow, watchedId: watched?.id ?? null, sources: compare.map((c) => c.src) } };
}
