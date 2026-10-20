// Liste aller Quellen. Neue Quelle = neue Datei in adapters/ + hier eintragen.
import type { DealAdapter, SourceAdapter } from './types.ts';
import { sources as shopSources } from './shops.ts';
import { geizhalsAdapters } from './geizhals.ts';
import { idealoAdapter } from './idealo.ts';
import { billigerAdapter } from './billiger.ts';
import { amazonAdapters } from './amazon.ts';
import { pepperAdapters } from './pepper.ts';

export const SOURCES: SourceAdapter[] = [
  ...geizhalsAdapters,
  idealoAdapter,
  billigerAdapter,
  ...amazonAdapters,
  ...shopSources,
];

export const DEAL_SOURCES: DealAdapter[] = [...pepperAdapters];

export function sourceByKey(key: string): SourceAdapter | undefined {
  return SOURCES.find((s) => s.key === key);
}

/** Läuft der Worker auf dem Heim-Rechner (Raspberry Pi)? Dort sind auch blockierende Shops erreichbar. */
export const IS_HOME = process.env.KB_RUNNER === 'home';

export function availableHere(s: SourceAdapter): boolean {
  return IS_HOME || !s.needsHome;
}
