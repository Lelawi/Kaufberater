// Liste aller Quellen. Neue Quelle = neue Datei in adapters/ + hier eintragen.
import type { DealAdapter, SourceAdapter } from './types.ts';
import { sources as shopSources } from './shops.ts';
import { geizhalsAdapters } from './geizhals.ts';
import { idealoAdapter } from './idealo.ts';
import { amazonAdapters } from './amazon.ts';
import { pepperAdapters } from './pepper.ts';

export const SOURCES: SourceAdapter[] = [
  ...geizhalsAdapters,
  idealoAdapter,
  ...amazonAdapters,
  ...shopSources,
];

export const DEAL_SOURCES: DealAdapter[] = [...pepperAdapters];

export function sourceByKey(key: string): SourceAdapter | undefined {
  return SOURCES.find((s) => s.key === key);
}
