// Deal-Portale nach den Wunschprodukten durchsuchen, neue Deals speichern und melden
import { db } from '../db.ts';
import { DEAL_SOURCES } from '../adapters/registry.ts';
import { toQuery, type ProductRow } from '../products.ts';
import { recordSourceResult } from './health.ts';
import { createAlert, similarRecentAlert } from './alerts.ts';
import { fmtEur } from '../util/money.ts';
import { IMPORT_MARKET, PRICE_ERROR } from '../util/plausible.ts';
import { hotWindow } from '../util/events.ts';
import { packSize } from '../util/pack.ts';
import { conditionFromTitle } from '../adapters/common.ts';

const CONDITION_LABEL: Record<string, string> = { refurbished: 'Refurbished', bware: 'B-Ware/Vorführware', used: 'Gebraucht' };

const BUNDLE = /starter[\s-]*(?:set|kit|paket)|\bbridge\b|\+\s*(?:\d+\s*x\s*)?(?:dimmschalter|schalter|sensor|kontaktsensor|bewegungsmelder|fernbedienung|smart button|tap dial)|\bbundle\b/i;

export async function runDeals(deadline: number, opts: { productId?: string; portals?: string[] } = {}) {
  const sql = await db();
  // In der heißen Phase (Black Week, Singles Day) Deal-Portale alle 15 statt 50 Minuten abfragen
  const everyMin = hotWindow() ? 15 : 50;
  const products = await sql<ProductRow[]>`
    select * from kb_products where status = 'watching'
      and (${opts.productId ?? null}::uuid is null or id = ${opts.productId ?? null}::uuid)
      and (${opts.productId ?? null}::uuid is not null or deals_checked_at is null or deals_checked_at < now() - make_interval(mins => ${everyMin}))
    order by deals_checked_at nulls first
    limit ${Number(process.env.KB_DEALS_PER_RUN ?? 20)}`;
  const adapters = DEAL_SOURCES.filter((a) => !opts.portals || opts.portals.includes(a.key));
  const stats = { products: 0, found: 0, newDeals: 0, alerts: 0 };
  for (const p of products) {
    if (Date.now() > deadline) break;
    stats.products++;
    const q = toQuery(p);
    const multi = (p.quantity ?? 1) > 1;
    await sql`update kb_products set deals_checked_at = now() where id = ${p.id}`;
    await Promise.all(adapters.map(async (ad) => {
      let deals;
      try { deals = await ad.search(q); await recordSourceResult(ad.key, true); }
      catch (e) { await recordSourceResult(ad.key, false, (e as Error).message); return; }
      for (const d of deals as any[]) {
        stats.found++;
        if (PRICE_ERROR.test(d.title)) continue;   // Preisfehler kommen nicht wieder – weder Deal noch Verlauf
        const importWare = IMPORT_MARKET.test(d.merchant ?? '') || IMPORT_MARKET.test(d.title);
        const pack = packSize(d.title) ?? 1;
        // Mengen-Produkte: Deal-Preis pro Stück vergleichen (Schwellen und Bestpreis gelten dann pro Stück)
        // „(eff. 9,90 €/Stück)“ ist schon ein Stückpreis – nicht noch einmal durch die Packung teilen (Review 11.11.)
        const perPieceInTitle = /\beff[^)\]]*\/\s*(?:st(?:ü|ue)ck|stk)/i.test(d.title);
        // Mengen-Produkte: was die BENÖTIGTE Menge mit diesem Deal kostet – nur ganze Packungen, Überschuss zählt mit
        // (11.11.: 5er-Pack für 229 € bei Bedarf 3 als „45,80 €/Stück, sofort zuschlagen“ gemeldet; für 3 Stück zahlt man 229 €)
        const need = Math.max(1, Number(p.quantity ?? 1));
        const packPrice: number | null = d.price ? (perPieceInTitle ? d.price * pack : d.price) : null;
        const packsNeeded = multi ? Math.ceil(need / pack) : 1;
        const totalForNeed: number | null = packPrice !== null ? Math.round(packPrice * packsNeeded * 100) / 100 : null;
        const cmp: number | null = d.price ? (multi ? Math.round((totalForNeed ?? 0) / need * 100) / 100 : d.price) : null;
        // Sets mit Zubehör (Starter-Set mit Bridge, „+ Dimmschalter“ …) sind kein Preis für das Produkt allein
        const bundle = BUNDLE.test(d.title) && !BUNDLE.test(p.name);
        // Zustand aus dem Titel: Refurbished/B-Ware/Gebraucht ist kein Neupreis – weder für Stufe, Verlauf noch Schwellen
        const condition = conditionFromTitle(d.title);
        const used = condition !== 'new';
        const notes = used ? `${CONDITION_LABEL[condition]} – kein Neupreis` : d.foreign ? `Händler in ${ad.country} – Lieferung nach DE prüfen` : importWare ? 'Versand aus dem Ausland – Lieferzeit prüfen'
          : bundle ? 'Set mit Zubehör – nicht mit dem Einzelpreis vergleichbar' : null;
        const r = await sql`
          insert into kb_deals (product_id, user_id, portal, external_id, title, url, merchant, price, next_best_price, temperature,
                                comment_count, posted_at, expired, voucher_code, match_score, notes, pack_size)
          values (${p.id}, ${p.user_id}, ${d.portal}, ${d.externalId}, ${d.title.slice(0, 500)}, ${d.url}, ${d.merchant ?? null}, ${d.price ?? null},
                  ${d.nextBestPrice ?? null}, ${d.temperature ?? null}, ${d.commentCount ?? null}, ${d.postedAt ?? null}, ${!!d.expired},
                  ${d.voucherCode ?? null}, ${d.score}, ${notes}, ${pack})
          on conflict (product_id, portal, external_id) do update set
            temperature = excluded.temperature, comment_count = excluded.comment_count, expired = excluded.expired,
            price = coalesce(excluded.price, kb_deals.price), notes = excluded.notes, match_score = excluded.match_score
          returning (xmax = 0) as inserted`;
        const isNew = r[0]?.inserted;
        if (isNew) stats.newDeals++;
        // Deal als Preisstützpunkt in den Verlauf (auch alte – gibt Preisgeschichte)
        if (isNew && d.price) {
          await sql`insert into kb_price_history (product_id, user_id, series, shop, condition, observed_at, total, pack_size)
                    values (${p.id}, ${p.user_id}, ${'deal:' + d.portal}, ${d.merchant ?? d.portal}, ${condition}, ${d.postedAt ?? new Date()}, ${d.price}, ${pack})`;
        }
        // Melden: neu, aktiv, jünger als 3 Tage, Lieferung nach DE möglich, und Preis interessant
        const fresh = d.postedAt && Date.now() - new Date(d.postedAt).getTime() < 3 * 86400_000;
        // Nicht-Neuware nur melden, wenn das Produkt auch Refurbished/B-Ware zulässt – dann gegen die Refurb-Schwellen (× 0,9)
        if (isNew && fresh && !d.expired && !d.foreign && !bundle && (!used || p.include_refurb)) {
          const f = used ? 0.9 : 1;
          const tGood = p.threshold_good ? p.threshold_good * f : null;
          const tTop = p.threshold_top ? p.threshold_top * f : null;
          const tInstant = p.threshold_instant ? p.threshold_instant * f : null;
          // Höchstpreis gilt für die ganze Menge → pro Stück umrechnen
          const maxUnit = p.max_price ? (multi ? p.max_price / p.quantity : p.max_price) : null;
          const ref = Math.max(tGood ?? 0, maxUnit ?? 0) || (used ? p.best_refurb_price ?? (p.best_price ? p.best_price * f : null) : p.best_price);
          const interesting = !cmp || !ref || cmp <= ref * 1.02;
          if (interesting) {
            const level = cmp && ((tInstant && cmp <= tInstant) || (maxUnit && cmp <= maxUnit)) ? 'instant'
              : cmp && tTop && cmp <= tTop ? 'top'
              // „gut“ nur, wenn die Schwelle wirklich erreicht ist – sonst nur Info (keine Push-Nachricht)
              : cmp && tGood && cmp <= tGood ? 'good' : 'info';
            const finalLevel = level;
            // Schwellen-Meldung zum selben Shop/Preis (±1 %) in den letzten 6 Std. → keine zweite Meldung
            if (cmp && await similarRecentAlert(p.id, cmp, d.merchant, finalLevel)) continue;
            stats.alerts += await createAlert({
              userId: p.user_id, productId: p.id, kind: 'deal', level: finalLevel,
              title: multi && totalForNeed !== null && cmp
                ? `${ad.label}-Deal: ${p.name} – ${need} Stück für ${fmtEur(totalForNeed)} (${fmtEur(cmp)}/Stück` +
                  `${pack > 1 ? `, ${packsNeeded > 1 ? `${packsNeeded}× ` : ''}${pack}er-Pack` : ''}${packsNeeded * pack > need ? `, du bekommst ${packsNeeded * pack}` : ''})`
                : `${ad.label}-Deal: ${p.name}${used ? ` (${CONDITION_LABEL[condition]})` : ''}${d.price ? ' für ' + fmtEur(d.price) : ''}`,
              body: `${d.title}${d.merchant ? ' – bei ' + d.merchant : ''}${d.temperature !== null ? ` (${Math.round(d.temperature)}°)` : ''}` +
                (d.voucherCode ? ` Gutscheincode: ${d.voucherCode}` : '') +
                (importWare ? ' Versand evtl. aus dem Ausland – Lieferzeit prüfen.' : '') +
                (p.best_price && d.price ? `. Zum Vergleich: bester beobachteter Preis aktuell ${fmtEur(p.best_price)}${multi ? ' pro Stück' : ''}.` : ''),
              url: d.url, dedupKey: `deal:${d.portal}:${d.externalId}`,
              data: cmp ? { price: cmp, shop: d.merchant ?? null } : null,
            });
          }
        }
      }
    }));
  }
  return stats;
}
