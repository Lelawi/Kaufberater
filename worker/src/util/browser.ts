// Echter Browser (Chromium) für Seiten, die einfache Abrufe blockieren oder erst per JavaScript prüfen.
// Wird nur bei Bedarf geladen, weil er langsamer ist.
import type { Browser, BrowserContext } from 'playwright';

let browser: Browser | null = null;
const contexts = new Map<string, BrowserContext>();

const LOCALE: Record<string, { locale: string; tz: string }> = {
  DE: { locale: 'de-DE', tz: 'Europe/Berlin' }, AT: { locale: 'de-AT', tz: 'Europe/Vienna' }, FR: { locale: 'fr-FR', tz: 'Europe/Paris' },
  IT: { locale: 'it-IT', tz: 'Europe/Rome' }, ES: { locale: 'es-ES', tz: 'Europe/Madrid' }, NL: { locale: 'nl-NL', tz: 'Europe/Amsterdam' },
  BE: { locale: 'nl-BE', tz: 'Europe/Brussels' }, PL: { locale: 'pl-PL', tz: 'Europe/Warsaw' },
};

async function getContext(country: string): Promise<BrowserContext> {
  if (!browser) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
  }
  let ctx = contexts.get(country);
  if (!ctx) {
    const l = LOCALE[country] ?? LOCALE.DE;
    ctx = await browser.newContext({
      locale: l.locale, timezoneId: l.tz,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': `${l.locale},${l.locale.slice(0, 2)};q=0.9,en;q=0.7` },
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    // Bilder, Schriften, Videos nicht laden (schneller, weniger Datenverkehr)
    await ctx.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort();
      return route.continue();
    });
    contexts.set(country, ctx);
  }
  return ctx;
}

export interface BrowsePage { status: number; url: string; html: string; json: any[] }

/** Öffnet eine Seite im Browser; optional werden JSON-Antworten mitgeschnitten, deren URL auf captureRe passt */
export async function browse(url: string, opts: { country?: string; waitFor?: string; captureRe?: RegExp; timeoutMs?: number; settleMs?: number } = {}): Promise<BrowsePage> {
  const ctx = await getContext(opts.country ?? 'DE');
  const page = await ctx.newPage();
  const captured: any[] = [];
  if (opts.captureRe) {
    page.on('response', async (res) => {
      try {
        if (opts.captureRe!.test(res.url()) && (res.headers()['content-type'] ?? '').includes('json')) {
          captured.push({ url: res.url(), data: await res.json() });
        }
      } catch { /* ignorieren */ }
    });
  }
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? 45_000 });
    // JS-Prüfseiten (Akamai, Cloudflare) leiten nach ein paar Sekunden weiter
    for (let i = 0; i < 6; i++) {
      const html = await page.content();
      if (!/bm-verify|challenge-platform|cf-chl|Just a moment|_Incapsula_Resource|px-captcha/i.test(html) || html.length > 60_000) break;
      await page.waitForTimeout(2500);
    }
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(opts.settleMs ?? 1500);
    return { status: res?.status() ?? 0, url: page.url(), html: await page.content(), json: captured };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closeBrowser() {
  for (const c of contexts.values()) await c.close().catch(() => {});
  contexts.clear();
  if (browser) await browser.close().catch(() => {});
  browser = null;
}
