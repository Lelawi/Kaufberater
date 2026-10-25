// Ein kompletter Durchlauf: neue Produkte suchen → Preise abfragen → Deals → bewerten → benachrichtigen
import { db } from './db.ts';
import { runDiscovery } from './jobs/discovery.ts';
import { runChecks } from './jobs/check.ts';
import { runDeals } from './jobs/deals.ts';
import { runEvaluate } from './jobs/evaluate.ts';
import { deliverAlerts } from './jobs/alerts.ts';
import { runQuickChecks } from './jobs/quickcheck.ts';
import { cleanup } from './jobs/cleanup.ts';
import { runAutoThresholds } from './jobs/autothresholds.ts';
import { runTrends } from './jobs/trend.ts';
import { runDigest } from './jobs/digest.ts';
import { runVouchers } from './jobs/vouchers.ts';
import { stats as httpStats } from './util/http.ts';
import { preBlackWeekAnalysis } from './util/events.ts';
import { packBackfill } from './jobs/packbackfill.ts';

/** arg: "all" (Standard), "checks", "deals", "discovery", "quick", "product:<uuid>" */
export async function runAll(arg = '') {
  const sql = await db();
  const budgetMin = Number(process.env.KB_BUDGET_MINUTES ?? 12);
  const deadline = Date.now() + budgetMin * 60_000;
  const productId = arg.startsWith('product:') ? arg.slice(8) : undefined;
  const mode = productId ? 'product' : (arg || 'all');
  const run = await sql`insert into kb_runs (kind) values (${'run:' + mode + ':' + (process.env.KB_RUNNER ?? 'github')}) returning id`;
  const result: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    try { result[name] = await fn(); }
    catch (e) { result[name] = { error: (e as Error).message }; console.error(name, e); }
    result[name + '_s'] = Math.round((Date.now() - t0) / 1000);
  };
  try {
    await step('packs', () => packBackfill());
    if (['all', 'discovery', 'product'].includes(mode)) await step('discovery', () => runDiscovery(deadline, productId));
    if (['all', 'checks', 'product'].includes(mode)) await step('checks', () => runChecks(deadline, { productId }));
    // Deal-Portale: jedes Produkt höchstens etwa stündlich, pro Lauf begrenzte Anzahl (schont die Portale)
    if (['all', 'deals', 'product'].includes(mode)) await step('deals', () => runDeals(deadline, { productId }));
    if (mode === 'quick') { await step('quickchecks', () => runQuickChecks(deadline)); await step('alerts', () => deliverAlerts()); return; }
    await step('quickchecks', () => runQuickChecks(deadline));
    if (mode === 'all') await step('vouchers', () => runVouchers());
    await step('evaluate', () => runEvaluate({ productId }));
    // Neue Produkte bekommen sofort vorläufige Schwellen; danach noch einmal bewerten, damit Treffer gleich gemeldet werden
    await step('trends', () => runTrends({ productId }));
    await step('autothresholds', async () => { const r = await runAutoThresholds({ productId }); if (r.set) await runEvaluate({ productId }); return r; });
    if (mode === 'all') await step('digest', () => runDigest());
    // Vor der Black Week: Tiefenanalyse am Sonntag davor fällig machen, damit die Schwellen zum Start frisch sind
    const prep = mode === 'all' ? preBlackWeekAnalysis() : null;
    if (prep) await step('prep', async () => {
      const r = await sql`update kb_products p set analysis_due_at = ${prep}
        where status = 'watching' and analysis_due_at > ${prep}
          and coalesce((select max(created_at) from kb_analyses a where a.product_id = p.id), 'epoch') < ${prep}::timestamptz - interval '6 days'`;
      return { moved: r.count };
    });
    // Während des Laufs geändert (z. B. Produkt in der App ausgewählt oder Menge geändert)? Der Sofort-Start wird dann
    // gebremst (höchstens 1x pro Minute) – deshalb hier gleich noch einmal suchen, abfragen und bewerten
    if (productId) {
      const [again] = await sql`select 1 from kb_products where id = ${productId} and status = 'watching'
                                and (discovery_status = 'pending' or (threshold_good is null and not thresholds_manual))`;
      if (again) {
        await step('discovery2', () => runDiscovery(deadline, productId));
        await step('checks2', () => runChecks(deadline, { productId }));
        await step('evaluate2', () => runEvaluate({ productId }));
        await step('autothresholds2', () => runAutoThresholds({ productId }));
      }
    }
    await step('alerts', () => deliverAlerts());
    // Aufräumen einmal am Tag (nicht an die Uhrzeit koppeln – GitHub startet Läufe oft verspätet)
    if (mode === 'all') {
      const [done] = await sql`select 1 from kb_runs where stats ? 'cleanup' and started_at > now() - interval '20 hours' limit 1`;
      if (!done) await step('cleanup', () => cleanup());
    }
  } finally {
    result.http = httpStats();
    await sql`update kb_runs set finished_at = now(), stats = ${sql.json(result as any)} where id = ${run[0].id}`;
    console.log('::notice::' + JSON.stringify(result));
  }
}
