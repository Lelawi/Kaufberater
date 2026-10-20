// Preisleiter und Preisverlauf als SVG (ohne externe Bibliothek)
import { esc, fmtEur0, fmtEur, fmtDate } from './lib.js';

/**
 * Preisleiter: horizontaler Strich von "teuer" (rechts) bis "billig" (links) mit den drei Schwellen
 * und einer Markierung, wo der aktuelle Preis steht.
 */
export function ladder(p, price) {
  const t = [p.threshold_instant, p.threshold_top, p.threshold_good ?? p.max_price].map((x) => (x ? Number(x) : null));
  const known = [...t, price, p.lowest_seen].filter((x) => x);
  if (!price || known.length < 2 || !t.some(Boolean)) return '';
  const lo = Math.min(...known) * 0.97;
  const hi = Math.max(...known, price) * 1.03;
  const W = 320; const H = 34; const pad = 2;
  const x = (v) => pad + ((v - lo) / (hi - lo)) * (W - 2 * pad);
  const zones = [];
  // Zonen: [lo..instant] gelb, [instant..top] top, [top..good] gut, [good..hi] warten
  const [ti, tt, tg] = t;
  let prev = lo;
  for (const [edge, color] of [[ti, 'var(--tag)'], [tt, 'var(--top)'], [tg, 'var(--good)']]) {
    if (!edge) continue;
    zones.push(`<rect x="${x(prev)}" y="10" width="${Math.max(0, x(edge) - x(prev))}" height="6" fill="${color}" ${color === 'var(--tag)' ? '' : 'opacity=".85"'}/>`);
    prev = edge;
  }
  zones.push(`<rect x="${x(prev)}" y="10" width="${Math.max(0, x(hi) - x(prev))}" height="6" fill="var(--line)"/>`);
  const cx = x(price);
  const low = p.lowest_seen ? `<line x1="${x(p.lowest_seen)}" x2="${x(p.lowest_seen)}" y1="6" y2="20" stroke="var(--ink-3)" stroke-width="1.5" stroke-dasharray="2 2"/>` : '';
  const anchor = cx < 40 ? 'start' : cx > W - 40 ? 'end' : 'middle';
  return `<div class="ladder" role="img" aria-label="${esc(`Aktueller Preis ${fmtEur(price)}; Schwellen: sofort ${fmtEur(ti)}, top ${fmtEur(tt)}, gut ${fmtEur(tg)}`)}">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <g>${zones.join('')}</g>${low}
      <g class="cur"><circle cx="${cx}" cy="13" r="6" fill="var(--surface)" stroke="var(--ink)" stroke-width="2.5"/>
      <text x="${cx}" y="33" text-anchor="${anchor}">${esc(fmtEur0(price))}</text></g>
    </svg></div>`;
}

/**
 * Preisverlauf: Linie Neuware, gestrichelte Linie Refurbished, Punkte für Deals, waagerechte Schwellenlinien.
 * series: [{day, min_new, min_refurb, deal_min}]
 */
