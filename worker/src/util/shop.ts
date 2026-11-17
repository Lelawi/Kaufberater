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

/** Kennung eines Shops für Gutscheine/Cashback/Aktionen – wie runVouchers sie speichert („Media Markt Online Shop“ → „mediamarkt“).
 *  Marktplatz-Händler („mediamarkt.de (Marktplatzhändler)“, „Amazon Marketplace“) bekommen eine eigene Kennung. */
export function shopKey(s: string | null | undefined): string {
  return normShop(s).replace(/(onlineshop|shop)$/, '');
}

/** Exakt derselbe Shop (kein Präfix-Vergleich): Gutscheine, Cashback und Shop-Aktionen gelten nur dort */
export function exactShop(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = shopKey(a); const y = shopKey(b);
  return x.length >= 2 && x === y;
}

export function hostOf(url: string | null | undefined): string {
  try { return new URL(url ?? '').host.replace(/^www\./, ''); } catch { return ''; }
}
