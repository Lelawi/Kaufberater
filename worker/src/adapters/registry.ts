// Liste aller Quellen. Neue Quelle = neue Datei in adapters/ + hier eintragen.
import type { DealAdapter, SourceAdapter } from './types.ts';
import { sources as shopSources } from './shops.ts';
import { geizhalsAdapters } from './geizhals.ts';
import { idealoAdapter } from './idealo.ts';
import { billigerAdapter } from './billiger.ts';
import { amazonAdapters } from './amazon.ts';
import { pepperAdapters } from './pepper.ts';
import { refurbedAdapter } from './refurbed.ts';
import { ebayAdapter, ebayConfigured } from './ebay.ts';
import { check24Adapter } from './check24.ts';
import { shopSearchAdapters } from './shopconfigs.ts';
import { marktguruAdapter } from './marktguru.ts';

export const SOURCES: SourceAdapter[] = [
  ...geizhalsAdapters,
  idealoAdapter,
  billigerAdapter,
  check24Adapter,
  ...amazonAdapters,
  refurbedAdapter,
  // eBay nur mit Zugangsschlüsseln (GitHub-Secrets EBAY_APP_ID / EBAY_CERT_ID)
  ...(ebayConfigured() ? [ebayAdapter] : []),
  ...shopSearchAdapters,
  ...shopSources,
];

// Prospekt-Angebote (Lidl, Aldi, Kaufland, MediaMarkt, Saturn …) über Marktguru – gilt im Laden/Prospekt-Zeitraum
export const DEAL_SOURCES: DealAdapter[] = [...pepperAdapters, marktguruAdapter];

export function sourceByKey(key: string): SourceAdapter | undefined {
  return SOURCES.find((s) => s.key === key);
}

/** Läuft der Worker auf dem Heim-Rechner (Raspberry Pi)? Dort sind auch blockierende Shops erreichbar. */
export const IS_HOME = process.env.KB_RUNNER === 'home';

export function availableHere(s: SourceAdapter): boolean {
  return IS_HOME || !s.needsHome;
}
