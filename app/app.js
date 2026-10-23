// Kaufberater – App (läuft komplett im Browser, Daten liegen in Supabase)
import { sb, html, raw, esc, safeUrl, fmtEur, fmtEur0, priceTag, fmtDate, ago, daysUntil, levelOf, LEVEL_TEXT, toast, md, nextShoppingEvent, hotWindow, packText, cheapestBasket, basketText } from './lib.js';
import { ladder, priceChart } from './chart.js';

/** Läuft die Oberfläche in der iPhone-App (statt im Browser)? */
const NATIVE = window.kbNative?.platform === 'ios' ? window.kbNative : null;

// iPhone-Web-App (Home-Bildschirm): Shop-Links öffnen sonst in einem eingeblendeten Browserfenster, das beim Zurückwechseln
// stehen bleibt und per ✕ geschlossen werden muss. Ab iOS 17 lassen sie sich direkt in Safari öffnen (x-safari-https://).
// Klappt das nicht (Seite bleibt sichtbar), wird wie bisher geöffnet.
{
  const iosMajor = Number((navigator.userAgent.match(/OS (\d+)_\d/) ?? [])[1] ?? 0);
  if (!NATIVE && navigator.standalone === true && /iP(hone|ad|od)/.test(navigator.userAgent) && iosMajor >= 17) {
    document.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[target="_blank"]');
      if (!a || !/^https?:/.test(a.href) || new URL(a.href).host === location.host) return;
      e.preventDefault();
      const href = a.href;
      location.href = 'x-safari-' + href;
      setTimeout(() => { if (document.visibilityState === 'visible') window.open(href, '_blank', 'noopener'); }, 900);
    });
  }
}
if (NATIVE) {
  // Neuer Token von Apple (z. B. nach Neuinstallation) → speichern
  NATIVE.onPushToken = (token) => { if (session) saveApnsToken(token).catch(() => {}); };
}
const view = document.getElementById('view');
const tabs = document.getElementById('tabs');
let session = null;
let member = null;   // freigeschaltet? (wird beim ersten Aufruf geprüft)

// ---------- Start ----------
if ('serviceWorker' in navigator && !NATIVE) navigator.serviceWorker.register('sw.js').catch(() => {});
session = (await sb.auth.getSession()).data.session;
sb.auth.onAuthStateChange((ev, s) => {
  if (ev === 'INITIAL_SESSION') return;
  const was = !!session; session = s; member = null;
  if (!!s !== was) { route(); if (s) syncNativeToken(); }
});
syncNativeToken();

/** iPhone-App: Geräte-Schlüssel nach dem Start/der Anmeldung abholen und speichern (falls er vor dem Laden der Seite kam) */
async function syncNativeToken() {
  if (!NATIVE || !session) return;
  try { const t = await NATIVE.call('push-token'); if (t) await saveApnsToken(t); } catch { /* ältere App-Version */ }
}
window.addEventListener('hashchange', route);
route();
setInterval(refreshBadge, 60_000);

function render(content) { view.innerHTML = String(content); view.focus({ preventScroll: true }); }
function setTab(name) { tabs.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.tab === name)); }
function loading(text = 'Lädt …') { render(html`<div class="loading"><span class="spinner"></span>${text}</div>`); }

async function route() {
  if (!session) { tabs.hidden = true; return viewLogin(); }
  tabs.hidden = false;
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  const [, a, b] = path.split('/');
  const params = new URLSearchParams(qs ?? '');
  if (a !== 'settings' && !(await isMember())) {
    setTab(a === 'settings' ? 'settings' : 'list');
    return render(html`<div class="empty"><h2>Noch nicht freigeschaltet</h2><p>Der Kaufberater ist ein privates Projekt. Dein Konto (${session.user.email}) ist dafür noch nicht freigeschaltet.</p><a class="btn ghost" href="#/settings">Einstellungen / Abmelden</a></div>`);
  }
  try {
    if (!a) { setTab('list'); await viewList(); }
    else if (a === 'add') { setTab('list'); await viewEdit(null, params); }
    else if (a === 'edit') { setTab('list'); await viewEdit(b); }
    else if (a === 'p') { setTab('list'); await viewProduct(b); }
    else if (a === 'check') { setTab('check'); await viewCheck(params); }
    else if (a === 'alerts') { setTab('alerts'); await viewAlerts(); }
    else if (a === 'settings') { setTab('settings'); await viewSettings(); }
    else location.hash = '#/';
  } catch (e) {
    console.error(e);
    render(html`<div class="empty"><h2>Das hat nicht geklappt</h2><p>${e.message ?? String(e)}</p><a class="btn ghost" href="#/">Zur Liste</a></div>`);
  }
  refreshBadge();
  window.scrollTo(0, 0);
}

/** Darf dieses Konto den Kaufberater nutzen? (Freischaltliste kb_members) */
async function isMember() {
  if (member === null) { const { data, error } = await sb.rpc('kb_is_member'); member = error ? true : data !== false; }
  return member;
}

async function refreshBadge() {
  if (!session) return;
  const { count } = await sb.from('kb_alerts').select('id', { count: 'exact', head: true }).is('read_at', null);
  const b = document.getElementById('alertBadge');
  b.hidden = !count; b.textContent = count > 99 ? '99+' : String(count ?? '');
  if (window.kbNative?.platform === 'ios') window.kbNative.call('badge', { count: count ?? 0 }).catch(() => {});
  else if (navigator.setAppBadge) (count ? navigator.setAppBadge(count) : navigator.clearAppBadge?.()).catch?.(() => {});
}

// ---------- Anmeldung ----------
function viewLogin(mode = 'login') {
  const signup = mode === 'signup';
  render(html`<div class="login">
    <img class="mark" src="icons/icon-192.png" alt="">
    <h1>Kaufberater</h1>
    <p>Trag ein, was du kaufen willst. Die App beobachtet die Preise und meldet sich, wenn es sich lohnt.</p>
    <form id="f">
      <div class="field"><label for="email">E-Mail</label><input id="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="pw">Passwort${signup ? html` <span class="muted">(mind. 8 Zeichen)</span>` : ''}</label><input id="pw" type="password" minlength="${signup ? 8 : 1}" autocomplete="${signup ? 'new-password' : 'current-password'}" required></div>
      <button class="btn block" type="submit">${signup ? 'Konto erstellen' : 'Anmelden'}</button>
      <p id="err" class="hint" style="margin-top:12px" role="alert"></p>
      <p class="hint" style="margin-top:12px">${signup ? html`Schon ein Konto? <a href="#" id="sw">Anmelden</a>` : html`Gleiches Konto wie bei MarsiHome.<a href="#" id="sw" hidden></a>`}</p>
    </form></div>`);
  document.getElementById('sw').addEventListener('click', (e) => { e.preventDefault(); viewLogin(signup ? 'login' : 'signup'); });
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('err'); err.style.color = 'var(--warn)';
    const btn = e.target.querySelector('button'); btn.disabled = true;
    const email = document.getElementById('email').value.trim(); const password = document.getElementById('pw').value;
    if (signup) {
      const { data, error } = await sb.auth.signUp({ email, password });
      btn.disabled = false;
      if (error) { err.textContent = error.message; return; }
      if (!data.session) {
        err.style.color = 'var(--ink-2)';
        err.textContent = 'Fast geschafft: Du bekommst eine E-Mail. Tippe dort auf den Bestätigungslink (die Seite danach kannst du schließen) und melde dich dann hier an.';
        setTimeout(() => viewLogin('login'), 9000);
      }
      return;
    }
    const { error } = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    if (error) err.textContent = error.message === 'Invalid login credentials' ? 'E-Mail oder Passwort stimmt nicht.' : error.message === 'Email not confirmed' ? 'Bitte zuerst den Link in der Bestätigungs-E-Mail antippen.' : error.message;
  });
}

// ---------- Wunschliste ----------
async function viewList() {
  loading();
  const { data: products, error } = await sb.from('kb_products')
    .select('id,name,brand,model,status,window_start,window_end,window_type,threshold_good,threshold_top,threshold_instant,max_price,best_price,best_refurb_price,lowest_seen,last_checked_at,discovery_status,analysis_status,bought_price,bought_at,return_until,include_refurb,created_at,quantity,best_basket,image_url,name_suggestions,name_confirmed')
    .order('created_at', { ascending: false });
  if (error) throw error;
  // Preisentwicklung der letzten Woche
  const { data: trends } = await sb.rpc('kb_trends');
  const trendMap = new Map((trends ?? []).map((t) => [t.product_id, t]));
  for (const p of products) { const t = trendMap.get(p.id); if (t?.price_7d && p.best_price) p.trend7 = Number(p.best_price) - Number(t.price_7d); }
  const archived = products.filter((p) => p.status === 'archived');
  if (!products.some((p) => p.status !== 'archived')) {
    return render(html`<div class="head"><h1>Wunschliste</h1></div>
      <div class="empty panel"><h2>Noch nichts auf der Liste</h2>
      <p>Trag das erste Produkt ein, am besten mit genauer Modellnummer. Die App sucht dann alle Angebote und richtet die Preisüberwachung ein.</p>
      <a class="btn" href="#/add">Produkt eintragen</a></div>${archiveBlock(archived)}`);
  }
  const watching = products.filter((p) => p.status === 'watching');
  const hot = watching.filter((p) => ['instant', 'top', 'good'].includes(levelOf(p.best_price, p)));
  const rest = watching.filter((p) => !hot.includes(p));
  const paused = products.filter((p) => p.status === 'paused');
  const bought = products.filter((p) => p.status === 'bought');
  const group = (title, list, hint) => list.length ? html`<div class="group-title">${title} <span class="count">${list.length}</span></div>${hint ? html`<p class="hint" style="margin:-4px 0 8px">${hint}</p>` : ''}<div class="rows">${list.map(row)}</div>` : '';
  const lastCheck = watching.map((p) => p.last_checked_at).filter(Boolean).sort().pop();
  // Black Friday ist in Deutschland der wichtigste Aktionstag → hat Vorrang, sobald er in Sicht ist
  const bf = nextShoppingEvent(); const bfOnly = (() => { let d = new Date(); for (let i = 0; i < 6; i++) { const e = nextShoppingEvent(d); if (!e) return null; if (e.name === 'Black Friday') return e.days <= 45 ? { ...e, days: Math.ceil((+e.date - Date.now()) / 864e5) } : null; d = new Date(+e.date + 864e5); } return null; })();
  const ev = bfOnly ?? bf;
  render(html`<div class="head"><div><h1>Wunschliste</h1><div class="sub">${watching.length} beobachtet${lastCheck ? html` · Preise ${ago(lastCheck)}` : ''}</div></div><a class="btn" href="#/add">Eintragen</a></div>
    ${hotWindow() ? html`<p class="event-note"><strong>${hotWindow()} läuft:</strong> Preise und Deals werden jetzt häufiger geprüft – bei einem Treffer meldet sich die App sofort.</p>`
      : ev && ev.days <= 45 ? html`<p class="event-note"><strong>${ev.name}</strong> ${ev.days === 0 ? 'ist heute' : ev.days === 1 ? 'ist morgen' : html`in ${ev.days} Tagen`} (${fmtDate(ev.date, { day: 'numeric', month: 'long' })}) – viele Händler senken die Preise schon einige Tage vorher.</p>` : ''}
    ${group('Jetzt interessant', hot)}
    ${group('Beobachten', rest)}
    ${group('Gekauft – Preisschutz aktiv', bought, 'Wird bis zum Ende der Rückgabefrist weiter beobachtet.')}
    ${group('Pausiert', paused)}
    ${archiveBlock(archived)}`);
  bindArchive();
  showPushHint();
}

