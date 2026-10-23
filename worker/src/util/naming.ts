// Saubere Produktnamen und Rückfrage bei unklaren Treffern.
// 1) Schreibweise: die eingetippten Wörter („lg oled77g6“, „philips hue gu10“) bekommen die Schreibweise,
//    die die gefundenen Produkttitel verwenden („LG OLED77G6“, „Philips Hue GU10“). Der Inhalt bleibt, was der Nutzer meinte.
// 2) Unklar: passen ohne Modellnummer mehrere verschiedene Produkte (z. B. „Hue White Ambiance“ vs.
//    „Hue Essential White & Color Ambiance“ vs. Set mit Bridge), werden sie als Auswahl zurückgegeben.

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');

/** Eingetippten Namen in die Schreibweise der gefundenen Titel bringen */
export function cleanName(name: string, titles: string[], brand?: string | null): string {
  const casings = new Map<string, Map<string, number>>();
  for (const t of titles) {
    for (const w of t.split(/[^\p{L}\p{N}+-]+/u)) {
      if (!w) continue;
      const k = fold(w);
      const m = casings.get(k) ?? new Map<string, number>();
      m.set(w, (m.get(w) ?? 0) + 1);
      casings.set(k, m);
    }
  }
  const pick = (w: string): string => {
    const m = casings.get(fold(w));
    if (m?.size) {
      // häufigste Schreibweise, aber nie GANZ GROSS bei normalen Wörtern („PHILIPS“ in Shop-Titeln)
      const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
      const nice = sorted.find(([c]) => !(c.length > 3 && c === c.toUpperCase() && !/\d/.test(c))) ?? sorted[0];
      return nice[0];
    }
    if (/\d/.test(w) && /[a-z]/i.test(w)) return w.toUpperCase();          // Modellnummer: oled77g6 → OLED77G6
    if (brand && fold(w) === fold(brand)) return brand;
    if (w === w.toLowerCase() && w.length > 1) return w[0].toUpperCase() + w.slice(1);
    return w;
  };
  return name.trim().replace(/\s+/g, ' ').split(' ').map((part) => {
    // Teile mit Bindestrich/Schrägstrich einzeln behandeln, Satzzeichen behalten
    return part.replace(/[\p{L}\p{N}+]+/gu, (w) => pick(w));
  }).join(' ');
}

// Wörter, die ein anderes Produkt (nicht nur eine andere Packung) kennzeichnen
const VARIANT: Record<string, string> = {
  essential: 'Essential', color: 'Color', colour: 'Color', farbig: 'Color', farbe: 'Color', rgb: 'Color', rgbw: 'Color', multicolor: 'Color',
  bridge: 'mit Bridge', starter: 'Starter-Set', starterset: 'Starter-Set', filament: 'Filament', outdoor: 'Outdoor', aussen: 'Outdoor',
  pro: 'Pro', max: 'Max', plus: 'Plus', ultra: 'Ultra', mini: 'Mini', lite: 'Lite', slim: 'Slim', xl: 'XL', se: 'SE', fe: 'FE',
  e27: 'E27', e14: 'E14', gu10: 'GU10', gu5: 'GU5.3', b22: 'B22', dimmschalter: 'mit Dimmschalter', fernbedienung: 'mit Fernbedienung',
  refurbished: 'Refurbished', generalueberholt: 'Refurbished',
};

export interface Suggestion { label: string; listing_ids: string[]; key: string; count: number }

/** Titel ohne Packungsangaben und technische Details – als Vorschlagstext */
export function coreTitle(t: string): string {
  return t
    .replace(/\(\s*\d+[.,]?\d*\s*\)\s*$/, '')                                       // „(5.197)“ Bewertungsanzahl
    .replace(/\b\d{1,3}\s*er[\s-]*(?:pack|set|packung)\b|\b(?:doppel|dreier|vierer|einzel|zweier)[\s-]*(?:pack|set)\b/gi, '')
    .replace(/\b\d{1,3}\s*(?:st\.?|stk\.?|stück|pcs|pack)\b/gi, '')
    .replace(/\b\d+\s*x\s*\d+\s*lm\b|\b\d+[.,]?\d*\s*(?:lm|w|watt|k|lumen)\b/gi, '')
    .replace(/\b\d{9,14}\b/g, '')                                                   // Artikelnummern/EAN
    .replace(/[|,;–-]\s*$/, '').replace(/\s*[|,;]\s*[|,;]/g, ',').replace(/\(\s*\)/g, '')
    .replace(/\s+\.(?=\s|$)/g, '').replace(/\b(\d+er)\s+\1\b/g, '').replace(/\s{2,}/g, ' ').trim().replace(/[\s,;|/-]+$/, '');
}

/**
 * Gruppiert passende Treffer nach Produktvariante. Mehr als eine Gruppe → Rückfrage sinnvoll.
 * Nur für Produkte ohne Modellnummer (bei Modellnummer ist der Treffer eindeutig).
 */
export function variantSuggestions(name: string, cands: { id: string; title: string }[]): Suggestion[] {
  const own = new Set(fold(name).split(/[^a-z0-9]+/).filter(Boolean).map((w) => VARIANT[w] ?? w));
  const groups = new Map<string, Suggestion>();
  for (const c of cands) {
    const words = fold(c.title).split(/[^a-z0-9]+/).filter(Boolean);
    const tags = [...new Set(words.map((w) => VARIANT[w]).filter((v): v is string => !!v && !own.has(v)))].sort();
    const key = tags.join('+');
    const label = coreTitle(c.title);
    const g = groups.get(key) ?? { key, label, listing_ids: [], count: 0 };
    g.listing_ids.push(c.id); g.count++;
    if (label.length && (label.length < g.label.length || !g.label)) g.label = label;    // kürzester sauberer Titel
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.key === '' ? -1 : b.key === '' ? 1 : b.count - a.count)).slice(0, 5);
}