export function priceChart(series, p, analysisHistory = []) {
  const pts = series.map((r) => ({ d: new Date(r.day), n: num(r.min_new), r: num(r.min_refurb), deal: num(r.deal_min) }));
  // Verlauf aus der Tiefenanalyse (z.B. Vorgänger/frühere Preise) als zusätzliche Punkte
  const hist = (analysisHistory ?? []).filter((h) => h?.date && h?.price).map((h) => ({ d: new Date(h.date), v: Number(h.price), note: h.note ?? '' }));
  const all = [...pts.flatMap((x) => [x.n, x.r, x.deal]), ...hist.map((h) => h.v), p.threshold_good, p.threshold_top, p.threshold_instant].filter((v) => v);
  const dates = [...pts.map((x) => x.d), ...hist.map((h) => h.d)];
  if (dates.length < 2 || all.length < 2) return '<p class="muted">Noch zu wenig Daten für einen Verlauf. Nach ein paar Tagen Beobachtung erscheint hier die Kurve.</p>';
  // Breite an den Bildschirm anpassen, damit Beschriftungen auf dem Handy lesbar bleiben
  const W = Math.max(300, Math.min(700, (document.getElementById('view')?.clientWidth ?? 640) - 64)); const H = Math.round(Math.max(190, Math.min(260, W * 0.55))); const L = 50; const R = 8; const T = 14; const B = 26;
  const minD = Math.min(...dates.map(Number)); const maxD = Math.max(...dates.map(Number), Date.now());
  let lo = Math.min(...all); let hi = Math.max(...all);
  const span = hi - lo || hi * 0.1; lo -= span * 0.08; hi += span * 0.08;
  const X = (d) => L + ((Number(d) - minD) / (maxD - minD || 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = (key) => {
    let d = ''; let pen = false;
    for (const x of pts) {
      if (x[key] === null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${X(x.d).toFixed(1)},${Y(x[key]).toFixed(1)}`; pen = true;
    }
    return d;
  };
  // Achsen: 4 Preislinien, Monatsbeschriftung
  const ticks = niceTicks(lo, hi, 6);
  const grid = ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/>`).join('');
  const ylab = ticks.map((v) => `<text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${esc(fmtEur0(v))}</text>`).join('');
  const months = monthTicks(minD, maxD).map((d) => `<text x="${X(d)}" y="${H - 8}" text-anchor="middle">${esc(d.toLocaleDateString('de-DE', { month: 'short', year: maxD - minD > 300 * 864e5 ? '2-digit' : undefined }))}</text>`).join('');
  const thr = [['threshold_instant', 'Sofort', 'var(--tag)'], ['threshold_top', 'Top', 'var(--top)'], ['threshold_good', 'Gut', 'var(--good)']]
    .filter(([k]) => p[k]).map(([k, label, c]) => `<line x1="${L}" x2="${W - R}" y1="${Y(p[k])}" y2="${Y(p[k])}" stroke="${c}" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${L + 4}" y="${Y(p[k]) - 4}" text-anchor="start" style="font:600 11px var(--font-num);fill:var(--ink-2);paint-order:stroke;stroke:var(--surface);stroke-width:3px">${label} ${esc(fmtEur0(p[k]))}</text>`).join('');
  const deals = pts.filter((x) => x.deal).map((x) => `<circle cx="${X(x.d)}" cy="${Y(x.deal)}" r="4.5" fill="var(--s-deal)" stroke="var(--surface)" stroke-width="2"><title>${esc(`Deal ${fmtDate(x.d)}: ${fmtEur(x.deal)}`)}</title></circle>`).join('');
  const histDots = hist.map((h) => `<rect x="${X(h.d) - 4}" y="${Y(h.v) - 4}" width="8" height="8" rx="1.5" fill="none" stroke="var(--ink-3)" stroke-width="1.8"><title>${esc(`${fmtDate(h.d)}: ${fmtEur(h.v)} ${h.note}`)}</title></rect>`).join('');
  const hasRefurb = pts.some((x) => x.r !== null);
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  const svg = `<div class="chart" id="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Preisverlauf">
    <g class="grid">${grid}</g><g class="axis">${ylab}${months}</g>${thr}
    <path d="${path('n')}" fill="none" stroke="var(--s-new)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${hasRefurb ? `<path d="${path('r')}" fill="none" stroke="var(--s-refurb)" stroke-width="2" stroke-dasharray="6 4" stroke-linejoin="round"/>` : ''}
    ${histDots}${deals}
    <g class="hover" style="display:none"><line y1="${T}" y2="${H - B}" stroke="var(--ink-3)" stroke-width="1"/><circle r="4" fill="var(--s-new)" stroke="var(--surface)" stroke-width="2"/></g>
    <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
  </svg><div class="chart-tip muted" style="min-height:1.4em;font-size:14px"></div>
  <div class="chart-legend"><span><i style="background:var(--s-new)"></i>Günstigste Neuware pro Tag</span>${hasRefurb ? '<span><i style="background:var(--s-refurb)"></i>Refurbished / B-Ware (gestrichelt)</span>' : ''}${deals ? '<span><i style="background:var(--s-deal);height:8px;width:8px;border-radius:50%"></i>Deal (mydealz & Co.)</span>' : ''}${histDots ? '<span><i style="border:1.8px solid var(--ink-3);height:8px;width:8px;background:none"></i>Früherer Preis laut Recherche</span>' : ''}</div></div>`;
  // Hover-Logik nach dem Einfügen anbinden
  queueMicrotask(() => {
    const root = document.getElementById(id); if (!root) return;
    const s = root.querySelector('svg'); const g = root.querySelector('.hover'); const tip = root.querySelector('.chart-tip');
    const line = g.querySelector('line'); const dot = g.querySelector('circle');
    const withNew = pts.filter((x) => x.n !== null);
    const move = (ev) => {
      const r = s.getBoundingClientRect();
      const px = ((ev.touches?.[0]?.clientX ?? ev.clientX) - r.left) * (W / r.width);
      const d = minD + ((px - L) / (W - L - R)) * (maxD - minD);
      let best = null; for (const x of withNew) if (!best || Math.abs(x.d - d) < Math.abs(best.d - d)) best = x;
      if (!best) return;
      g.style.display = ''; line.setAttribute('x1', X(best.d)); line.setAttribute('x2', X(best.d));
      dot.setAttribute('cx', X(best.d)); dot.setAttribute('cy', Y(best.n));
      tip.textContent = `${fmtDate(best.d)}: Neuware ab ${fmtEur(best.n)}${best.r ? ` · Refurbished ab ${fmtEur(best.r)}` : ''}${best.deal ? ` · Deal ${fmtEur(best.deal)}` : ''}`;
    };
    const hit = root.querySelector('.hit');
    hit.addEventListener('pointermove', move); hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('pointerleave', () => { g.style.display = 'none'; tip.textContent = ''; });
  });
  return svg;
}

function num(v) { return v === null || v === undefined ? null : Number(v); }
function niceTicks(lo, hi, n) {
  const step0 = (hi - lo) / n; const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}
function monthTicks(minD, maxD) {
  const out = []; const d = new Date(minD); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
  const months = (maxD - minD) / (30 * 864e5);
  const every = months > 18 ? 3 : months > 8 ? 2 : 1;
  while (d.getTime() <= maxD) { if (d.getMonth() % every === 0) out.push(new Date(d)); d.setMonth(d.getMonth() + 1); }
  if (!out.length) out.push(new Date(minD), new Date(maxD));
  return out;
}