function archiveBlock(list) {
  if (!list.length) return '';
  return html`<details class="more" style="margin-top:24px"><summary>Archiv (${list.length})</summary>
    <ul class="list-plain panel flat">${list.map((p) => html`<li><span>${p.name}</span><span class="btn-row">
      <button class="btn small ghost" data-restore="${p.id}">Wiederherstellen</button>
      <button class="btn small danger" data-del="${p.id}" data-name="${p.name}">Löschen</button></span></li>`)}</ul></details>`;
}
function bindArchive() {
  view.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    await sb.from('kb_products').update({ status: 'watching' }).eq('id', b.dataset.restore); toast('Wird wieder beobachtet'); route();
  }));
  view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteProduct(b.dataset.del, b.dataset.name)));
}
async function deleteProduct(id, name) {
  if (!confirm(`„${name}“ endgültig löschen? Preisverlauf und Analysen gehen verloren.`)) return;
  const { error } = await sb.from('kb_products').delete().eq('id', id);
  toast(error ? error.message : 'Gelöscht'); if (!error) { location.hash = '#/'; route(); }
}
/** Hinweis oben in der Liste, solange auf diesem Gerät keine Push-Nachrichten eingeschaltet sind */
async function showPushHint() {
  try {
    if (localStorage.getItem('kb-push-hint') === 'off') return;
    const state = await currentPushState();
    if (state !== 'off' && !(state === 'unsupported' && /iPhone|iPad/.test(navigator.userAgent))) return;
    if (document.getElementById('pushHint')) return;
    const box = document.createElement('div');
    box.className = 'panel flat'; box.id = 'pushHint';
    box.innerHTML = String(html`<p style="margin:0 0 8px"><strong>Push-Nachrichten sind noch aus.</strong> Sonst verpasst du Tiefstpreise, die nur ein paar Stunden halten.</p>
      <div class="btn-row"><a class="btn small" href="#/settings">Einschalten</a><button class="btn small ghost" id="hintOff">Nicht mehr zeigen</button></div>`);
    view.querySelector('.head')?.after(box);
    box.querySelector('#hintOff').onclick = () => { try { localStorage.setItem('kb-push-hint', 'off'); } catch { /* */ } box.remove(); };
  } catch { /* Hinweis ist optional */ }
}

function row(p) {
  const lvl = p.status === 'bought' ? null : levelOf(p.best_price, p);
  let meta = [];
  if (!p.best_price) meta.push(p.discovery_status === 'pending' || p.discovery_status === 'running' ? 'Angebote werden gesucht …' : 'Noch kein Angebot gefunden');
  else if (p.status === 'watching' && !p.threshold_good && !p.max_price) meta.push('Kaufschwellen werden berechnet …');
  if (p.window_end && p.status === 'watching') {
    const d = daysUntil(p.window_end);
    meta.push(d < 0 ? 'Zeitraum vorbei' : `Kauf bis ${fmtDate(p.window_end, { day: 'numeric', month: 'short' })}${p.window_type === 'hard' ? ' (fest)' : ''}`);
  }
  if (p.status === 'bought' && p.return_until) meta.push(`Rückgabe bis ${fmtDate(p.return_until, { day: 'numeric', month: 'short' })}`);
  if (p.best_refurb_price && p.include_refurb && p.status === 'watching') meta.push(`Refurbished ab ${fmtEur0(p.best_refurb_price)}`);
  if (p.name_suggestions?.length && !p.name_confirmed && p.status === 'watching') meta.unshift('Welches Produkt genau? Bitte bestätigen');
  if (p.quantity > 1 && p.status === 'watching') meta.unshift(p.best_basket ? `${p.quantity} Stück: ${fmtEur0(p.best_basket.effective ?? p.best_basket.total)}` : `${p.quantity} Stück`);
  if (p.trend7 && Math.abs(p.trend7) >= 1 && p.status === 'watching') meta.unshift(p.trend7 < 0 ? `↓ ${fmtEur0(-p.trend7)} in 7 Tagen` : `↑ ${fmtEur0(p.trend7)} in 7 Tagen`);
  const price = p.status === 'bought' ? p.bought_price : p.best_price;
  return html`<a class="row" href="#/p/${p.id}">
    ${thumb(p)}
    <div class="name">${p.name}</div>
    <div class="price">${lvl === 'instant' ? html`<span class="tag-instant">${priceTag(price, 'price-mid')}</span>` : priceTag(price, 'price-mid')}
      <div class="price-sub">${p.status === 'bought' ? 'bezahlt' : html`${p.quantity > 1 && price ? 'pro Stück ' : ''}${lvl ? html`<span class="pill ${lvl}">${LEVEL_TEXT[lvl]}</span>` : ''}`}</div></div>
    <div class="meta">${meta.join(' · ')}</div>
    ${p.status === 'watching' ? raw(ladder(p, p.best_price)) : ''}
  </a>`;
}

/** Vorschaubild (oder Anfangsbuchstabe, solange noch keins gefunden ist) */
function thumb(p, cls = 'thumb') {
  const letter = ((p.name || '').trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '•').toUpperCase();
  // Bild lädt nicht (Shop blockt Einbinden) → Anfangsbuchstabe (siehe Fehler-Listener unten)
  if (p.image_url) return html`<img class="${cls}" src="${safeUrl(p.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-letter="${letter}">`;
  return html`<span class="${cls} ph" aria-hidden="true">${letter}</span>`;
}
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.letter) return;
  const span = document.createElement('span');
  span.className = img.className + ' ph'; span.textContent = img.dataset.letter; span.setAttribute('aria-hidden', 'true');
  img.replaceWith(span);
}, true);

// ---------- Eintragen / Bearbeiten ----------
async function viewEdit(id, params = new URLSearchParams()) {
  let p = { name: '', brand: '', model: '', ean: '', notes: '', window_type: 'soft', include_refurb: false, want_alternative: true, search_terms: [], exclude_terms: [], quantity: 1 };
  if (id) {
    loading();
    const { data, error } = await sb.from('kb_products').select('*').eq('id', id).single();
    if (error) throw error;
    p = data;
  }
  const v = (x) => x ?? '';
  render(html`<a class="back" href="${id ? '#/p/' + id : '#/'}">Zurück</a>
  <div class="head"><h1>${id ? 'Bearbeiten' : 'Produkt eintragen'}</h1></div>
  <form id="f" class="panel">
    <div class="field"><label for="name">Was willst du kaufen?</label>
      <input id="name" type="text" ${id ? 'required' : ''} value="${v(p.name)}" placeholder="z. B. LG OLED77G6">
      <div class="hint">Je genauer, desto besser: Hersteller und Modellnummer.${id ? '' : ' Oder leer lassen und unten nur einen Link einfügen.'}</div></div>
    <div class="grid-2">
      <div class="field"><label for="brand">Hersteller <span class="muted">(optional)</span></label><input id="brand" type="text" value="${v(p.brand)}" placeholder="LG"></div>
      <div class="field"><label for="model">Modellnummer <span class="muted">(optional)</span></label><input id="model" type="text" value="${v(p.model)}" placeholder="OLED77G6"></div>
    </div>
    ${id ? '' : html`<div class="field"><label for="link">Link zum Produkt <span class="muted">(optional)</span></label><input id="link" type="url" placeholder="https://…" value="${params.get('u') ?? ''}"><div class="hint">Shop-, idealo- oder Amazon-Link. Wird zusätzlich überwacht.</div></div>`}
    <div class="field"><label>Wann willst du kaufen?</label>
      <div class="grid-2">
        <div><label for="ws" class="muted" style="font-weight:400">frühestens</label><input id="ws" type="date" value="${v(p.window_start)}"></div>
        <div><label for="we" class="muted" style="font-weight:400">spätestens</label><input id="we" type="date" value="${v(p.window_end)}"></div>
      </div>
      <div class="seg" style="margin-top:10px" role="radiogroup" aria-label="Art des Zeitraums">
        <label><input type="radio" name="wt" value="soft" ${p.window_type !== 'hard' ? 'checked' : ''}><span>Nur wenn es sich lohnt</span></label>
        <label><input type="radio" name="wt" value="hard" ${p.window_type === 'hard' ? 'checked' : ''}><span>Muss bis dahin da sein</span></label>
      </div>
      <div class="hint">Leer lassen, wenn es keine Eile hat.</div></div>
    <div class="field"><label for="qty">Wie viele brauchst du?</label><input id="qty" type="number" inputmode="numeric" step="1" min="1" max="1000" value="${v(p.quantity ?? 1)}" style="max-width:120px">
      <div class="hint">Bei mehr als 1 (z. B. 40 Lampen) vergleicht die App Einzelstücke und Mehrfachpackungen pro Stück und rechnet je Händler den günstigsten Einkauf für die ganze Menge aus. Schwellen gelten dann pro Stück.</div></div>
    <div class="field"><label for="max">Höchstens ausgeben <span class="muted">(optional${p.quantity > 1 ? ', insgesamt' : ''})</span></label><input id="max" type="number" inputmode="decimal" step="1" min="0" value="${v(p.max_price)}" placeholder="€"></div>
    <div class="field"><label class="check"><input id="refurb" type="checkbox" ${p.include_refurb ? 'checked' : ''}> Auch Refurbished, B-Ware und Warehouse-Angebote zeigen (getrennt von Neuware)</label></div>
    <div class="field"><label class="check"><input id="alt" type="checkbox" ${p.want_alternative ? 'checked' : ''}> Bei der Analyse nach einer günstigeren, gleichwertigen Alternative suchen</label></div>
    <details class="more" ${id ? 'open' : ''}><summary>Mehr Optionen</summary>
      <div class="field"><label for="terms">Weitere Modellnummern / Varianten <span class="muted">(Komma-getrennt)</span></label>
        <input id="terms" type="text" value="${(p.search_terms ?? []).join(', ')}" placeholder="OLED77G68LW, OLED77G67LW">
        <div class="hint">Gleiches Gerät unter anderem Namen (je nach Händler). Die Analyse ergänzt das automatisch.</div></div>
      <div class="field"><label for="excl">Ausschließen, wenn im Titel <span class="muted">(Komma-getrennt)</span></label><input id="excl" type="text" value="${(p.exclude_terms ?? []).join(', ')}" placeholder="Wandhalterung, Ersatzteil"></div>
      <div class="field"><label for="ean">EAN / Barcode <span class="muted">(optional)</span></label><input id="ean" type="text" inputmode="numeric" value="${v(p.ean)}"></div>
      <div class="field"><label for="notes">Notizen für die Analyse <span class="muted">(optional)</span></label><textarea id="notes" placeholder="z. B. Farbe egal, Wandmontage geplant">${v(p.notes)}</textarea></div>
    </details>
    <div class="btn-row" style="margin-top:8px"><button class="btn" type="submit">${id ? 'Speichern' : 'Eintragen und Suche starten'}</button></div>
  </form>`);
  const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const g = (x) => document.getElementById(x);
    const row = {
      name: g('name').value.trim(), brand: g('brand').value.trim() || null, model: g('model').value.trim() || null,
      ean: g('ean').value.trim() || null, notes: g('notes').value.trim() || null,
      window_start: g('ws').value || null, window_end: g('we').value || null,
      window_type: document.querySelector('input[name=wt]:checked').value,
      max_price: g('max').value ? Number(g('max').value) : null,
      quantity: Math.min(1000, Math.max(1, Math.round(Number(g('qty').value) || 1))),
      include_refurb: g('refurb').checked, want_alternative: g('alt').checked,
      search_terms: split(g('terms').value), exclude_terms: split(g('excl').value),
    };
    const linkVal = g('link')?.value.trim();
    if (!row.name) {
      if (!linkVal) { toast('Bitte einen Namen oder einen Link eingeben'); return; }
      // Vorläufiger Name aus dem Link; der richtige Name kommt nach dem ersten Abruf der Seite
      let slug = '';
      try { const u = new URL(linkVal); slug = decodeURIComponent(u.pathname.split('/').filter((x) => /[a-z].*-.*[a-z]/i.test(x) && !/^(dp|p|product|produkt)$/i.test(x)).sort((a, b) => b.length - a.length)[0] ?? '').replace(/\.html?$/, '').replace(/[-_]+/g, ' '); row.name = (slug || u.host.replace(/^www\./, '') + ' Produkt').slice(0, 120); } catch { row.name = 'Neues Produkt'; }
      row.name_auto = true;
    }
    if (!row.model) { const m = row.name.match(/\b([A-Z]{0,6}\d{2,}[A-Z0-9-]{2,})\b/i); if (m) row.model = m[1].toUpperCase(); }
    const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
    let res;
    if (id) {
      const changedSearch = row.name !== p.name || row.model !== p.model || JSON.stringify(row.search_terms) !== JSON.stringify(p.search_terms)
        || row.quantity !== (p.quantity ?? 1);   // Menge geändert: Packungsgrößen neu suchen und neu bewerten
      // Menge geändert → Schwellen gelten jetzt pro Stück bzw. wieder pro Gerät: neu berechnen lassen
      if ((row.quantity > 1) !== (p.quantity > 1) && !p.thresholds_manual) Object.assign(row, { threshold_good: null, threshold_top: null, threshold_instant: null, threshold_source: null });
      if ((row.quantity > 1) !== (p.quantity > 1)) Object.assign(row, { lowest_seen: null, lowest_seen_at: null });
      if (changedSearch) Object.assign(row, { discovery_status: 'pending', analysis_status: 'queued', analysis_due_at: new Date().toISOString() });
      res = await sb.from('kb_products').update(row).eq('id', id).select('id').single();
    } else {
      // Schon auf der Liste? (gleiche Modellnummer oder sehr ähnlicher Name)
      const key = (x) => String(x ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const { data: existing } = await sb.from('kb_products').select('id,name,model,status').neq('status', 'archived');
      const dupe = (existing ?? []).find((x) => (row.model && key(x.model) && (key(x.model).includes(key(row.model)) || key(row.model).includes(key(x.model))))
        || key(x.name) === key(row.name));
      if (dupe && !confirm(`„${dupe.name}“ steht schon auf deiner Liste. Trotzdem noch einmal eintragen?`)) { btn.disabled = false; location.hash = '#/p/' + dupe.id; return; }
      res = await sb.from('kb_products').insert(row).select('id').single();
    }
    if (res.error) { btn.disabled = false; return toast(res.error.message); }
    if (linkVal) await sb.rpc('kb_add_listing', { p_product: res.data.id, p_url: linkVal });
    toast(id ? 'Gespeichert' : 'Eingetragen – die Preissuche startet gleich');
    location.hash = '#/p/' + res.data.id;
  });
}

