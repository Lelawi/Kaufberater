// Benachrichtigungen anlegen und per Push (iPhone/Browser) und E-Mail verschicken
import webpush from 'web-push';
import { db, workerConfig } from '../db.ts';

export interface NewAlert {
  userId: string;
  productId: string | null;
  kind: 'threshold' | 'deal' | 'price_protection' | 'successor' | 'analysis' | 'bundle' | 'quick_check' | 'voucher' | 'system';
  level: 'info' | 'good' | 'top' | 'instant' | 'warning';
  title: string;
  body?: string;
  url?: string | null;
  dedupKey: string;
}

/** Legt eine Benachrichtigung an (doppelte werden über dedupKey verhindert). Gibt 1 zurück, wenn neu. */
export async function createAlert(a: NewAlert): Promise<number> {
  const sql = await db();
  const r = await sql`
    insert into kb_alerts (user_id, product_id, kind, level, title, body, url, dedup_key)
    values (${a.userId}, ${a.productId}, ${a.kind}, ${a.level}, ${a.title.slice(0, 300)}, ${a.body?.slice(0, 2000) ?? null}, ${a.url ?? null}, ${a.dedupKey})
    on conflict (user_id, dedup_key) do nothing
    returning id`;
  return r.length;
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

const APP_URL = 'https://lelawi.github.io/kaufberater-app/';

export async function deliverAlerts() {
  const sql = await db();
  const pending = await sql`
    select a.*, s.push_alerts, s.email_alerts, s.alert_email, s.quiet_from::text as quiet_from, s.quiet_to::text as quiet_to, u.email as user_email
    from kb_alerts a
    left join kb_settings s on s.user_id = a.user_id
    join auth.users u on u.id = a.user_id
    where a.push_sent_at is null and a.created_at > now() - interval '2 days'
    order by a.created_at limit 100`;
  const stats = { push: 0, email: 0, failed: 0 };
  if (!pending.length) return stats;
  const pushOk = await initVapid();
  const mailer = await getMailer();
  for (const a of pending) {
    const quiet = a.level !== 'instant' && inQuietHours(a.quiet_from, a.quiet_to);
    if (quiet) continue;
    let sent = false;
    if (pushOk && a.push_alerts !== false) {
      const subs = await sql`select id, endpoint, p256dh, auth from kb_push_subscriptions where user_id = ${a.user_id} and fail_count < 10`;
      const payload = JSON.stringify({
        title: a.title, body: a.body ?? '', url: a.product_id ? `${APP_URL}#/p/${a.product_id}` : APP_URL, shopUrl: a.url,
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
  return stats;
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
