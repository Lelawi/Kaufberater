// Plausibilität der Schwellen aus der täglichen Tiefenanalyse (17.11.: bei 7 von 16 Produkten lag „gut“ auf oder über
// dem normalen Tagespreis → Meldungen für Normalpreise). Wird nur beim Bewerten angewandt, nicht gespeichert
// (jede Änderung an kb_products stößt einen GitHub-Lauf an).
import { db } from '../db.ts';
import { usableTrend } from './autothresholds.ts';

export interface Thresholds { good: number | null; top: number | null; instant: number | null }
export interface PriceStats { atAnalysis: number | null; median30: number | null; low90: number | null; days90: number }

const floor2 = (x: number) => Math.floor(x * 100 + 1e-6) / 100;

/**
 * good ≤ 0,97 × min(Bestpreis am Analysetag, 30-Tage-Median der Tagestiefs) – bei echter steigender Tendenz (außerhalb
 * Nov./heißer Phase) nur ≤ Bestpreis am Analysetag; top ≤ min(good × 0,97, 90-Tage-Tief bei ≥ 20 Tagen Verlauf);
 * instant ≤ top × 0,97. Nur senken, nie anheben. Der Bestpreis am Analysetag statt des Live-Preises, weil eine an den
 * aktuellen Preis gekoppelte Schwelle mit jedem Preisrutsch mitwandern und nie erreicht würde.
 */
export function clampThresholds(t: Thresholds, s: PriceStats, trend: string | null, now = new Date()): Thresholds {
  if (t.good == null) return t;
  const rising = usableTrend(trend, now) === 'rising';
  const refs = [s.atAnalysis, s.median30].filter((x): x is number => x != null && x > 0);
  let good = t.good;
  if (rising) { if (s.atAnalysis != null) good = Math.min(good, s.atAnalysis); }
  else if (refs.length) good = Math.min(good, 0.97 * Math.min(...refs));
  const top = t.top != null ? Math.min(t.top, good * 0.97, s.days90 >= 20 && s.low90 != null ? s.low90 : Infinity) : null;
  const instant = t.instant != null ? Math.min(t.instant, (top ?? good) * 0.97) : null;
  return { good: floor2(good), top: top != null ? floor2(top) : null, instant: instant != null ? floor2(instant) : null };
}

/** Tagestiefs (Neuware, Angebote + Preisvergleich-Verlauf, ohne abgelehnte Quellen, ohne heute) */
export async function priceStats(productId: string, multi: boolean): Promise<PriceStats> {
  const sql = await db();
  const [r] = await sql`
    with d as (
      select (h.observed_at at time zone 'Europe/Berlin')::date as day,
             min(h.total / case when ${multi} then greatest(h.pack_size, 1) else 1 end) as m
      from kb_price_history h
      where h.product_id = ${productId} and h.condition = 'new' and (h.series = 'offer' or h.series like 'hist:%')
        and (${multi} or h.pack_size = 1) and h.observed_at > now() - interval '92 days'
        and (h.observed_at at time zone 'Europe/Berlin')::date < (now() at time zone 'Europe/Berlin')::date
        and not exists (select 1 from kb_offers o join kb_listings l on l.id = o.listing_id where o.id = h.offer_id and l.rejected)
        and not exists (select 1 from kb_listings l where l.product_id = ${productId} and l.rejected
                          and h.series = 'hist:' || l.source and h.shop = l.external_id)
      group by 1),
    today as (select (now() at time zone 'Europe/Berlin')::date as t)
    select
      (select percentile_cont(0.5) within group (order by m) from d, today where day >= t - 30) as median30,
      (select min(m) from d, today where day >= t - 90) as low90,
      (select count(*) from d, today where day >= t - 90)::int as days90,
      (select m from d where day = (select (max(created_at) at time zone 'Europe/Berlin')::date from kb_analyses where product_id = ${productId})) as at_analysis`;
  const n = (x: unknown) => (x == null ? null : Number(x));
  return { atAnalysis: n(r?.at_analysis), median30: n(r?.median30), low90: n(r?.low90), days90: Number(r?.days90 ?? 0) };
}

/** Schwellen eines Produkts, wie sie für Stufen/Meldungen gelten (Analyse-Schwellen plausibilisiert, sonst unverändert) */
export async function effectiveThresholds(p: { id: string; threshold_good: number | null; threshold_top: number | null; threshold_instant: number | null;
  threshold_source?: string | null; thresholds_manual?: boolean; quantity: number | null; price_trend?: string | null }): Promise<Thresholds> {
  const t = { good: num(p.threshold_good), top: num(p.threshold_top), instant: num(p.threshold_instant) };
  if (p.threshold_source !== 'analysis' || p.thresholds_manual || t.good == null) return t;
  const stats = await priceStats(p.id, Number(p.quantity ?? 1) > 1);
  return clampThresholds(t, stats, p.price_trend ?? null);
}

const num = (x: unknown) => (x == null ? null : Number(x));