// ---------- Produktseite ----------
async function viewProduct(id) {
  loading();
  const [{ data: p, error }, offersR, dealsR, analysisR, seriesR, listingsR, alertsR] = await Promise.all([
    sb.from('kb_products').select('*').eq('id', id).single(),
    sb.from('kb_offers').select('*').eq('product_id', id).eq('gone', false).order('effective_total', { ascending: true, nullsFirst: false }),
    sb.from('kb_deals').select('*').eq('product_id', id).order('posted_at', { ascending: false, nullsFirst: false }).limit(40),
    sb.from('kb_analyses').select('*').eq('product_id', id).order('created_at', { ascending: false }).limit(1),
    sb.rpc('kb_price_series', { p_product: id, p_days: 3700 }),
    sb.from('kb_listings').select('id,source,country,url,title,condition,active,rejected,last_ok_at,last_error,discovered_by,match_score').eq('product_id', id).order('source'),
    sb.from('kb_alerts').select('id').eq('product_id', id).is('read_at', null),
  ]);
  const [vouchersR, ratesR, myVouchersR] = await Promise.all([
    sb.from('kb_shop_vouchers').select('shop,title,url,last_seen_at').eq('expired', false).order('last_seen_at', { ascending: false }).limit(300),
    sb.from('kb_cashback_rates').select('portal,shop,rate_text'),
    sb.from('kb_vouchers').select('kind,label').eq('active', true),
  ]);
  if (error) throw error;
  if (alertsR.data?.length) sb.from('kb_alerts').update({ read_at: new Date().toISOString() }).in('id', alertsR.data.map((a) => a.id)).then(refreshBadge);
  // Als falsch gemeldete Preise (z. B. veralteter Marktplatz-Preis auf der Zwischenseite) ausblenden, bis sich der Preis ändert
  const allOffers = offersR.data ?? [];
  const disputed = allOffers.filter((o) => o.disputed_total != null && Number(o.disputed_total) === Number(o.total));
  const offers = allOffers.filter((o) => !disputed.includes(o));
  const a = analysisR.data?.[0];
  const newOffers = mergeOffers(offers.filter((o) => o.condition === 'new'));
  const refurb = mergeOffers(offers.filter((o) => o.condition !== 'new'));
  const best = offers.find((o) => o.id === p.best_offer_id) ?? newOffers[0];
  const lvl = levelOf(p.best_price, p);
  const isBought = p.status === 'bought';
  const multi = p.quantity > 1;
  const bk = p.best_basket;

  const verdictText = { buy_now: 'Jetzt kaufen', wait: 'Warten', watch: 'Beobachten', buy_alternative: 'Alternative kaufen' };
  render(html`<a class="back" href="#/">Wunschliste</a>
  ${p.name_suggestions?.length && !p.name_confirmed && !isBought ? whichProduct(p) : ''}
  <section class="hero">
    <h1>${thumb(p, 'thumb-lg')}${p.name}</h1>
    <div>
      ${isBought ? html`<div class="where">Gekauft am ${fmtDate(p.bought_at)} für</div>${priceTag(p.bought_price)}`
        : best ? html`${lvl === 'instant' ? html`<span class="tag-instant">${priceTag(p.best_price)}</span>` : priceTag(p.best_price)}
            ${multi && bk ? html`<div class="where">pro Stück · <strong>${p.quantity} Stück für ${fmtEur(bk.effective ?? bk.total)}</strong> bei <a href="${safeUrl(best.url)}" target="_blank" rel="noopener">${best.shop}</a> (${bk.text}${bk.pieces > p.quantity ? `, ${bk.pieces} Stück` : ''})</div>`
              : html`<div class="where">günstigste Neuware bei <a href="${safeUrl(best.url)}" target="_blank" rel="noopener">${best.shop}</a>${best.effective_notes ? html` · nach ${best.effective_notes}` : ''}</div>`}`
        : html`<div class="where">${p.discovery_status === 'done' ? 'Noch kein Angebot gefunden.' : 'Angebote werden beim nächsten Durchlauf gesucht.'}</div>`}
    </div>
    <div>${!isBought && lvl ? html`<span class="pill ${lvl}">${LEVEL_TEXT[lvl]}</span>` : ''}</div>
  </section>
  ${!isBought ? raw(ladder(p, p.best_price)) : ''}
  <p class="hint" style="margin-top:6px">Zuletzt geprüft ${ago(p.last_checked_at)}${p.lowest_seen ? html` · Tiefstpreis seit Beobachtung ${fmtEur(p.lowest_seen)} (${fmtDate(p.lowest_seen_at)})` : ''}</p>

  ${a ? html`<section class="panel">
      <h2>Einschätzung</h2>
      ${a.recommendation ? html`<div class="verdict ${a.recommendation}"><strong>${verdictText[a.recommendation] ?? a.recommendation}</strong>${a.recommendation_reason}</div>` : ''}
      <dl class="kv">
        ${a.best_buy_window ? html`<dt>Bester Kaufzeitpunkt</dt><dd>${a.best_buy_window}</dd>` : ''}
        ${a.expected_low ? html`<dt>Erwarteter Tiefstpreis</dt><dd class="num">${fmtEur(a.expected_low)}</dd>` : ''}
        <dt>Stand</dt><dd>${fmtDate(a.created_at)}</dd>
      </dl>
    </section>` : html`<section class="panel flat"><h2>Einschätzung</h2><p class="muted">${p.analysis_status === 'failed' ? 'Die Analyse ist fehlgeschlagen und wird erneut versucht.' : 'Die Tiefenanalyse (Preisgeschichte, Vorgänger, Aktionstage, Alternativen) läuft jeden Morgen und erscheint dann hier. Bis dahin gelten vorläufige Schwellen aus den gefundenen Preisen.'}</p></section>`}

  ${multi && !isBought ? basketSection(p, offers) : ''}
  ${!isBought ? packOverview(p, offers) : ''}

  <section class="panel">
    <h2>Kaufschwellen${multi ? html` <span class="muted" style="font-weight:400">pro Stück</span>` : ''}</h2>
    <form id="thr" class="grid-2" style="grid-template-columns:repeat(3,1fr)">
      <div class="field"><label for="tg">Guter Preis</label><input id="tg" type="number" step="1" inputmode="decimal" value="${p.threshold_good ?? ''}"></div>
      <div class="field"><label for="tt">Top-Preis</label><input id="tt" type="number" step="1" inputmode="decimal" value="${p.threshold_top ?? ''}"></div>
      <div class="field"><label for="ti">Sofort kaufen</label><input id="ti" type="number" step="1" inputmode="decimal" value="${p.threshold_instant ?? ''}"></div>
    </form>
    <p class="hint">${p.thresholds_manual ? 'Von dir festgelegt – die Analyse ändert sie nicht mehr.'
      : p.threshold_source === 'auto' ? 'Vorläufig aus den gefundenen Preisen und früheren Deals berechnet. Die Tiefenanalyse verfeinert sie am nächsten Morgen. Wenn du sie änderst, gelten deine Werte.'
      : p.threshold_good ? 'Von der Tiefenanalyse festgelegt. Wenn du sie änderst, gelten deine Werte.'
      : 'Werden nach der ersten Preissuche automatisch gesetzt.'}</p>
    ${p.max_price ? html`<p class="hint">Dein Höchstpreis: <strong>${fmtEur(p.max_price)}</strong>${multi ? ` für ${p.quantity} Stück` : ''} – sobald ein Angebot darunter liegt, kommt sofort eine Meldung.</p>` : ''}
    <div class="btn-row"><button class="btn small" id="saveThr">Schwellen speichern</button>${p.thresholds_manual ? html`<button class="btn small ghost" id="autoThr">Wieder der Analyse überlassen</button>` : ''}</div>
  </section>

  <section class="panel"><div class="chart-head"><h2>Preisverlauf${multi ? html` <span class="muted" style="font-weight:400">pro Stück</span>` : ''}</h2>
    <div class="seg small" role="radiogroup" aria-label="Zeitraum">${RANGES.map(([k, label]) => html`<label><input type="radio" name="range" value="${k}" ${k === chartRange() ? 'checked' : ''}><span>${label}</span></label>`)}</div></div>
    <div id="chartBox">${raw(chartFor(seriesR.data ?? [], p, a?.price_history))}</div></section>

  <section class="panel"><h2>Angebote Neuware <span class="muted" style="font-weight:400">${newOffers.length}</span></h2>
    ${newOffers.length ? offerTable(newOffers, false, multi) : html`<p class="muted">Noch keine.</p>`}
    ${disputed.length ? html`<p class="hint">${disputed.length} Angebot${disputed.length === 1 ? '' : 'e'} als falsch gemeldet (${disputed.map((o) => `${o.shop} ${fmtEur(o.total)}`).join(', ')}) – ${disputed.length === 1 ? 'zählt' : 'zählen'} nicht, bis sich der Preis ändert. <button class="linklike" id="undispute">Rückgängig</button></p>` : ''}</section>
  ${p.include_refurb ? html`<section class="panel"><h2>Refurbished, B-Ware, gebraucht <span class="muted" style="font-weight:400">${refurb.length}</span></h2>
    ${refurb.length ? offerTable(refurb, true, multi) : html`<p class="muted">Noch keine gefunden.</p>`}</section>` : ''}

  <section class="panel"><h2>Deals aus der Community</h2>${dealList(dealsR.data ?? [], multi)}</section>

  ${voucherSection(p, newOffers, vouchersR.data ?? [], ratesR.data ?? [], myVouchersR.data ?? [])}

  ${a ? analysisDetails(a) : ''}

  <section class="panel flat"><h2>Überwachte Quellen</h2>
    <ul class="list-plain">${(listingsR.data ?? []).map((l) => html`<li>
      <div><a href="${safeUrl(l.url)}" target="_blank" rel="noopener">${sourceLabel(l)}</a>
        <div class="hint">${l.rejected ? 'als falsch markiert' : !l.active ? 'pausiert (zu viele Fehler)' : l.last_error ? 'Fehler: ' + l.last_error.slice(0, 80) : l.last_ok_at ? 'ok, ' + ago(l.last_ok_at) : 'noch nicht abgefragt'}${l.title ? ' · ' + l.title.slice(0, 60) : ''}</div></div>
      ${l.rejected ? html`<button class="btn small ghost" data-unreject="${l.id}">Wieder aufnehmen</button>` : html`<button class="icon-btn" title="Falsches Produkt – nicht mehr überwachen" aria-label="Falsches Produkt – nicht mehr überwachen" data-reject="${l.id}">✕</button>`}
    </li>`)}</ul>
    <form id="addL" style="display:flex;gap:8px;margin-top:12px"><input id="lurl" type="url" placeholder="Weiteren Link überwachen (Shop, idealo, Amazon …)" required><button class="btn small" type="submit">Hinzufügen</button></form>
  </section>

  <section class="panel flat">
    <div class="btn-row">
      ${isBought ? '' : html`<button class="btn" id="boughtBtn">Gekauft</button>`}
      <a class="btn ghost" href="#/edit/${p.id}">Bearbeiten</a>
      <button class="btn ghost" id="reanalyse">${p.analysis_status === 'queued' ? 'Analyse ist angefordert' : 'Neu analysieren'}</button>
      ${p.status === 'watching' ? html`<button class="btn ghost" id="pause">Pausieren</button>` : p.status === 'paused' ? html`<button class="btn ghost" id="resume">Weiter beobachten</button>` : ''}
      ${p.status !== 'bought' ? html`<button class="btn ghost" id="checkNow">Jetzt prüfen</button>` : ''}
      <button class="btn danger" id="archive">Archivieren</button>
      <button class="btn danger" id="delete">Löschen</button>
    </div>
    <form id="boughtForm" hidden style="margin-top:16px">
      <div class="grid-2">
        <div class="field"><label for="bp">Bezahlt (€${multi ? `, alle ${p.quantity} Stück` : ''})</label><input id="bp" type="number" step="0.01" required value="${multi && bk ? (bk.effective ?? bk.total) : best?.effective_total ?? best?.total ?? ''}"></div>
        <div class="field"><label for="bs">Bei</label><input id="bs" type="text" value="${best?.shop ?? ''}"></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="bd">Kaufdatum</label><input id="bd" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label for="br">Rückgabe möglich bis</label><input id="br" type="date" value="${new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)}"></div>
      </div>
      <p class="hint">Bis zu diesem Datum beobachtet die App weiter und meldet sich, falls es deutlich günstiger wird.</p>
      <button class="btn" type="submit">Als gekauft speichern</button>
    </form>
  </section>`);

  // Aktionen
  view.querySelectorAll('input[name=range]').forEach((r) => r.addEventListener('change', () => {
    try { localStorage.setItem('kb-range', r.value); } catch { /* */ }
    document.getElementById('chartBox').innerHTML = String(chartFor(seriesR.data ?? [], p, a?.price_history));
  }));
  view.querySelectorAll('[data-dispute]').forEach((b) => b.addEventListener('click', async () => {
    const o = allOffers.find((x) => x.id === b.dataset.dispute);
    if (!o || !confirm(`${o.shop}: Stimmt der Preis ${fmtEur(o.total)} beim Händler nicht? Das Angebot zählt dann nicht mehr für Bestpreis und Meldungen – bis sich der Preis im Preisvergleich ändert.`)) return;
    const { error } = await sb.from('kb_offers').update({ disputed_total: o.total, disputed_at: new Date().toISOString() }).eq('id', o.id);
    if (error) return toast(error.message);
    await sb.rpc('kb_request_check', { p_product: id });
    toast('Danke – wird ignoriert, Bestpreis wird neu berechnet'); route();
  }));
  document.getElementById('undispute')?.addEventListener('click', async () => {
    await sb.from('kb_offers').update({ disputed_total: null, disputed_at: null }).in('id', disputed.map((o) => o.id));
    await sb.rpc('kb_request_check', { p_product: id }); route();
  });
  document.getElementById('identOk')?.addEventListener('click', async (e) => {
    const s = p.name_suggestions?.[Number(view.querySelector('#which input[name=ident]:checked')?.value ?? 0)];
    if (!s) return;
    e.target.disabled = true;
    // Gewähltes Produkt übernehmen: sauberer Name, Quelle sofort überwachen, mit dem neuen Namen überall neu suchen
    const { error } = await sb.from('kb_products').update({ name: s.label, name_confirmed: true, name_suggestions: null, image_url: null,
      discovery_status: 'pending', analysis_status: 'queued', analysis_due_at: new Date().toISOString() }).eq('id', id);
    if (error) { e.target.disabled = false; return toast(error.message); }
    await sb.rpc('kb_add_listing', { p_product: id, p_url: s.url });
    toast('Übernommen – die Preissuche startet gleich'); route();
  });
  document.getElementById('whichOk')?.addEventListener('click', () => {
    const picked = [...view.querySelectorAll('#which input:checked')].map((x) => Number(x.value));
    if (!picked.length) return toast('Bitte mindestens eines auswählen');
    answerWhich(p, picked);
  });
  document.getElementById('whichAll')?.addEventListener('click', () => answerWhich(p, (p.name_suggestions ?? []).map((_, i) => i)));
  const num = (x) => (document.getElementById(x).value ? Number(document.getElementById(x).value) : null);
  document.getElementById('saveThr').onclick = async () => {
    const { error } = await sb.from('kb_products').update({ threshold_good: num('tg'), threshold_top: num('tt'), threshold_instant: num('ti'), thresholds_manual: true, threshold_source: 'manual' }).eq('id', id);
    toast(error ? error.message : 'Schwellen gespeichert'); if (!error) route();
  };
  document.getElementById('autoThr')?.addEventListener('click', async () => {
    await sb.from('kb_products').update({ thresholds_manual: false, threshold_source: null, analysis_status: 'queued', analysis_due_at: new Date().toISOString() }).eq('id', id);
    toast('Die nächste Analyse setzt die Schwellen neu'); route();
  });
  document.getElementById('reanalyse').onclick = async () => {
    await sb.from('kb_products').update({ analysis_status: 'queued', analysis_due_at: new Date().toISOString() }).eq('id', id);
    toast('Analyse angefordert – sie läuft beim nächsten täglichen Durchgang'); route();
  };
  const setStatus = async (status, msg) => { await sb.from('kb_products').update({ status }).eq('id', id); toast(msg); location.hash = '#/'; };
  document.getElementById('pause')?.addEventListener('click', () => setStatus('paused', 'Pausiert'));
  document.getElementById('resume')?.addEventListener('click', () => setStatus('watching', 'Wird wieder beobachtet'));
  document.getElementById('archive').onclick = () => { if (confirm('Produkt archivieren? Es wird nicht mehr beobachtet, du findest es unten in der Liste unter „Archiv“.')) setStatus('archived', 'Archiviert'); };
  document.getElementById('delete').onclick = () => deleteProduct(id, p.name);
  document.getElementById('checkNow')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const { data, error } = await sb.rpc('kb_request_check', { p_product: id });
    toast(error ? error.message : data ? 'Wird jetzt geprüft – dauert etwa 2 Minuten' : 'Vorgemerkt für den nächsten Durchlauf');
  });
  document.getElementById('boughtBtn')?.addEventListener('click', () => { document.getElementById('boughtForm').hidden = false; document.getElementById('bp').focus(); });
  document.getElementById('boughtForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await sb.from('kb_products').update({
      status: 'bought', bought_price: num('bp'), bought_shop: document.getElementById('bs').value || null,
      bought_at: document.getElementById('bd').value || new Date().toISOString(), return_until: document.getElementById('br').value || null,
      bought_url: best?.url ?? null,
    }).eq('id', id);
    toast(error ? error.message : 'Gespeichert – Preisschutz ist aktiv'); if (!error) route();
  });
  view.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    await sb.from('kb_listings').update({ rejected: true }).eq('id', b.dataset.reject);
    await sb.from('kb_offers').update({ gone: true }).eq('listing_id', b.dataset.reject);
    toast('Wird nicht mehr überwacht'); route();
  }));
  view.querySelectorAll('[data-unreject]').forEach((b) => b.addEventListener('click', async () => {
    await sb.from('kb_listings').update({ rejected: false, active: true, error_count: 0, next_check_at: new Date().toISOString() }).eq('id', b.dataset.unreject);
    route();
  }));
  view.querySelectorAll('[data-addalt]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const { data, error } = await sb.from('kb_products').insert({ name: b.dataset.addalt, window_start: p.window_start, window_end: p.window_end,
      window_type: p.window_type, include_refurb: p.include_refurb, want_alternative: false, notes: `Alternative zu ${p.name}` }).select('id').single();
    if (error) { b.disabled = false; return toast(error.message); }
    toast('Wird jetzt auch beobachtet'); location.hash = '#/p/' + data.id;
  }));
  document.getElementById('addL').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await sb.rpc('kb_add_listing', { p_product: id, p_url: document.getElementById('lurl').value.trim() });
    toast(error ? error.message : 'Link wird ab dem nächsten Durchlauf überwacht'); if (!error) route();
  });
}

