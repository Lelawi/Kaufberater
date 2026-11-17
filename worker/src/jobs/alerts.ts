// Benachrichtigungen anlegen und per Push (iPhone/Browser) und E-Mail verschicken
import webpush from 'web-push';
import { db, workerConfig } from '../db.ts';
import { apnsReady, sendApns, closeApns } from '../util/apns.ts';
import { shouldNotify, prefsFromSettings } from '../util/notify.ts';
import { exactShop } from '../util/shop.ts';
import { hotWindow, offerMaxAge } from '../util/events.ts';

export interface NewAlert {
  userId: string;
  productId: string | null;
  kind: 'threshold' | 'deal' | 'price_protection' | 'successor' | 'analysis' | 'bundle' | 'quick_check' | 'voucher' | 'system' | 'digest';
  level: 'info' | 'good' | 'top' | 'instant' | 'warning';
  title: string;
  body?: string;
  url?: string | null;
  dedupKey: string;
  data?: Record<string, unknown> | null;   // strukturierte Inhalte für die App (z. B. Wochenüberblick)
}

/** Legt eine Benachrichtigung an (doppelte werden über dedupKey verhindert). Gibt 1 zurück, wenn neu. */
export async function createAlert(a: NewAlert): Promise<number> {
  const sql = await db();
  const r = await sql`
    insert into kb_alerts (user_id, product_id, kind, level, title, body, url, dedup_key, data)
    values (${a.userId}, ${a.productId}, ${a.kind}, ${a.level}, ${a.title.slice(0, 300)}, ${a.body?.slice(0, 2000) ?? null}, ${a.url ?? null}, ${a.dedupKey},
            ${a.data ? sql.json(a.data as any) : null})
    on conflict (user_id, dedup_key) do nothing
    returning id`;
  return r.length;
}

const RANK: Record<string, number> = { info: 0, good: 1, top: 2, instant: 3 };

/** Erneut melden nur bei spürbarer Verbesserung: ≥ 2 % oder ≥ 5 € (mindestens 1 €, bei Stückpreisen 10 Cent) */
export function enoughBetter(prev: number, now: number, perPiece = false): boolean {
  const need = Math.min(5, Math.max(prev * 0.02, perPiece ? 0.1 : 1));
  return prev - now >= need - 1e-9;
}

/**
 * Gibt es in den letzten 6 Std. schon eine Meldung (Deal oder Schwelle) zum selben Shop und Preis (±1 %) mit
 * gleicher oder höherer Stufe? Dann keine zweite (Review 17.11.: Deal und Schwelle meldeten denselben Preis doppelt).
 */
export async function similarRecentAlert(productId: string, price: number, shop: string | null | undefined, level: string): Promise<boolean> {
  if (!shop || !(price > 0)) return false;
  const sql = await db();
  const rows = await sql`select level, data from kb_alerts where product_id = ${productId} and kind in ('deal', 'threshold')
                         and created_at > now() - interval '6 hours' and data ? 'price'`;
  return rows.some((r) => {
    const d = r.data as { price?: number; shop?: string };
    return d.price != null && Math.abs(Number(d.price) - price) <= price * 0.01 && exactShop(d.shop, shop) && (RANK[r.level] ?? 0) >= (RANK[level] ?? 0);
  });
}

let vapidReady = false;
async function initVapid() {
  if (vapidReady) return true;
  const pub = await workerConfig('vapid_public');
  const priv = await workerConfig('vapid_private');
  const subj = (await workerConfig('vapid_subject')) ?? 'mailto:kaufberater@example.com';
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subj, pub, priv);
  vapidReady = true;
  return true;
}

function inQuietHours(from: string | null, to: string | null): boolean {
  if (!from || !to) return false;
  const now = new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour12: false }).slice(0, 5);
  const f = from.slice(0, 5); const t = to.slice(0, 5);
  return f < t ? now >= f && now < t : now >= f || now < t;
}

const APP_URL = 'https://lelawi.github.io/Kaufberater-app/';

