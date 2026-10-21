// Mitteilungen an die iPhone-App über Apples Push-Dienst (APNs) senden
import http2 from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import { db } from '../db.ts';

const TOPIC = process.env.APNS_TOPIC ?? 'de.lelawi.kaufberater';
const HOST = process.env.APNS_HOST ?? 'https://api.push.apple.com';   // TestFlight & App Store = Produktions-Umgebung

interface Cfg { key: string; key_id: string; team_id: string }
let cfg: Cfg | null | undefined;
let jwt: { token: string; at: number; for: string } | null = null;
let session: http2.ClientHttp2Session | null = null;

async function config(): Promise<Cfg | null> {
  if (cfg !== undefined) return cfg;
  const sql = await db();
  const [r] = await sql`select kb_apns_config() as c`;
  const c = r?.c as Partial<Cfg> | undefined;
  cfg = c?.key && c.key_id && c.team_id ? { key: normalizePem(c.key), key_id: c.key_id.trim(), team_id: c.team_id.trim() } : null;
  return cfg;
}

/** Schlüssel so reparieren, wie er beim Einfügen oft ankommt (eine Zeile, Leerzeichen statt Zeilenumbrüche, ohne Kopf/Fuß) */
export function normalizePem(raw: string): string {
  const body = raw.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/[^A-Za-z0-9+/=]/g, '');
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END PRIVATE KEY-----\n`;
}

function b64url(b: Buffer | string) { return Buffer.from(b).toString('base64url'); }

export function token(c: Cfg): string {
  // Apple erlaubt einen Schlüssel bis zu 60 Minuten – alle 40 Minuten neu erzeugen
  const id = c.key + c.key_id + c.team_id;
  if (jwt && jwt.for === id && Date.now() - jwt.at < 40 * 60_000) return jwt.token;
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: c.key_id }));
  const claims = b64url(JSON.stringify({ iss: c.team_id, iat: Math.floor(Date.now() / 1000) }));
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key: createPrivateKey(c.key), dsaEncoding: 'ieee-p1363' });
  jwt = { token: `${header}.${claims}.${b64url(sig)}`, at: Date.now(), for: id };
  return jwt.token;
}

/** Nur für Tests: Schlüssel direkt setzen statt aus der Datenbank */
export function useApnsConfig(c: Cfg) { cfg = { ...c, key: normalizePem(c.key) }; }

export async function apnsReady(): Promise<boolean> { return !!(await config()); }

export interface ApnsMessage { title: string; body: string; path?: string; badge?: number; collapseId?: string; urgent?: boolean }

/** Gibt den HTTP-Status zurück (200 = ok, 410/400 = Gerät abgemeldet) */
export async function sendApns(deviceToken: string, m: ApnsMessage): Promise<{ status: number; reason?: string }> {
  const c = await config();
  if (!c) return { status: 0, reason: 'kein APNs-Schlüssel' };
  if (!session || session.closed || session.destroyed) {
    session = http2.connect(HOST);
    session.on('error', () => { session = null; });
  }
  const payload = JSON.stringify({
    aps: { alert: { title: m.title.slice(0, 120), body: m.body.slice(0, 400) }, sound: 'default', ...(m.badge !== undefined ? { badge: m.badge } : {}),
           'thread-id': 'kaufberater', ...(m.urgent ? { 'interruption-level': 'time-sensitive' } : {}) },
    path: m.path ?? '#/',
  });
  let auth: string;
  try { auth = `bearer ${token(c)}`; } catch (e) { return { status: 403, reason: 'Schlüssel unlesbar: ' + (e as Error).message }; }
  return await new Promise((resolve) => {
    const req = session!.request({
      ':method': 'POST', ':path': `/3/device/${deviceToken}`,
      authorization: auth, 'apns-topic': TOPIC, 'apns-push-type': 'alert',
      'apns-priority': m.urgent ? '10' : '5', ...(m.collapseId ? { 'apns-collapse-id': m.collapseId.slice(0, 64) } : {}),
      'content-type': 'application/json',
    });
    let status = 0; let data = '';
    req.setTimeout(15_000, () => { req.close(); resolve({ status: 0, reason: 'Zeitüberschreitung' }); });
    req.on('response', (h) => { status = Number(h[':status']); });
    req.on('data', (d) => { data += d; });
    req.on('end', () => {
      let reason: string | undefined;
      try { reason = data ? JSON.parse(data).reason : undefined; } catch { /* */ }
      resolve({ status, reason });
    });
    req.on('error', (e) => resolve({ status: 0, reason: e.message }));
    req.end(payload);
  });
}

export function closeApns() { try { session?.close(); } catch { /* */ } session = null; }