/** Rückfrage: Welches Produkt ist gemeint? (mehrere Varianten passen zum eingetippten Namen) */
function whichProduct(p) {
  if (p.name_suggestions[0]?.kind === 'identify') {
    const src = { idealo: 'idealo', billiger: 'billiger.de', check24: 'CHECK24' };
    return html`<section class="panel" id="which"><h2>Meinst du eines davon?</h2>
      <p class="hint" style="margin-top:-6px">Zu „${p.name}“ gibt es kein Produkt mit genau diesem Namen. Diese hier kommen am nächsten – tipp das richtige an.</p>
      <div class="which-list">${p.name_suggestions.map((s, i) => html`<label class="check"><input type="radio" name="ident" value="${i}" ${i === 0 ? 'checked' : ''}> <span><strong>${s.label}</strong>
        <span class="muted">${s.price ? ` · ab ${fmtEur(s.price)}` : ''} · ${src[s.source] ?? s.source} · <a href="${safeUrl(s.url)}" target="_blank" rel="noopener">ansehen</a></span></span></label>`)}</div>
      <div class="btn-row" style="margin-top:10px"><button class="btn small" id="identOk">Das ist es</button><a class="btn small ghost" href="#/edit/${p.id}">Keins davon – Namen ändern</a></div>
    </section>`;
  }
  return html`<section class="panel" id="which"><h2>Welches Produkt meinst du?</h2>
    <p class="hint" style="margin-top:-6px">Zu „${p.name}“ passen verschiedene Produkte. Wähle aus, was du beobachten willst – Angebote der anderen fallen dann weg.</p>
    <div class="which-list">${p.name_suggestions.map((s, i) => html`<label class="check"><input type="checkbox" value="${i}" ${i === 0 ? 'checked' : ''}> <span><strong>${s.label}</strong> <span class="muted">· ${s.count} Quelle${s.count === 1 ? '' : 'n'}</span></span></label>`)}</div>
    <div class="btn-row" style="margin-top:10px"><button class="btn small" id="whichOk">Übernehmen</button><button class="btn small ghost" id="whichAll">Alle passen</button></div>
  </section>`;
}