export async function deliverAlerts() {
  const sql = await db();
  const pending = await sql`
    select a.*, s.push_alerts, s.email_alerts, s.notify_min_level, s.notify_quick_check, s.notify_important, s.notify_info, s.alert_email, s.quiet_from::text as quiet_from, s.quiet_to::text as quiet_to,
           kb_user_email(a.user_id) as user_email
    from kb_alerts a
    left join kb_settings s on s.user_id = a.user_id
    where a.push_sent_at is null and a.created_at > now() - interval '2 days'
    order by a.created_at limit 100`;
  const stats = { push: 0, email: 0, failed: 0 };
  if (!pending.length) return stats;
  const pushOk = await initVapid();
  const apnsOk = await apnsReady();
  const mailer = await getMailer();
  let apnsKeyError: string | null = null;
  const stats2 = { skipped: 0 };
  for (const a of pending) {
    // Nur Kaufsignale (bzw. was in den Einstellungen gewählt ist) als Push/E-Mail – in der App steht trotzdem alles
    if (!shouldNotify(a as any, prefsFromSettings(a))) {
      await sql`update kb_alerts set push_sent_at = now() where id = ${a.id}`;
      stats2.skipped++; continue;
    }
    // In der Black Week starten viele Aktionen um 0 Uhr → dann auch „Top-Preis“ nachts, sonst nur „Sofort zuschlagen“
    const nightOk = a.level === 'instant' || (a.level === 'top' && hotWindow() !== null);
    const quiet = !nightOk && inQuietHours(a.quiet_from, a.quiet_to);
    if (quiet) continue;
    // Aufgeschoben (Ruhezeit) oder älter: vor dem Senden prüfen, ob das Angebot noch da und nicht teurer ist
    if (Date.now() - new Date(a.created_at).getTime() > 20 * 60_000 && await isOutdated(a)) {
      await sql`update kb_alerts set push_sent_at = now(), level = 'info', title = left(title || ' (überholt)', 300) where id = ${a.id}`;
      stats2.skipped++; continue;
    }
    let sent = false;
    if (a.push_alerts !== false && apnsOk) {
      // iPhone-App (Apple Push)
      const devices = await sql`select id, endpoint from kb_push_subscriptions where user_id = ${a.user_id} and kind = 'apns' and fail_count < 10`;
      const [{ n: unread }] = await sql`select count(*)::int as n from kb_alerts where user_id = ${a.user_id} and read_at is null`;
      for (const d of devices) {
        const r = await sendApns(String(d.endpoint).replace(/^apns:/, ''), {
          title: a.title, body: a.body ?? '', path: a.product_id ? `#/p/${a.product_id}` : a.kind === 'digest' ? `#/w/${a.id}` : '#/alerts',
          badge: unread, collapseId: a.dedup_key, urgent: a.level === 'instant',
        });
        if (r.status === 200) { sent = true; stats.push++; await sql`update kb_push_subscriptions set last_ok_at = now(), fail_count = 0 where id = ${d.id}`; }
        else if (r.status === 410 || (r.status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(r.reason ?? ''))) {
          // Gerät abgemeldet / App gelöscht – die App meldet sich beim nächsten Start mit neuem Token wieder an
          await sql`delete from kb_push_subscriptions where id = ${d.id}`;
        } else if (r.status === 403 || /ProviderToken|TopicDisallowed/.test(r.reason ?? '')) {
          // Problem mit dem Schlüssel, nicht mit dem Gerät → Gerät behalten, einmal pro Tag Bescheid geben
          stats.failed++; apnsKeyError = r.reason ?? String(r.status);
        } else { stats.failed++; console.log('APNs:', r.status, r.reason); await sql`update kb_push_subscriptions set fail_count = fail_count + 1 where id = ${d.id}`; }
      }
    }
    if (pushOk && a.push_alerts !== false) {
      const subs = await sql`select id, endpoint, p256dh, auth from kb_push_subscriptions where user_id = ${a.user_id} and kind = 'web' and fail_count < 10`;
      const payload = JSON.stringify({
        title: a.title, body: a.body ?? '', url: a.product_id ? `${APP_URL}#/p/${a.product_id}` : a.kind === 'digest' ? `${APP_URL}#/w/${a.id}` : APP_URL, shopUrl: a.url,
        tag: a.dedup_key, level: a.level,
      });
      for (const s of subs) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600, urgency: a.level === 'instant' ? 'high' : 'normal' });
          await sql`update kb_push_subscriptions set last_ok_at = now(), fail_count = 0 where id = ${s.id}`;
          sent = true; stats.push++;
        } catch (e: any) {
          stats.failed++;
          if (e?.statusCode === 404 || e?.statusCode === 410) await sql`delete from kb_push_subscriptions where id = ${s.id}`;
          else await sql`update kb_push_subscriptions set fail_count = fail_count + 1 where id = ${s.id}`;
        }
      }
    }
    if (mailer && a.email_alerts && ['top', 'instant', 'warning'].includes(a.level) && !a.email_sent_at) {
      try {
        await mailer.send(a.alert_email || a.user_email, a.title, `${a.body ?? ''}\n\n${a.url ? 'Zum Angebot: ' + a.url + '\n' : ''}In der App: ${APP_URL}`);
        await sql`update kb_alerts set email_sent_at = now() where id = ${a.id}`;
        stats.email++;
      } catch (e) { console.log('E-Mail fehlgeschlagen:', (e as Error).message); }
    }
    await sql`update kb_alerts set push_sent_at = now() where id = ${a.id}`;
    void sent;
  }
  closeApns();
  (stats as any).skipped = stats2.skipped;
  if (apnsKeyError) {
    const day = new Date().toISOString().slice(0, 10);
    for (const u of new Set(pending.map((a) => a.user_id as string))) {
      await createAlert({ userId: u, productId: null, kind: 'system', level: 'warning',
        title: 'iPhone-Mitteilungen: Apple lehnt den Push-Schlüssel ab',
        body: `Apple meldet „${apnsKeyError}“. Bitte in den Einstellungen → Einrichtung den Apple-Push-Schlüssel (.p8), die Key-ID und die Team-ID prüfen und neu eintragen.`,
        url: null, dedupKey: `apnskey:${day}` });
    }
  }
  return stats;
}

