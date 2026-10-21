// Webseiten abrufen wie ein normaler Browser: passende Header, Cookies, Pausen pro Seite, Wiederholungen

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
];
const UA = UAS[Math.floor(Math.random() * UAS.length)];

const LANG: Record<string, string> = {
  DE: 'de-DE,de;q=0.9,en;q=0.7', AT: 'de-AT,de;q=0.9,en;q=0.7', FR: 'fr-FR,fr;q=0.9,en;q=0.7', IT: 'it-IT,it;q=0.9,en;q=0.7',
  ES: 'es-ES,es;q=0.9,en;q=0.7', NL: 'nl-NL,nl;q=0.9,en;q=0.7', BE: 'nl-BE,fr-BE;q=0.9,en;q=0.7', PL: 'pl-PL,pl;q=0.9,en;q=0.7',
  UK: 'en-GB,en;q=0.9', CH: 'de-CH,de;q=0.9,en;q=0.7',
};

export class BlockedError extends Error {
  status: number;
  /** Zur Fehlersuche: Anfang der Sperrseite und Antwort-Kopfzeilen */
  body?: string; headers?: Record<string, string>; url?: string; sentHeaders?: Record<string, string>;
  constructor(msg: string, status: number) { super(msg); this.name = 'BlockedError'; this.status = status; }
}
export class HttpError extends Error {
  status: number;
  constructor(msg: string, status: number) { super(msg); this.name = 'HttpError'; this.status = status; }
}

export interface FetchOpts {
  country?: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  json?: boolean;          // Accept: application/json
  minDelayMs?: number;     // Mindestabstand zwischen Anfragen an dieselbe Seite
  retries?: number;
  timeoutMs?: number;
  allowStatus?: number[];  // diese Status nicht als Fehler werten
  referer?: string;
}

export interface Page { status: number; url: string; text: string; headers: Headers }

const lastHit = new Map<string, number>();
const cookies = new Map<string, Map<string, string>>();
let requestCount = 0;

function baseDomain(host: string): string {
  const parts = host.split('.');
  return parts.slice(-2).join('.');
}

async function throttle(host: string, minDelay: number) {
  const key = baseDomain(host);
  const last = lastHit.get(key) ?? 0;
  const wait = last + minDelay + Math.random() * minDelay * 0.5 - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(key, Date.now());
}

export function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function cookieHeader(host: string): string | undefined {
  const jar = cookies.get(baseDomain(host));
  if (!jar || !jar.size) return undefined;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(host: string, h: Headers) {
  const list = (h as any).getSetCookie?.() as string[] | undefined;
  if (!list?.length) return;
  const key = baseDomain(host);
  const jar = cookies.get(key) ?? new Map<string, string>();
  for (const c of list) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  cookies.set(key, jar);
}

export function setCookie(host: string, name: string, value: string) {
  const key = baseDomain(host);
  const jar = cookies.get(key) ?? new Map<string, string>();
  jar.set(name, value);
  cookies.set(key, jar);
}

const BLOCK_MARKERS = [
  /captcha/i, /robot check/i, /are you a robot/i, /cf-chl/i, /challenge-platform/i, /px-captcha/i, /datadome/i,
  /Access Denied/i, /Request unsuccessful\. Incapsula/i, /_Incapsula_Resource/i, /Attention Required! \| Cloudflare/i,
  /api-services-support@amazon\.com/i, /automated access/i, /Bitte bestätigen Sie, dass Sie kein Roboter sind/i,
];

export function looksBlocked(status: number, text: string): boolean {
  if (status === 403 || status === 429 || status === 503) {
    return BLOCK_MARKERS.some((re) => re.test(text.slice(0, 200_000))) || text.length < 5000;
  }
  if (status === 200 && text.length < 20_000) return BLOCK_MARKERS.slice(0, 13).some((re) => re.test(text));
  return false;
}

export async function fetchPage(url: string, opts: FetchOpts = {}): Promise<Page> {
  const retries = opts.retries ?? 2;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let current = url;
    try {
      // Weiterleitungen selbst verfolgen, damit Cookies erhalten bleiben
      for (let hop = 0; hop < 8; hop++) {
        const u = new URL(current);
        await throttle(u.host, opts.minDelayMs ?? 2500);
        requestCount++;
        const headers: Record<string, string> = {
          'User-Agent': UA,
          'Accept': opts.json ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': LANG[opts.country ?? 'DE'] ?? LANG.DE,
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          ...(opts.json ? {} : { 'Upgrade-Insecure-Requests': '1', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': opts.referer ? 'same-origin' : 'none', 'Sec-Fetch-User': '?1' }),
          ...(opts.referer ? { Referer: opts.referer } : {}),
          ...(opts.headers ?? {}),
        };
        const ck = cookieHeader(u.host);
        if (ck && !headers.Cookie) headers.Cookie = ck;
        const res = await fetch(current, {
          method: opts.method ?? 'GET', headers, body: opts.body, redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
        });
        storeCookies(u.host, res.headers);
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          current = new URL(res.headers.get('location')!, current).toString();
          await res.arrayBuffer().catch(() => {});
          continue;
        }
        const text = await res.text();
        if (looksBlocked(res.status, text)) {
          const be = new BlockedError(`blockiert (${res.status}) bei ${u.host}`, res.status);
          be.body = text.slice(0, 4000); be.url = current; be.headers = Object.fromEntries(res.headers.entries());
          be.sentHeaders = { ...headers, Cookie: headers.Cookie ? '(gesetzt)' : '' };
          throw be;
        }
        if (res.status >= 400 && !(opts.allowStatus ?? []).includes(res.status)) {
          throw new HttpError(`HTTP ${res.status} bei ${current}`, res.status);
        }
        return { status: res.status, url: current, text, headers: res.headers };
      }
      throw new HttpError('zu viele Weiterleitungen', 310);
    } catch (e) {
      lastErr = e as Error;
      const status = (e as any).status as number | undefined;
      if (e instanceof BlockedError) {
        if (attempt >= 1) throw e;
        await sleep(8000 + Math.random() * 6000);
        continue;
      }
      if (status && status >= 400 && status < 500 && status !== 429 && status !== 408) throw e;
      await sleep(2000 * (attempt + 1) + Math.random() * 2000);
    }
  }
  throw lastErr ?? new Error('Abruf fehlgeschlagen');
}

export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const p = await fetchPage(url, { ...opts, json: true });
  try { return JSON.parse(p.text) as T; }
  catch { throw new HttpError(`keine JSON-Antwort von ${url}: ${p.text.slice(0, 120)}`, p.status); }
}

export function stats() { return { requests: requestCount }; }