async function answerWhich(p, picked) {
  const sugg = p.name_suggestions ?? [];
  const keep = sugg.filter((_, i) => picked.includes(i));
  const drop = sugg.filter((_, i) => !picked.includes(i)).flatMap((s) => s.listing_ids);
  const upd = { name_confirmed: true, name_suggestions: null };
  if (keep.length === 1) upd.name = keep[0].label;          // eindeutige Wahl → deren sauberen Namen übernehmen
  // Merkmale der abgewählten Varianten (z. B. „Essential“, „Bridge“) künftig ausschließen – auch bei neuen Treffern und Deals
  const keepTags = new Set(keep.flatMap((s) => s.tags ?? []));
  const keepWords = new Set(keep.flatMap((s) => s.exclude ?? []));
  const ex = sugg.filter((_, i) => !picked.includes(i)).flatMap((s) => (s.tags ?? []).some((t) => !keepTags.has(t)) ? (s.exclude ?? []) : [])
    .filter((w) => !keepWords.has(w));
  if (ex.length) upd.exclude_terms = [...new Set([...(p.exclude_terms ?? []), ...ex])];
  if (drop.length) {
    upd.image_url = null;                                    // Bild kam evtl. von einer abgewählten Variante
    await sb.from('kb_listings').update({ rejected: true }).in('id', drop);
    await sb.from('kb_offers').update({ gone: true }).in('listing_id', drop);
    // Neu bewerten lassen (Bestpreis ohne die abgewählten Varianten)
    upd.analysis_status = 'queued'; upd.analysis_due_at = new Date().toISOString();
  }
  const { error } = await sb.from('kb_products').update(upd).eq('id', p.id);
  if (error) return toast(error.message);
  if (drop.length) await sb.rpc('kb_request_check', { p_product: p.id });
  toast(drop.length ? 'Danke – die anderen Varianten werden nicht mehr beobachtet' : 'Danke');
  route();
}

/** Alle gefundenen Packungsgrößen im Vergleich: günstigstes Angebot je Größe und Preis pro Stück */
function packOverview(p, offers) {
  const trusted = (o) => !(o.shop_reviews != null && o.shop_reviews < 20) && !(o.shop_rating != null && Number(o.shop_rating) < 3.5 && (o.shop_reviews ?? 0) < 500);
  const best = new Map();
  for (const o of offers.filter((x) => x.condition === 'new' && x.in_stock !== false && trusted(x))) {
    const n = Number(o.pack_size ?? 1); const price = Number(o.effective_total ?? o.total);
    const cur = best.get(n);
    if (!cur || price < cur.price) best.set(n, { o, n, price, unit: price / n });
  }
  const rows = [...best.values()].sort((a, b) => a.n - b.n);
  if (rows.length < 2) return '';
  const minUnit = Math.min(...rows.map((r) => r.unit));
  return html`<section class="panel"><h2>Packungsgrößen im Vergleich <span class="muted" style="font-weight:400">${rows.length}</span></h2>
    <p class="hint" style="margin-top:-6px">Günstigstes Angebot je Packungsgröße (Endpreis inkl. Versand).${p.quantity > 1 ? ` Für deine ${p.quantity} Stück werden alle Größen miteinander kombiniert (siehe oben).` : ''}</p>
    <table class="table offers"><thead><tr><th>Packung</th><th class="r">Preis</th><th class="r">pro Stück</th></tr></thead><tbody>
    ${rows.map((r) => html`<tr class="${r.unit === minUnit ? 'best' : ''}">
      <td><strong>${r.n === 1 ? 'Einzeln' : r.n + 'er'}</strong><div class="hint"><a href="${safeUrl(r.o.url)}" target="_blank" rel="noopener">${r.o.shop}</a></div></td>
      <td class="r num">${fmtEur(r.price)}</td>
      <td class="r"><span class="num price-cell">${fmtEur(r.unit)}</span>${r.unit > minUnit * 1.005 ? html`<div class="hint">+${Math.round((r.unit / minUnit - 1) * 100)} %</div>` : html`<div class="hint">am günstigsten</div>`}</td></tr>`)}
    </tbody></table></section>`;
}

/** Mengen-Produkte: günstigster Einkauf je Händler für die benötigte Stückzahl (beliebige Packungsgrößen kombiniert) */
function basketSection(p, offers) {
  const trusted = (o) => !(o.shop_reviews != null && o.shop_reviews < 20) && !(o.shop_rating != null && Number(o.shop_rating) < 3.5 && (o.shop_reviews ?? 0) < 500);
  const byShop = new Map();
  for (const o of offers.filter((x) => x.condition === 'new' && x.in_stock !== false && trusted(x))) {
    const k = normShop(o.shop); byShop.set(k, [...(byShop.get(k) ?? []), o]);
  }
  const rows = [];
  for (const list of byShop.values()) {
    const b = cheapestBasket(list.map((o) => ({ ...o, pack: o.pack_size ?? 1, price: o.price })), p.quantity);
    if (b) rows.push({ shop: list[0].shop, b, url: b.items[0].offer.url });
  }
  rows.sort((a, b) => a.b.total - b.b.total);
  if (!rows.length) return '';
  const singles = rows.filter((r) => r.b.items.every((i) => i.pack === 1)).sort((a, b) => a.b.total - b.b.total)[0];
  const save = singles && rows[0] !== singles ? singles.b.total - rows[0].b.total : 0;
  return html`<section class="panel"><h2>Bester Einkauf für ${p.quantity} Stück</h2>
    <p class="hint" style="margin-top:-6px">Je Händler die günstigste Kombination aus Einzelstücken und Packungen, Versand einmal pro Bestellung (vor Gutscheinen/Cashback).${save >= 1 ? html` Gegenüber Einzelkauf sparst du <strong>${fmtEur(save)}</strong>.` : ''}</p>
    <table class="table offers"><thead><tr><th>Händler</th><th class="r">Gesamt</th></tr></thead><tbody>
    ${rows.slice(0, 5).map((r, i) => html`<tr class="${i === 0 ? 'best' : ''}">
      <td><a class="shop" href="${safeUrl(r.url)}" target="_blank" rel="noopener">${r.shop}</a>
        <div class="hint">${basketText(r.b)}${r.b.pieces > p.quantity ? ` = ${r.b.pieces} Stück` : ''}${r.b.shipping ? ` · ${fmtEur(r.b.shipping)} Versand` : ''}</div></td>
      <td class="r"><span class="num price-cell">${fmtEur(r.b.total)}</span><div class="hint">${fmtEur(r.b.total / p.quantity)}/Stück</div></td></tr>`)}
    </tbody></table></section>`;
}

/** Gleicher Händler über mehrere Preisvergleiche (idealo, billiger.de …) → nur das günstigste Angebot zeigen */
function normShop(s) {
  return String(s ?? '').toLowerCase().replace(/\s*\(.*?\)\s*/g, '').replace(/^www\./, '').replace(/\.(de|com|at|fr|it|es|nl|eu)(\/.*)?$/, '')
    .replace(/online ?shop|onlineshop|\bshop\b|\bgmbh\b/g, '').replace(/[^a-z0-9]/g, '');
}
function mergeOffers(list) {
  const map = new Map();
  for (const o of list) {
    const k = normShop(o.shop) + '|' + o.condition + '|' + (o.pack_size ?? 1);
    const cur = map.get(k);
    const price = Number(o.effective_total ?? o.total);
    if (!cur) { map.set(k, { ...o, via: new Set([o.source]) }); continue; }
    cur.via.add(o.source);
    if (price < Number(cur.effective_total ?? cur.total)) map.set(k, { ...o, via: cur.via });
  }
  return [...map.values()].sort((a, b) => Number(a.effective_total ?? a.total) - Number(b.effective_total ?? b.total));
}

function sourceLabel(l) {
  const names = { idealo: 'idealo', billiger: 'billiger.de', check24: 'CHECK24', ebay: 'eBay', geizhals: 'Geizhals', amazon: 'Amazon.de', amazon_fr: 'Amazon.fr', amazon_it: 'Amazon.it', amazon_es: 'Amazon.es', amazon_nl: 'Amazon.nl' };
  let host = ''; try { host = new URL(l.url).host.replace(/^www\./, ''); } catch { /* */ }
  return (names[l.source] ?? host) + (l.condition !== 'new' ? ' (Refurbished)' : '');
}

/** Hinweis bei Shops mit wenigen oder schlechten Bewertungen (diese lösen keine Meldungen aus) */
function shopTrust(o) {
  const r = o.shop_rating != null ? Number(o.shop_rating) : null; const n = o.shop_reviews;
  if (n != null && n < 20) return html`<br><span style="color:var(--warn)">Nur ${n} Shop-Bewertung${n === 1 ? '' : 'en'} – vorsichtig sein</span>`;
  if (r != null && r < 3.5 && (n ?? 0) < 500) return html`<br><span style="color:var(--warn)">Shop-Bewertung ${r.toLocaleString('de-DE')} von 5</span>`;
  if (r != null) return html`<br>Shop-Bewertung ${r.toLocaleString('de-DE')} (${Number(n ?? 0).toLocaleString('de-DE')})`;
  return '';
}

