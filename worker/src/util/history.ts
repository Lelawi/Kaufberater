// Preisverläufe, die Quellen beim Abruf mitliefern (billiger.de, CHECK24 …) – check.ts übernimmt sie in kb_price_history
export interface HistPoint { date: string; price: number }
export const pageHistory = new Map<string, HistPoint[]>();

// Produktbild der abgerufenen Seite (og:image bzw. Produktdaten) – check.ts übernimmt es als Vorschaubild der Liste
export const pageImage = new Map<string, string>();
export function rememberImage(pageUrl: string, html: string) {
  const og = html.match(/<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["']/i)?.[1];
  const ld = html.match(/"@type"\s*:\s*"Product"[\s\S]{0,3000}?"image"\s*:\s*(?:\[\s*)?"(https?:[^"]+)"/)?.[1];
  const raw = (og ?? ld ?? '').replace(/&amp;/g, '&').replace(/\\\//g, '/');
  if (!/^https:\/\//.test(raw) || /logo|placeholder|sprite|favicon|default[-_]?image/i.test(raw)) return;
  pageImage.set(pageUrl, raw.slice(0, 1000));
}
