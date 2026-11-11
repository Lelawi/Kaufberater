// Unplausible Angebote aussortieren: Miet-/Abo-Shops (Monatspreis statt Kaufpreis) und extreme Ausreißer unbekannter Shops
import type { OfferData } from '../adapters/types.ts';

const RENTAL_SHOP = /\b(grover|rentomo|mietbar|everphone|leasy|lendis|myrent|rent2own|rentablo|klarmobil-miete|fairmondo-miete)\b/i;
const RENTAL_TEXT = /\b(mieten|miete|mietkauf|leasing)\b|\/\s*monat\b|\bmonatlich\b|\bpro monat\b|\bmtl\.?(?=\s|$)/i;

/** Miet-Shop (immer) oder Miet-Hinweis im Text (nur zusammen mit auffällig niedrigem Preis, falls ein Vergleich da ist –
 *  „Finanzierung ab 50 € pro Monat“ im Titel eines normalen Angebots soll nicht rausfliegen) */
export function isRental(o: Pick<OfferData, 'shop' | 'title' | 'url' | 'deliveryText'> & { price?: number; shipping?: number | null }, median?: number): boolean {
  if (RENTAL_SHOP.test(o.shop ?? '') || RENTAL_SHOP.test(o.url ?? '')) return true;
  if (!RENTAL_TEXT.test(`${o.title ?? ''} ${o.deliveryText ?? ''}`)) return false;
  return !median || o.price == null || o.price + (o.shipping ?? 0) < median * 0.5;
}

/**
 * Entfernt Mietangebote und Preise unter einem Drittel des Mittelwerts von wenig bekannten Shops.
 * Echte Preisfehler bei großen Händlern (viele Bewertungen) bleiben drin – die will man ja gerade finden.
 */
export function plausibleOffers<T extends OfferData>(offers: T[]): T[] {
  const totals = offers.filter((o) => o.condition === 'new').map((o) => o.price + (o.shipping ?? 0)).sort((a, b) => a - b);
  const median = totals.length >= 4 ? totals[Math.floor(totals.length / 2)] : undefined;
  const kept = offers.filter((o) => !isRental(o, median));
  if (!median) return kept;
  return kept.filter((o) => {
    const t = o.price + (o.shipping ?? 0);
    if (t >= median * 0.35) return true;
    return (o.shopReviews ?? 0) >= 500;
  });
}

/** Preisfehler/Glitches: kommen so nicht wieder → nie als Deal, Preisverlauf oder Grundlage für Schwellen (11.11.) */
export const PRICE_ERROR = /preis\s*-?\s*fehler|fehlerpreis|price\s*(?:error|glitch|mistake)|pricing\s*error|falsch\s*ausgezeichnet|preis-?glitch|\bglitch\b|erreur\s*de\s*prix|error\s*de\s*precio|errore\s*di\s*prezzo/i;

/** Marktplätze, auf denen oft Importware/andere Länderversionen verkauft werden (Garantie, Netzteil, Sprache prüfen) */
export const IMPORT_MARKET = /\b(aliexpress|temu|wish|joybuy|banggood|gearbest|tomtop|geekbuying)\b/i;