const MARKET = /marketplace|marktplatz|\(marktplatzh|kaufland\.de$|ebay/i;

function offerTable(list, showCondition = false, perPiece = false) {
  const unit = (o) => Number(o.effective_total ?? o.total) / Math.max(1, Number(o.pack_size ?? 1));
  if (perPiece) list = [...list].sort((a, b) => unit(a) - unit(b));
  const condText = { refurbished: 'Refurbished', bware: 'B-Ware', used: 'Gebraucht', new: 'Neu' };
  // „über …“ nur bei Preisvergleichen/Marktplätzen – bei Shops, die direkt abgefragt werden, ist es der Shop selbst
  const VIA = { idealo: 'idealo', billiger: 'billiger.de', geizhals: 'Geizhals', check24: 'CHECK24', ebay: 'eBay' };
  const viaList = (o) => [...(o.via ?? [o.source])].filter((v) => VIA[v]).map((v) => VIA[v]);
  const via = (o) => viaList(o).join(', ');
  const rowHtml = (o, i) => html`<tr class="${i === 0 ? 'best' : ''}">
      <td><a class="shop" href="${safeUrl(o.url)}" target="_blank" rel="noopener">${o.shop}</a>${o.country && o.country !== 'DE' ? html` <span class="muted">(${o.country})</span>` : ''}
        <div class="hint">${o.pack_size > 1 ? html`<strong>${packText(o.pack_size)}</strong> · ` : ''}${showCondition ? html`<strong>${condText[o.condition]}</strong> · ` : ''}${o.delivery_text ?? ''}${showCondition && o.title ? html`<br>${o.title.slice(0, 80)}` : ''}${viaList(o).length ? html`<br>über ${via(o)}` : ''}${MARKET.test(o.shop) ? html`<br><span style="color:var(--warn)">Marktplatz-Händler: Preis gilt oft nur bei einem bestimmten Verkäufer („weitere Angebote“) und ist im Preisvergleich manchmal veraltet</span>` : ''}${shopTrust(o)}</div></td>
      <td class="r"><span class="num price-cell">${fmtEur(o.effective_total ?? o.total)}</span>
        <div class="hint">${o.pack_size > 1 ? html`<strong>${fmtEur(unit(o))}/Stück</strong><br>` : ''}${o.effective_notes ? html`${fmtEur(o.total)} abzgl. ${o.effective_notes}` : o.shipping ? html`inkl. ${fmtEur(o.shipping)} Versand` : o.shipping === 0 ? 'versandkostenfrei' : ''}
          <br><button class="linklike" data-dispute="${o.id}" title="Beim Händler steht ein anderer Preis">Preis stimmt nicht?</button></div></td>
    </tr>`;
  const SHOW = 8;
  const head = html`<thead><tr><th>Händler</th><th class="r">Endpreis</th></tr></thead>`;
  return html`<table class="table offers">${head}<tbody>${list.slice(0, SHOW).map(rowHtml)}</tbody></table>
    ${list.length > SHOW ? html`<details class="more"><summary>Alle ${list.length} Angebote zeigen</summary>
      <table class="table offers"><tbody>${list.slice(SHOW, 60).map((o, i) => rowHtml(o, i + SHOW))}</tbody></table></details>` : ''}`;
}

/** Gutscheine & Aktionen der Händler, die gerade vorne liegen (von mydealz, täglich aktualisiert) */
function voucherSection(p, offers, vouchers, rates, mine) {
  const top = offers.slice(0, 6);
  const brand = String(p.brand || p.name.split(' ')[0] || '').toLowerCase();
  const general = /gutschein|coupon|cashback auf deine einkäufe|versandkostenfrei|gratisversand|neukunden|auf alles|gesamte sortiment|mehrwertsteuer/i;
  const rows = [];
  for (const o of top) {
    const n = normShop(o.shop);
    for (const v of vouchers.filter((x) => n && (x.shop === n || n.startsWith(x.shop) || x.shop.startsWith(n)))) {
      const t = v.title.toLowerCase();
      if (!(general.test(t) || (brand.length > 1 && t.includes(brand)))) continue;
      if (/cashback auf deine einkäufe/i.test(t)) continue;   // steht unten als Cashback
      if (!rows.some((r) => r.v.title === v.title)) rows.push({ o, v });
    }
  }
  const cb = top.map((o) => ({ o, r: rates.find((r) => normShop(o.shop).startsWith(r.shop) || r.shop.startsWith(normShop(o.shop))) })).filter((x) => x.r);
  const hasMydealzCb = mine.some((m) => m.kind === 'cashback' && /mydealz/i.test(m.label));
  if (!rows.length && !cb.length) return '';
  return html`<section class="panel"><h2>Gutscheine & Aktionen</h2>
    <p class="hint" style="margin-top:-6px">Bei den Händlern, die gerade am günstigsten sind (aus den geprüften Gutscheinseiten von mydealz).</p>
    ${rows.length ? html`<ul class="list-plain">${rows.slice(0, 8).map(({ o, v }) => html`<li style="align-items:flex-start"><div><strong>${o.shop}</strong><div>${v.title}</div></div>
      <a class="btn small ghost" href="${safeUrl(v.url)}" target="_blank" rel="noopener">Ansehen</a></li>`)}</ul>` : ''}
    ${cb.length ? html`<p style="margin-top:12px"><strong>Cashback:</strong> ${cb.map(({ o, r }) => `${o.shop} ${r.rate_text}`).join(' · ')}</p>
      ${hasMydealzCb ? html`<p class="hint">Wird bei „Für dich“ schon eingerechnet.</p>` : html`<p class="hint">Wenn du ein mydealz-Konto hast, trag unter Einstellungen → Gutscheine & Zugänge „mydealz Cashback“ (Art: Cashback-Konto) ein – dann rechnet die App das Cashback in den Endpreis ein.</p>`}` : ''}
  </section>`;
}

function dealList(deals, perPiece = false) {
  if (!deals.length) return html`<p class="muted">Noch keine passenden Deals auf mydealz & Co. gefunden.</p>`;
  const portals = { mydealz: 'mydealz', preisjaeger: 'Preisjäger', dealabs: 'Dealabs (FR)', chollometro: 'Chollometro (ES)', pepperit: 'Pepper (IT)' };
  return html`<ul class="list-plain">${deals.slice(0, 15).map((d) => html`<li style="align-items:flex-start">
    <div><a href="${safeUrl(d.url)}" target="_blank" rel="noopener">${d.title.slice(0, 110)}</a>
      <div class="hint">${d.pack_size > 1 ? html`<strong>${packText(d.pack_size)}</strong>${perPiece ? '' : ' (nicht mit Einzelpreis vergleichbar)'} · ` : ''}${portals[d.portal] ?? d.portal}${d.merchant ? ' · ' + d.merchant : ''} · ${fmtDate(d.posted_at)}${d.temperature !== null ? ` · ${Math.round(d.temperature)}°` : ''}${d.expired ? ' · abgelaufen' : ''}${d.notes ? ' · ' + d.notes : ''}</div></div>
    <div class="num" style="font-weight:700;white-space:nowrap;text-align:right">${d.price ? fmtEur(d.price) : ''}${d.price && d.pack_size > 1 ? html`<div class="hint" style="font-weight:400">${fmtEur(d.price / d.pack_size)}/Stück</div>` : ''}</div></li>`)}</ul>
    <p class="hint">Abgelaufene Deals zeigen, welche Preise schon einmal möglich waren.</p>`;
}

function analysisDetails(a) {
  const list = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  const warnings = list(a.warnings); const alts = list(a.alternatives); const variants = list(a.model_variants);
  const events = list(a.events); const cashback = list(a.cashback); const vouchers = list(a.vouchers); const sources = list(a.sources);
  return html`<section class="panel"><h2>Analyse im Detail</h2>
    <div class="prose">${raw(md(a.summary))}</div>
    ${warnings.length ? html`<h3 style="margin-top:16px">Achtung</h3><ul class="prose">${warnings.map((w) => html`<li>${typeof w === 'string' ? w : w.text ?? JSON.stringify(w)}</li>`)}</ul>` : ''}
    ${events.length ? html`<h3 style="margin-top:16px">Aktionstage im Zeitraum</h3><ul class="prose">${events.map((e) => html`<li><strong>${e.name}</strong>${e.date ? ' (' + e.date + ')' : ''}${e.expected ? ': ' + e.expected : ''}</li>`)}</ul>` : ''}
    ${variants.length ? html`<h3 style="margin-top:16px">Gleiches Gerät, andere Namen</h3><ul class="prose">${variants.map((v) => html`<li><strong>${v.model}</strong>${v.note ? ': ' + v.note : ''}</li>`)}</ul>` : ''}
    ${a.successor ? html`<h3 style="margin-top:16px">Nachfolger</h3><p class="prose">${a.successor.name ? html`<strong>${a.successor.name}</strong>: ` : ''}${a.successor.status ?? ''} ${a.successor.effect ?? ''}</p>` : ''}
    ${alts.length ? html`<h3 style="margin-top:16px">Alternativen</h3><ul class="prose">${alts.map((x) => html`<li><strong>${x.name}</strong>${x.price ? ' – ca. ' + fmtEur0(x.price) : ''}${x.why ? ': ' + x.why : ''}${x.tradeoffs ? html`<br><span class="muted">Abstriche: ${x.tradeoffs}</span>` : ''}
      <br><button class="btn small ghost" style="margin-top:6px" data-addalt="${x.name}">Auch beobachten</button></li>`)}</ul>` : ''}
    ${cashback.length || vouchers.length ? html`<h3 style="margin-top:16px">Cashback & Gutscheine</h3><ul class="prose">${[...cashback, ...vouchers].map((c) => html`<li>${c.label ?? c.name ?? ''}${c.value ? ': ' + c.value : ''}${c.code ? html` – Code <strong>${c.code}</strong>` : ''}${c.until ? ' (bis ' + c.until + ')' : ''}${c.url ? html` <a href="${safeUrl(c.url)}" target="_blank" rel="noopener">Details</a>` : ''}</li>`)}</ul>` : ''}
    ${sources.length ? html`<h3 style="margin-top:16px">Quellen</h3><ol class="sources">${sources.map((s) => html`<li><a href="${safeUrl(s.url)}" target="_blank" rel="noopener">${s.title ?? s.url}</a></li>`)}</ol>` : ''}
  </section>`;
}

// ---------- Schnellcheck ----------
async function viewCheck(params = new URLSearchParams()) {
  loading();
  const { data: checks } = await sb.from('kb_quick_checks').select('*').order('created_at', { ascending: false }).limit(15);
  const verdict = { great: ['top', 'Sehr guter Preis'], good: ['good', 'Guter Preis'], ok: ['wait', 'Geht so'], bad: ['warn', 'Kein Deal'], unknown: ['wait', 'Unklar'] };
  render(html`<div class="head"><div><h1>Ist das ein Deal?</h1><div class="sub">Link einfügen oder Produkt und Preis eintippen.</div></div></div>
    <form id="f" class="panel">
      <div class="field"><label for="in">Angebot</label><textarea id="in" required placeholder="https://… oder: LG OLED77G6 für 2.399 €"></textarea></div>
      <button class="btn" type="submit">Prüfen</button>
      <p class="hint" style="margin-top:8px">Das Ergebnis erscheint hier und kommt als Push-Nachricht, meist nach wenigen Minuten.</p>
    </form>
    ${checks?.length ? html`<div class="group-title">Bisherige Checks</div><div class="rows">${checks.map((c) => html`<div class="row" style="cursor:default">
      <div class="name">${c.product_name ?? c.input.slice(0, 80)}</div>
      <div class="price">${c.price ? priceTag(c.price, 'price-mid') : ''}<div class="price-sub">${c.status === 'done' ? html`<span class="pill ${verdict[c.verdict]?.[0] ?? 'wait'}">${verdict[c.verdict]?.[1] ?? '–'}</span>` : c.status === 'failed' ? html`<span class="pill warn">Fehler</span>` : html`<span class="pill wait">wartet</span>`}</div></div>
      <div class="meta">${c.summary ?? 'Wird geprüft …'}
        ${c.details?.bestUrl ? html` <a href="${safeUrl(c.details.bestUrl)}" target="_blank" rel="noopener">Günstigstes Angebot</a>` : ''}
        ${c.details?.compareUrl ? html` · <a href="${safeUrl(c.details.compareUrl)}" target="_blank" rel="noopener">Preisvergleich</a>` : ''}
        ${c.details?.dealLow?.url ? html` · <a href="${safeUrl(c.details.dealLow.url)}" target="_blank" rel="noopener">mydealz</a>` : ''}</div>
      ${c.status === 'done' && (c.product_id || c.details?.watchedId) ? html`<div style="grid-column:1/-1;margin-top:6px"><a class="btn small ghost" href="#/p/${c.product_id ?? c.details.watchedId}">Zur Wunschliste</a></div>`
        : c.status === 'done' ? html`<div style="grid-column:1/-1;margin-top:6px"><button class="btn small ghost" data-add="${c.id}">Auf die Wunschliste</button></div>` : ''}
    </div>`)}</div>` : ''}`);
  const pre = [params.get('u'), params.get('t')].filter(Boolean).join(' ').trim();
  if (pre) document.getElementById('in').value = pre;
  const submit = async () => {
    const input = document.getElementById('in').value.trim();
    if (!input) return;
    const { error } = await sb.from('kb_quick_checks').insert({ input });
    toast(error ? error.message : 'Wird geprüft');
    if (!error) { history.replaceState(null, '', '#/check'); route(); }
  };
  document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  if (pre && params.get('auto') === '1') submit();
  // Solange noch etwas geprüft wird: alle 15 Sekunden nachsehen
  if (checks?.some((c) => c.status === 'queued' || c.status === 'running')) {
    setTimeout(() => { if (location.hash.startsWith('#/check') && !document.getElementById('in').value) route(); }, 15_000);
  }
  view.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', async () => {
    const c = checks.find((x) => x.id === b.dataset.add);
    const { data, error } = await sb.from('kb_products').insert({ name: c.product_name ?? c.input.slice(0, 120), model: c.details?.model ?? null }).select('id').single();
    if (error) return toast(error.message);
    await sb.from('kb_quick_checks').update({ product_id: data.id }).eq('id', c.id);
    if (c.input.match(/https?:\/\/\S+/)) await sb.rpc('kb_add_listing', { p_product: data.id, p_url: c.input.match(/https?:\/\/\S+/)[0] });
    location.hash = '#/p/' + data.id;
  }));
}

