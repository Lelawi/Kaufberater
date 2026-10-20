// Ein kompletter Durchlauf: neue Produkte suchen → Preise abfragen → Deals → bewerten → benachrichtigen
import { db } from './db.ts';
import { runDiscovery } from './jobs/discovery.ts';
import { runChecks } from './jobs/check.ts';
import { runDeals } from './jobs/deals.ts';
import { runEvaluate } from './jobs/evaluate.ts';
import { deliverAlerts } from './jobs/alerts.ts';
import { runQuickChecks } from './jobs/quickcheck.ts';
import { cleanup } from './jobs/cleanup.ts';
import { stats as httpStats } from './util/http.ts';

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
    if (['all', 'discovery', 'product'].includes(mode)) await step('discovery', () => runDiscovery(deadline, productId));
    if (['all', 'checks', 'product'].includes(mode)) await step('checks', () => runChecks(deadline, { productId }));
    // Deal-Portale höchstens alle 30 Minuten (oder gezielt)
    const lastDeals = await sql`select max(started_at) as t from kb_runs where kind like 'run:%' and stats ? 'deals' and finished_at is not null`;
    const dealsDue = !lastDeals[0]?.t || Date.now() - new Date(lastDeals[0].t).getTime() > 28 * 60_000;
    if (mode === 'deals' || mode === 'product' || (mode === 'all' && dealsDue)) await step('deals', () => runDeals(deadline, { productId }));
    if (mode === 'quick') { await step('quickchecks', () => runQuickChecks(deadline)); await step('alerts', () => deliverAlerts()); return; }
    await step('quickchecks', () => runQuickChecks(deadline));
    await step('evaluate', () => runEvaluate({ productId }));
    await step('alerts', () => deliverAlerts());
    if (mode === 'all' && new Date().getMinutes() < 15) await step('cleanup', () => cleanup());
  } finally {
    result.http = httpStats();
    await sql`update kb_runs set finished_at = now(), stats = ${sql.json(result as any)} where id = ${run[0].id}`;
    console.log('::notice::' + JSON.stringify(result));
  }
}
