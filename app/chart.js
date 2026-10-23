// Preisleiter und Preisverlauf als SVG (ohne externe Bibliothek)
import { esc, fmtEur0, fmtEur, fmtDate } from './lib.js';

/**
 * Preisleiter: horizontaler Strich von "teuer" (rechts) bis "billig" (links) mit den drei Schwellen
 * und einer Markierung, wo der aktuelle Preis steht.
 */
export function ladder(p, price) {
  // Höchstpreis gilt bei Mengen-Produkten für die ganze Menge → pro Stück umrechnen
  const maxUnit = p.max_price ? Number(p.max_price) / Math.max(1, Number(p.quantity ?? 1)) : null;
  const t = [p.threshold_instant, p.threshold_top, p.threshold_good ?? maxUnit].map((x) => (x ? Number(x) : null));
  price = price ? Number(price) : null;
  const known = [...t, price, p.lowest_seen ? Number(p.lowest_seen) : null].filter((x) => x);
  if (!price || known.length < 2 || !t.some(Boolean)) return '';
  const lo = Math.min(...known) * 0.97;
  const hi = Math.max(...known) * 1.03;
  const pct = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const money = (v) => (v < 100 ? fmtEur(v) : fmtEur0(v));
  const [ti, tt, tg] = t;
  // Zonen: [lo..sofort] gelb, [sofort..top] top, [top..gut] gut, darüber warten
  const segs = [];
  let prev = lo;
  for (const [edge, cls] of [[ti, 'instant'], [tt, 'top'], [tg, 'good']]) {
    if (!edge) continue;
    segs.push(`<i class="seg ${cls}" style="left:${pct(prev)}%;width:${Math.max(0, pct(edge) - pct(prev))}%"></i>`);
    prev = edge;
  }
  segs.push(`<i class="seg wait" style="left:${pct(prev)}%;width:${100 - pct(prev)}%"></i>`);
  const place = (v) => { const x = pct(v); return `left:${x}%;transform:translateX(${x < 10 ? '0' : x > 90 ? '-100%' : '-50%'})`; };
  // Schwellen-Beschriftung unter dem Strich; liegen zwei zu dicht beieinander, kommt die zweite eine Zeile tiefer
  const marks = [[ti, 'instant', 'sofort'], [tt, 'top', 'top'], [tg, 'good', 'gut']].filter(([v]) => v).sort((a, b) => a[0] - b[0]);
  let lastRow1 = -100; let rows = 1;
  const labels = marks.map(([v, cls, word]) => {
    const x = pct(v); let row = 1;
    if (x - lastRow1 < 22) { row = 2; rows = 2; } else lastRow1 = x;
    return `<span class="lab ${cls} r${row}" style="${place(v)}" title="${word}"><b>${word}</b> ${esc(money(v))}</span>`;
  }).join('');
  const ticks = marks.map(([v, cls]) => `<i class="tick ${cls}" style="left:${pct(v)}%"></i>`).join('');
  const low = p.lowest_seen ? `<i class="low" style="left:${pct(Number(p.lowest_seen))}%" title="Tiefstpreis seit Beobachtung"></i>` : '';
  return `<div class="ladder" role="img" aria-label="${esc(`Aktueller Preis ${fmtEur(price)}; Schwellen: sofort ${fmtEur(ti)}, top ${fmtEur(tt)}, gut ${fmtEur(tg)}`)}">
    <div class="lad-cur"><span style="${place(price)}">${esc(money(price))}</span></div>
    <div class="lad-bar">${segs.join('')}${ticks}${low}<i class="dot" style="left:${pct(price)}%"></i></div>
    <div class="lad-labels rows${rows}">${labels}</div></div>`;
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
  const every = months > 40 ? 6 : months > 18 ? 3 : months > 8 ? 2 : 1;
  while (d.getTime() <= maxD) { if (d.getMonth() % every === 0) out.push(new Date(d)); d.setMonth(d.getMonth() + 1); }
  if (!out.length) out.push(new Date(minD), new Date(maxD));
  return out;
}