// ---------- Meldungen ----------
async function viewAlerts() {
  loading();
  const { data } = await sb.from('kb_alerts').select('*').order('created_at', { ascending: false }).limit(100);
  if (!data?.length) return render(html`<div class="head"><h1>Meldungen</h1></div><div class="empty panel"><h2>Noch keine Meldungen</h2><p>Sobald ein Preis eine deiner Schwellen erreicht oder ein passender Deal auftaucht, steht es hier – und kommt als Push-Nachricht, wenn du sie in den Einstellungen einschaltest.</p><a class="btn ghost" href="#/settings">Zu den Einstellungen</a></div>`);
  render(html`<div class="head"><h1>Meldungen</h1><button class="btn small ghost" id="allRead">Alle gelesen</button></div>
    <div class="rows">${data.map((a) => html`<a class="alert-row ${a.level} ${a.read_at ? 'read' : ''}" href="${a.product_id ? '#/p/' + a.product_id : a.url ? safeUrl(a.url) : '#/alerts'}" ${!a.product_id && a.url ? raw('target="_blank" rel="noopener"') : ''} data-id="${a.id}">
      <span class="dot" aria-hidden="true"></span>
      <div><div class="t">${a.title}</div>${a.body ? html`<div class="b">${a.body}</div>` : ''}<div class="w">${ago(a.created_at)}</div></div></a>`)}</div>`);
  document.getElementById('allRead').onclick = async () => {
    await sb.from('kb_alerts').update({ read_at: new Date().toISOString() }).is('read_at', null);
    route();
  };
  view.querySelectorAll('.alert-row').forEach((el) => el.addEventListener('click', () => {
    sb.from('kb_alerts').update({ read_at: new Date().toISOString() }).eq('id', el.dataset.id).is('read_at', null).then(refreshBadge);
  }));
}

// ---------- Einstellungen ----------
async function viewSettings() {
  loading();
  const [setR, vR, hR, rR] = await Promise.all([
    sb.from('kb_settings').select('*').maybeSingle(),
    sb.from('kb_vouchers').select('*').order('created_at'),
    sb.from('kb_source_health').select('*').order('source'),
    sb.from('kb_runs').select('kind,started_at,finished_at,error').order('started_at', { ascending: false }).limit(1),
  ]);
  const s = setR.data ?? { push_alerts: true, email_alerts: false, alert_email: session.user.email, return_days: 14 };
  const pushState = await currentPushState();
  const { data: setup } = await sb.rpc('kb_setup_status');
  const kindText = { voucher: 'Gutschein', membership: 'Mitgliedschaft', cashback: 'Cashback-Konto', payment: 'Zahlungsart' };
  const isIOS = /iPhone|iPad/.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone || !!NATIVE;
  render(html`<div class="head"><h1>Einstellungen</h1></div>
  ${setupPanel(setup, pushState)}
  <section class="panel" id="push"><h2>Push-Nachrichten</h2>
    ${isIOS && !standalone ? html`<p>Auf dem iPhone funktionieren Push-Nachrichten nur, wenn die App auf dem Home-Bildschirm liegt: In Safari unten auf <strong>Teilen</strong> tippen, dann <strong>Zum Home-Bildschirm</strong>. Danach die App von dort öffnen und hier einschalten.</p>`
      : pushState === 'unsupported' ? html`<p class="muted">Dieser Browser unterstützt keine Push-Nachrichten.</p>`
      : pushState === 'on' ? html`<p>Auf diesem Gerät eingeschaltet.</p><div class="btn-row"><button class="btn small ghost" id="pushTest">Testnachricht anfordern</button><button class="btn small ghost" id="pushOff">Ausschalten</button></div>`
      : pushState === 'denied' ? html`<p>Mitteilungen sind für diese App blockiert. Erlaube sie in den Systemeinstellungen (iPhone: Einstellungen → Mitteilungen → Kaufberater).</p>`
      : html`<p>Erhalte eine Nachricht, sobald ein Preis eine Schwelle erreicht.</p><button class="btn" id="pushOn">Push-Nachrichten einschalten</button>`}
  </section>
  <form id="sf" class="panel"><h2>Benachrichtigungen</h2>
    ${setup?.email_ready ? html`<div class="field"><label class="check"><input id="em" type="checkbox" ${s.email_alerts ? 'checked' : ''}> Wichtige Meldungen (Top-Preis, Sofort zuschlagen, Fristen) zusätzlich per E-Mail</label></div>
    <div class="field"><label for="ea">E-Mail-Adresse</label><input id="ea" type="email" value="${s.alert_email ?? session.user.email ?? ''}"></div>`
      : html`<input id="em" type="checkbox" hidden><input id="ea" type="hidden" value="${s.alert_email ?? ''}">`}
    <div class="field"><label>Ruhezeit <span class="muted">(keine Push-Nachrichten, außer „Sofort zuschlagen“)</span></label>
      <div class="grid-2"><input id="qf" type="time" value="${(s.quiet_from ?? '').slice(0, 5)}" aria-label="Ruhezeit von"><input id="qt" type="time" value="${(s.quiet_to ?? '').slice(0, 5)}" aria-label="Ruhezeit bis"></div></div>
    <button class="btn small" type="submit">Speichern</button>
  </form>
  <section class="panel"><h2>Meine Gutscheine & Zugänge</h2>
    <p class="hint" style="margin-top:-6px">Werden beim Preisvergleich eingerechnet (z. B. Prime-Versand, Cashback-Portal, Gutschein ab Mindestbestellwert).</p>
    <ul class="list-plain">${(vR.data ?? []).map((v) => html`<li><div><strong>${v.label}</strong> <span class="muted">${kindText[v.kind]}${v.shop ? ' · ' + v.shop : ''}${v.value ? ' · ' + (v.value_type === 'percent' ? v.value + ' %' : fmtEur(v.value)) : ''}${v.min_order ? ' ab ' + fmtEur0(v.min_order) : ''}${v.valid_until ? ' · bis ' + fmtDate(v.valid_until) : ''}</span>${v.code ? html`<div class="hint">Code: ${v.code}</div>` : ''}</div>
      <button class="icon-btn" data-delv="${v.id}" aria-label="${'Löschen: ' + v.label}" title="Löschen">✕</button></li>`)}</ul>
    <details class="more"><summary>Hinzufügen</summary>
      <form id="vf">
        <div class="grid-2">
          <div class="field"><label for="vk">Art</label><select id="vk"><option value="voucher">Gutschein</option><option value="membership">Mitgliedschaft (z. B. Prime)</option><option value="cashback">Cashback-Konto (z. B. Shoop)</option><option value="payment">Zahlungsart mit Vorteil</option></select></div>
          <div class="field"><label for="vl">Bezeichnung</label><input id="vl" type="text" required placeholder="Amazon Prime"></div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="vs">Gilt für Shop <span class="muted">(leer = überall)</span></label><input id="vs" type="text" placeholder="mediamarkt"></div>
          <div class="field"><label for="vc">Code <span class="muted">(optional)</span></label><input id="vc" type="text"></div>
        </div>
        <div class="grid-2" style="grid-template-columns:1fr 1fr 1fr">
          <div class="field"><label for="vv">Wert</label><input id="vv" type="number" step="0.01"></div>
          <div class="field"><label for="vt">in</label><select id="vt"><option value="eur">€</option><option value="percent">%</option></select></div>
          <div class="field"><label for="vm">ab Bestellwert</label><input id="vm" type="number" step="1"></div>
        </div>
        <div class="field"><label for="vu">Gültig bis <span class="muted">(optional)</span></label><input id="vu" type="date"></div>
        <button class="btn small" type="submit">Hinzufügen</button>
      </form></details>
  </section>
  <section class="panel flat"><h2>Angebote aus anderen Apps prüfen</h2>
    ${NATIVE?.share ? html`<p>In Safari, Amazon & Co. auf <strong>Teilen</strong> tippen → <strong>Kaufberater</strong> (falls nicht sichtbar: ganz rechts „Mehr“ und Kaufberater einschalten). Optional den Preis eintragen, dann <em>Ist das ein Deal?</em> – kurz darauf erscheint eine Mitteilung, die den Schnellcheck öffnet.</p>
    <details class="more"><summary>Alternative: Kurzbefehl</summary>` : ''}
    <p>Mit einem iPhone-Kurzbefehl erscheint „Ist das ein Deal?“ im <strong>Teilen</strong>-Menü von Safari, Amazon & Co.:</p>
    <ol class="prose" style="padding-left:20px">
      <li>App <strong>Kurzbefehle</strong> öffnen → <strong>+</strong> → oben auf den Namen tippen: „Ist das ein Deal?“.</li>
      <li>Unten auf <strong>i</strong> (Details) → <strong>Im Share-Sheet anzeigen</strong> einschalten.</li>
      <li>Aktion <strong>Text codieren</strong> hinzufügen (Modus: URL), Eingabe: <em>Kurzbefehleingabe</em>.</li>
      <li>Aktion <strong>URL</strong> hinzufügen mit:<br><code style="word-break:break-all">${NATIVE ? 'kaufberater://check?u=' : location.origin + location.pathname + '#/check?auto=1&u='}</code> und dahinter die Variable <em>Codierter Text</em>.</li>
      <li>Aktion <strong>URLs öffnen</strong> hinzufügen. Fertig.</li>
    </ol>
    <p class="hint">${NATIVE ? 'Der Kurzbefehl öffnet direkt die Kaufberater-App.' : 'Der Link öffnet sich in Safari. Melde dich dort einmal mit demselben Konto an.'}</p>
    ${NATIVE?.share ? raw('</details>') : ''}
  </section>
  <section class="panel flat"><h2>Quellen</h2>
    <p class="hint" style="margin-top:-6px">Letzter Durchlauf: ${ago(rR.data?.[0]?.finished_at ?? rR.data?.[0]?.started_at)}. Amazon, MediaMarkt, Otto, Galaxus, Kaufland & Co. kommen über die Preisvergleiche (idealo, billiger.de, CHECK24) herein; direkt abgefragt werden sie, sobald der Heim-Server (Raspberry Pi) läuft.</p>
    <ul class="list-plain">${(hR.data ?? []).map((h) => html`<li><span>${h.source}</span><span class="hint">${h.blocked_until && new Date(h.blocked_until) > new Date() ? 'blockiert, neuer Versuch später' : h.last_ok_at && (!h.last_error_at || h.last_ok_at > h.last_error_at) ? 'ok ' + ago(h.last_ok_at) : 'Fehler ' + ago(h.last_error_at)}</span></li>`)}</ul>
  </section>
  <section class="panel flat"><div class="btn-row"><button class="btn ghost" id="logout">Abmelden</button></div></section>`);

  document.getElementById('apnsForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const g = (x) => document.getElementById(x).value;
    const { error } = await sb.rpc('kb_set_apns_key', { p_key: g('apk'), p_key_id: g('apkid'), p_team_id: g('apteam') });
    if (error) return toast(error.message);
    toast('Gespeichert – Mitteilungen sind bereit');
    route();
  });
  document.getElementById('tokForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.disabled = true;
    const { error } = await sb.rpc('kb_set_github_token', { p_token: document.getElementById('tok').value });
    btn.disabled = false;
    if (error) return toast(error.message);
    toast('Gespeichert – Testlauf gestartet');
    setTimeout(route, 4000);
  });
  document.getElementById('sf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = { user_id: session.user.id, email_alerts: document.getElementById('em').checked, alert_email: document.getElementById('ea').value || null,
      quiet_from: document.getElementById('qf').value || null, quiet_to: document.getElementById('qt').value || null };
    const { error } = await sb.from('kb_settings').upsert(row);
    toast(error ? error.message : 'Gespeichert');
  });
  document.getElementById('vf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const g = (x) => document.getElementById(x).value;
    const { error } = await sb.from('kb_vouchers').insert({ kind: g('vk'), label: g('vl').trim(), shop: g('vs').trim() || null, code: g('vc').trim() || null,
      value: g('vv') ? Number(g('vv')) : null, value_type: g('vv') ? g('vt') : null, min_order: g('vm') ? Number(g('vm')) : null, valid_until: g('vu') || null });
    toast(error ? error.message : 'Hinzugefügt'); if (!error) route();
  });
  view.querySelectorAll('[data-delv]').forEach((b) => b.addEventListener('click', async () => { await sb.from('kb_vouchers').delete().eq('id', b.dataset.delv); route(); }));
  document.getElementById('logout').onclick = async () => { await sb.auth.signOut(); location.hash = '#/'; };
  document.getElementById('pushOn')?.addEventListener('click', enablePush);
  document.getElementById('pushOff')?.addEventListener('click', disablePush);
  document.getElementById('pushTest')?.addEventListener('click', async () => {
    const { error } = await sb.from('kb_alerts').insert({ user_id: session.user.id, kind: 'system', level: 'good', title: 'Testnachricht vom Kaufberater', body: 'Push-Nachrichten funktionieren. So sieht eine Meldung aus.', dedup_key: 'test:' + Date.now() });
    if (error) return toast(error.message);
    const { data: fast } = await sb.rpc('kb_request_delivery');
    toast(fast ? 'Testnachricht kommt in ca. 1–2 Minuten' : 'Kommt beim nächsten Durchlauf (ohne GitHub-Schlüssel kann das ein paar Stunden dauern)');
  });
}

