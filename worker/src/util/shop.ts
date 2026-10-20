/** Shopnamen vergleichbar machen: "Amazon.de" → "amazon", "Media Markt" → "mediamarkt" */
export function normShop(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.(de|com|fr|it|es|nl|be|at|pl|eu|co\.uk|ch)(\/.*)?$/, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function sameShop(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normShop(a); const y = normShop(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 4 && y.startsWith(x)) || (y.length >= 4 && x.startsWith(y));
}

export function hostOf(url: string | null | undefined): string {
  try { return new URL(url ?? '').host.replace(/^www\./, ''); } catch { return ''; }
}
