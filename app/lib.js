// Gemeinsame Bausteine: Datenbank-Verbindung, Formatierung, sicheres HTML
// Supabase-Bibliothek liegt lokal unter vendor/ (wird in index.html geladen)
const { createClient } = window.supabase;

export const SUPABASE_URL = 'https://obxwqvmmirmbfktjvhxf.supabase.co';
// Öffentlicher Schlüssel (darf im Code stehen; Zugriff regelt die Datenbank pro Benutzer)
export const SUPABASE_KEY = 'sb_publishable_z8qJ_vabWK3oWcczXR2YpQ_XVu7kO5s';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'kaufberater-auth' },
});

/** HTML-Vorlage mit automatischem Escaping aller eingesetzten Werte (Schutz vor eingeschleustem Code) */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += toHtml(values[i]);
  });
  return new Raw(out);
}
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));
function toHtml(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(toHtml).join('');
  return esc(String(v));
}
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** Nur http(s)-Links zulassen */
export function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : '#'; } catch { return '#'; }
}

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const eur0 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
export const fmtEur = (n) => (n === null || n === undefined || n === '' ? '–' : eur.format(Number(n)));
export const fmtEur0 = (n) => (n === null || n === undefined || n === '' ? '–' : eur0.format(Number(n)));

/** Preis im Etikett-Stil: große Euro, kleine Cent */
export function priceTag(n, cls = 'price-big') {
  if (n === null || n === undefined) return html`<span class="${cls} muted">–</span>`;
  const v = Number(n);
  const euros = Math.floor(v).toLocaleString('de-DE');
  const cents = Math.round((v - Math.floor(v)) * 100).toString().padStart(2, '0');
  return html`<span class="${cls}">${euros}<span class="price-cents">,${cents}</span>&nbsp;€</span>`;
}

export function fmtDate(d, opts = { day: '2-digit', month: '2-digit', year: 'numeric' }) {
  if (!d) return '–';
  return new Date(d).toLocaleDateString('de-DE', opts);
}
export function ago(d) {
  if (!d) return 'noch nie';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 90) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  if (s < 86400 * 30) return `vor ${Math.round(s / 86400)} Tag${Math.round(s / 86400) === 1 ? '' : 'en'}`;
  return fmtDate(d);
}
export function daysUntil(d) {
  if (!d) return null;
  const end = new Date(d); end.setHours(23, 59, 59);
  return Math.ceil((end.getTime() - Date.now()) / 86400000);
}

/** Einordnung eines Preises gegenüber den drei Schwellen */
export function levelOf(price, p) {
  if (price === null || price === undefined) return null;
  if (p.threshold_instant && price <= p.threshold_instant) return 'instant';
  if (p.threshold_top && price <= p.threshold_top) return 'top';
  if ((p.threshold_good ?? p.max_price) && price <= (p.threshold_good ?? p.max_price)) return 'good';
  return 'wait';
}
export const LEVEL_TEXT = { instant: 'Sofort zuschlagen', top: 'Top-Preis', good: 'Guter Preis', wait: 'Noch warten' };

export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/** Sehr kleines Markdown für die Analyse-Texte (Überschriften, Listen, fett, Links) – sicher escaped */
export function md(text) {
  if (!text) return '';
  const lines = esc(text).split(/\n/);
  let out = ''; let inList = false;
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  for (const l of lines) {
    const li = l.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    const h = l.match(/^(#{2,4})\s+(.*)/);
    if (h) { out += `<h4>${inline(h[2])}</h4>`; continue; }
    if (l.trim()) out += `<p>${inline(l)}</p>`;
  }
  if (inList) out += '</ul>';
  return out;
}

/** Nächster großer Aktionstag (Singles Day, Black Friday, Cyber Monday, Nach-Weihnachts-Sale) */
export function nextShoppingEvent(now = new Date()) {
  const evs = (y) => {
    const d = new Date(Date.UTC(y, 10, 1)); const thu = (4 - d.getUTCDay() + 7) % 7 + 1;
    const bf = new Date(Date.UTC(y, 10, thu + 22));
    return [['Singles Day', new Date(Date.UTC(y, 10, 11))], ['Black Friday', bf], ['Cyber Monday', new Date(+bf + 3 * 864e5)], ['Nach-Weihnachts-Sale', new Date(Date.UTC(y, 11, 27))]];
  };
  const all = [...evs(now.getUTCFullYear()), ...evs(now.getUTCFullYear() + 1)].filter(([, d]) => +d >= +now - 864e5).sort((a, b) => a[1] - b[1]);
  if (!all.length) return null;
  const [name, date] = all[0];
  return { name, date, days: Math.max(0, Math.ceil((+date - +now) / 864e5)) };
}
