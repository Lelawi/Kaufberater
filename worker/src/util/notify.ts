// Welche Meldungen als Push/E-Mail rausgehen. In der App (Meldungsliste) erscheinen immer alle.
// Standard: nur Kaufsignale – also Preise, die eine Schwelle erreichen, Preisschutz und ablaufende Zeitfenster.

export type MinLevel = 'good' | 'top' | 'instant';
export interface NotifyPrefs { minLevel: MinLevel; quickCheck: boolean; important: boolean; info: boolean }
export type NotifyCategory = 'always' | 'buy' | 'quick' | 'important' | 'info';

const RANK: Record<string, number> = { good: 1, top: 2, instant: 3 };

export const DEFAULT_PREFS: NotifyPrefs = { minLevel: 'good', quickCheck: true, important: false, info: false };

export function prefsFromSettings(s: Record<string, any> | null | undefined): NotifyPrefs {
  const lvl = s?.notify_min_level;
  return {
    minLevel: lvl === 'top' || lvl === 'instant' ? lvl : 'good',
    quickCheck: s?.notify_quick_check ?? DEFAULT_PREFS.quickCheck,
    important: s?.notify_important ?? DEFAULT_PREFS.important,
    info: s?.notify_info ?? DEFAULT_PREFS.info,
  };
}

export function notifyCategory(a: { kind: string; level: string; dedup_key?: string | null }): NotifyCategory {
  if (a.dedup_key?.startsWith('test:')) return 'always';               // Testnachricht aus den Einstellungen
  if (a.kind === 'price_protection') return 'always';                   // nach dem Kauf günstiger → Geld zurückholen
  if (a.kind === 'threshold' && a.level === 'warning') return 'always'; // hartes Zeitfenster endet
  if (a.kind === 'quick_check') return 'quick';
  if (RANK[a.level] && ['threshold', 'deal', 'analysis', 'bundle', 'voucher'].includes(a.kind)) return 'buy';
  if (a.level === 'warning' || a.kind === 'successor') return 'important';
  return 'info';
}

export function shouldNotify(a: { kind: string; level: string; dedup_key?: string | null }, prefs: NotifyPrefs): boolean {
  switch (notifyCategory(a)) {
    case 'always': return true;
    case 'buy': return RANK[a.level] >= RANK[prefs.minLevel];
    case 'quick': return prefs.quickCheck;
    case 'important': return prefs.important;
    default: return prefs.info;
  }
}
