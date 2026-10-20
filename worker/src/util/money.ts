// Preise aus Text lesen – robust gegen deutsche/französische/englische Schreibweisen

/** "1.299,00 €" → 1299, "1 299,99 €" → 1299.99, "€1,299.00" → 1299, "1299.-" → 1299, "849,–" → 849 */
export function parsePrice(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? round2(input) : null;
  let s = String(input)
    .replace(/ | | /g, ' ')
    .replace(/[–—-]+\s*$/, '')
    .replace(/(EUR|€|eur|Euro|EURO|\*)/g, ' ')
    .trim();
  const m = s.match(/\d[\d.,' ]*\d|\d/);
  if (!m) return null;
  s = m[0].replace(/['\s]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalized: string;
  if (lastComma === -1 && lastDot === -1) {
    normalized = s;
  } else if (lastComma > lastDot) {
    // Komma ist Dezimaltrenner, wenn danach 1-2 Ziffern stehen
    const decimals = s.length - lastComma - 1;
    normalized = decimals <= 2 ? s.slice(0, lastComma).replace(/[.,]/g, '') + '.' + s.slice(lastComma + 1) : s.replace(/[.,]/g, '');
  } else {
    const decimals = s.length - lastDot - 1;
    normalized = decimals <= 2 ? s.slice(0, lastDot).replace(/[.,]/g, '') + '.' + s.slice(lastDot + 1) : s.replace(/[.,]/g, '');
  }
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? round2(n) : null;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmtEur(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–';
  return n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}