/** Kaufsignal überholt? Schwelle: Angebot weg, nicht mehr bestätigt oder teurer; Deal: abgelaufen. */
async function isOutdated(a: Record<string, any>): Promise<boolean> {
  const sql = await db();
  const d = (a.data ?? {}) as { offer?: string; total?: number };
  if (a.kind === 'threshold' && d.offer) {
    const [o] = await sql`select gone, total, last_seen_at > now() - ${offerMaxAge()}::interval as fresh from kb_offers where id = ${d.offer}`;
    if (!o) return true;
    return o.gone || !o.fresh || (d.total != null && Number(o.total) > Number(d.total) + 0.01);
  }
  if (a.kind === 'deal' && typeof a.dedup_key === 'string' && a.dedup_key.startsWith('deal:')) {
    const [, portal, ext] = a.dedup_key.split(':');
    const [x] = await sql`select expired from kb_deals where product_id = ${a.product_id} and portal = ${portal} and external_id = ${ext}`;
    return !x || x.expired;
  }
  return false;
}

/** E-Mail-Versand über ein SMTP-Konto (z.B. web.de), falls in der Konfiguration hinterlegt */
async function getMailer(): Promise<{ send(to: string, subject: string, text: string): Promise<void> } | null> {
  const host = await workerConfig('smtp_host');
  const user = await workerConfig('smtp_user');
  const pass = await workerConfig('smtp_pass');
  if (!host || !user || !pass) return null;
  const nodemailer = await import('nodemailer');
  const t = nodemailer.createTransport({ host, port: Number((await workerConfig('smtp_port')) ?? 587), secure: false, auth: { user, pass } });
  return { async send(to, subject, text) { await t.sendMail({ from: `Kaufberater <${user}>`, to, subject, text }); } };
}
