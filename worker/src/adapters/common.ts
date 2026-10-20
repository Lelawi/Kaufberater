import type { Condition } from './types.ts';

/** Zustand aus Angebotstitel erkennen (B-Ware, Refurbished, gebraucht …) */
export function conditionFromTitle(title: string | null | undefined): Condition {
  const t = (title ?? '').toLowerCase();
  if (/refurb|generalüberholt|generaluberholt|reconditionn|ricondizionat|reacondicionad|wie neu|like new|renewed/.test(t)) return 'refurbished';
  if (/b-ware|b ware|bware|ausstellungsstück|ausstellungsstueck|vorführ|vorfuehr|demo|retoure|offene verpackung|verpackung beschädigt|2\. wahl/.test(t)) return 'bware';
  if (/gebraucht|used|occasion|usato|second hand/.test(t)) return 'used';
  return 'new';
}

export function cleanText(s: string | null | undefined): string {
  return (s ?? '').replace(/­/g, '').replace(/\s+/g, ' ').trim();
}