// ---------- Einrichtung ----------
function setupPanel(st, pushState) {
  if (!st) return '';
  const pushOk = pushState === 'on';
  const code = st.last_dispatch_status;
  const keyState = !st.github_key ? 'missing' : code === 204 ? 'ok' : code === 401 ? 'invalid' : (code === 403 || code === 404) ? 'rights' : 'unknown';
  const item = (ok, title, text) => html`<li style="align-items:flex-start"><span><strong>${ok ? '✓' : '○'} ${title}</strong><div class="hint">${text}</div></span></li>`;
  const apnsMissing = NATIVE && !st.apns_ready;
  const allOk = pushOk && keyState === 'ok' && !apnsMissing;
  return html`<section class="panel ${allOk ? 'flat' : ''}"><h2>${allOk ? 'Alles eingerichtet' : 'Einrichtung'}</h2>
    <ul class="list-plain">
      ${item(pushOk, 'Push-Nachrichten', pushOk ? 'Auf diesem Gerät eingeschaltet.' : html`Noch aus – <a href="#/settings" onclick="document.getElementById('push').scrollIntoView({behavior:'smooth'});return false">unten einschalten</a>.`)}
      ${item(keyState === 'ok', 'Sofort-Start',
        keyState === 'ok' ? 'Neue Einträge werden sofort gesucht, die Preisabfrage läuft zuverlässig stündlich.'
        : keyState === 'invalid' ? 'Der GitHub-Schlüssel wird abgelehnt (abgelaufen oder falsch kopiert). Bitte unten einen neuen eintragen.'
        : keyState === 'rights' ? 'Der GitHub-Schlüssel hat nicht die nötige Berechtigung („Actions: Read and write“ für das Repo Kaufberater).'
        : keyState === 'unknown' ? 'Schlüssel ist hinterlegt, der erste Test läuft noch.'
        : 'Ohne GitHub-Schlüssel startet die Preisabfrage nur, wenn GitHub Zeit hat – oft nur alle paar Stunden.')}
      ${NATIVE ? item(!!st.apns_ready, 'iPhone-Mitteilungen (Apple)', st.apns_ready ? 'Apple-Push-Schlüssel ist hinterlegt.' : 'Damit Mitteilungen in der App ankommen, braucht der Server einmal deinen Apple-Push-Schlüssel (siehe unten).') : ''}
      ${item(st.runs_24h >= 12, 'Preisabfrage', html`Zuletzt ${ago(st.last_run_at)} · ${st.runs_24h} Durchläufe in 24 Std.${st.home_active ? ' · Heim-Server aktiv' : ''}`)}
    </ul>
    ${keyState !== 'ok' && keyState !== 'unknown' ? html`<details class="more" ${keyState !== 'missing' ? 'open' : ''}><summary>GitHub-Schlüssel eintragen</summary>
      <ol class="prose" style="padding-left:20px">
        <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a> öffnen.</li>
        <li>Name: <em>Kaufberater</em>, Ablauf: 1 Jahr. Bei <strong>Repository access</strong>: <em>Only select repositories</em> → <em>Kaufberater</em>.</li>
        <li>Bei <strong>Permissions</strong> → <em>Repository permissions</em> → <strong>Actions: Read and write</strong>.</li>
        <li><strong>Generate token</strong>, den Schlüssel kopieren und hier einfügen:</li>
      </ol>
      <form id="tokForm" style="display:flex;gap:8px"><input id="tok" type="password" autocomplete="off" placeholder="github_pat_…" required><button class="btn small" type="submit">Speichern</button></form>
      <p class="hint">Der Schlüssel wird verschlüsselt in der Datenbank gespeichert und kann nur Abläufe in deinem Kaufberater-Repo starten.</p>
    </details>` : ''}
    ${apnsMissing || (NATIVE && location.hash.includes('apns')) ? html`<details class="more" open><summary>Apple-Push-Schlüssel eintragen</summary>
      <ol class="prose" style="padding-left:20px">
        <li><a href="https://developer.apple.com/account/resources/authkeys/list" target="_blank" rel="noopener">developer.apple.com → Keys</a> → <strong>+</strong>, Name „Kaufberater Push“, Haken bei <strong>Apple Push Notifications service (APNs)</strong>, Umgebung <strong>Sandbox &amp; Production</strong> → herunterladen.</li>
        <li>Die .p8-Datei in der Dateien-App öffnen, den ganzen Text kopieren (inkl. BEGIN/END) und unten einfügen.</li>
        <li>Key-ID (10 Zeichen, steht beim Schlüssel) und Team-ID (unter „Membership details“) eintragen.</li>
      </ol>
      <form id="apnsForm">
        <div class="field"><label for="apk">Inhalt der .p8-Datei</label><textarea id="apk" required placeholder="-----BEGIN PRIVATE KEY-----"></textarea></div>
        <div class="grid-2"><div class="field"><label for="apkid">Key-ID</label><input id="apkid" type="text" required maxlength="10" autocapitalize="characters"></div>
          <div class="field"><label for="apteam">Team-ID</label><input id="apteam" type="text" required maxlength="10" autocapitalize="characters"></div></div>
        <button class="btn small" type="submit">Speichern</button>
      </form></details>` : ''}
  </section>`;
}

// ---------- Push ----------
async function saveApnsToken(token) {
  const { error } = await sb.from('kb_push_subscriptions').upsert({ endpoint: 'apns:' + token, kind: 'apns', p256dh: null, auth: null, device: 'iPhone-App' }, { onConflict: 'endpoint' });
  if (error) throw error;
}

async function currentPushState() {
  if (NATIVE) { try { return await NATIVE.call('push-status'); } catch { return 'off'; } }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}
async function enablePush() {
  if (NATIVE) {
    try { const token = await NATIVE.call('push-enable'); await saveApnsToken(token); toast('Mitteilungen sind eingeschaltet'); }
    catch (e) { toast(e.message ?? String(e)); }
    return route();
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Mitteilungen wurden nicht erlaubt'); return route(); }
    const { data: key, error } = await sb.rpc('kb_vapid_public');
    if (error || !key) throw new Error('Schlüssel nicht verfügbar');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    const j = sub.toJSON();
    const { error: e2 } = await sb.from('kb_push_subscriptions').upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device: navigator.userAgent.slice(0, 120) }, { onConflict: 'endpoint' });
    if (e2) throw e2;
    toast('Push-Nachrichten sind eingeschaltet');
  } catch (e) { toast('Einschalten fehlgeschlagen: ' + (e.message ?? e)); }
  route();
}
async function disablePush() {
  if (NATIVE) { toast('Mitteilungen schaltest du in den iPhone-Einstellungen unter Mitteilungen → Kaufberater aus.'); return; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await sb.from('kb_push_subscriptions').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); }
  toast('Ausgeschaltet'); route();
}
function b64ToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Zeitraum des Preisverlaufs (wird gemerkt) */
const RANGES = [['3m', '3 M', 92], ['6m', '6 M', 183], ['12m', '12 M', 366], ['3j', '3 J', 1096], ['all', 'Alles', null]];
function chartRange() {
  try { const v = localStorage.getItem('kb-range'); if (RANGES.some(([k]) => k === v)) return v; } catch { /* */ }
  return '12m';
}
function chartFor(rows, p, analysisHistory) {
  const days = RANGES.find(([k]) => k === chartRange())?.[2];
  const from = days ? new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) : '';
  const r = rows.filter((x) => !from || x.day >= from);
  const h = (analysisHistory ?? []).filter((x) => !from || (x?.date ?? '') >= from);
  // Hinweis, wenn die eigenen Preisdaten kürzer sind als der gewählte Zeitraum
  const firstNew = rows.find((x) => x.min_new != null)?.day;
  const note = firstNew && (!from || firstNew > from)
    ? html`<p class="hint">Preisdaten der Händler gibt es für dieses Produkt erst seit ${fmtDate(firstNew)}${rows.length && rows[0].day < firstNew ? ' – davor nur Deals' : ''}. Ältere Preise ergänzt die Tiefenanalyse (Quadrate).</p>` : '';
  return html`${raw(priceChart(r, p, h, { from }))}${note}${seriesLow(r)}`;
}

/** Tiefstpreis Neuware im Verlauf (mit Datum) – ab 30 Tagen Daten */
function seriesLow(rows) {
  const pts = rows.filter((r) => r.min_new != null);
  if (pts.length < 30) return '';
  const low = pts.reduce((m, r) => (Number(r.min_new) < Number(m.min_new) ? r : m));
  const months = Math.max(1, Math.round((Date.now() - new Date(pts[0].day)) / (30.4 * 864e5)));
  return html`<p class="hint" style="margin-top:8px">Tiefstpreis Neuware der letzten ${months} Monate: <strong>${fmtEur(Number(low.min_new))}</strong> am ${fmtDate(low.day, { day: 'numeric', month: 'long' })} (laut Preisvergleich, kann ein kurzer Einzelpreis gewesen sein).</p>`;
}

void esc; void fmtEur0;
