// Prüft, ob ein gefundener Artikel wirklich das gesuchte Produkt ist (und kein Zubehör/andere Variante)

export interface ProductQuery {
  id?: string;
  name: string;
  brand?: string | null;
  model?: string | null;
  ean?: string | null;
  terms?: string[];        // weitere Modellnummern/Varianten
  exclude?: string[];      // Wörter, die nicht vorkommen dürfen
}

export function norm(s: string | null | undefined): string {
  return (s ?? '')
    .toUpperCase()
    .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

export function words(s: string | null | undefined): string[] {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9äöüß+]+/)
    .filter(Boolean);
}

/** Alle Modellschlüssel eines Produkts (normalisiert, mindestens 4 Zeichen, mit Ziffer) */
export function modelKeys(p: ProductQuery): string[] {
  const raw = [p.model, ...(p.terms ?? [])].filter(Boolean) as string[];
  const keys = new Set<string>();
  for (const r of raw) {
    const k = norm(r);
    if (k.length >= 4 && /\d/.test(k)) keys.add(k);
  }
  return [...keys];
}

const ACCESSORY = [
  'hulle', 'huelle', 'case', 'cover', 'schutzfolie', 'panzerglas', 'displayschutz', 'folie', 'skin', 'halterung', 'wandhalterung',
  'halter', 'kabel', 'adapter', 'ladegerat', 'ladegeraet', 'netzteil', 'fernbedienung', 'ersatz', 'ersatzteil', 'tasche', 'stander',
  'staender', 'standfuss', 'sticker', 'aufkleber', 'reparatur', 'akku', 'battery', 'charger', 'mount', 'bracket', 'protector',
  'coque', 'etui', 'housse', 'support', 'chargeur', 'cable', 'telecommande', 'funda', 'protector', 'custodia', 'pellicola',
  'kompatibel', 'compatible', 'compatibile', 'passend', 'replacement', 'dummy', 'attrappe', 'mockup', 'leergehause',
];
const VARIANT_WORDS = ['pro', 'max', 'plus', 'ultra', 'mini', 'lite', 'se', 'fe', 'neo', 'air', 'xl', 'slim', 'edge'];

export interface MatchResult { score: number; reason: string }

export function matchTitle(p: ProductQuery, title: string, extra: { gtin?: string | null; mpn?: string | null; brand?: string | null } = {}): MatchResult {
  if (!title) return { score: 0, reason: 'kein Titel' };
  const nt = norm(title);
  const tw = new Set(words(title));
  const pw = new Set(words(`${p.name} ${p.model ?? ''} ${(p.terms ?? []).join(' ')}`));

  for (const ex of p.exclude ?? []) {
    if (ex && nt.includes(norm(ex))) return { score: 0, reason: `ausgeschlossenes Wort: ${ex}` };
  }

  // Zubehör erkennen (nur wenn das Produkt selbst kein solches Wort enthält)
  const acc = ACCESSORY.find((a) => tw.has(a) && !pw.has(a));
  const forPattern = /\b(für|fur|for|pour|para|per)\b/i.test(title) && !/\b(für|for|pour)\b/i.test(p.name);
  let penalty = 1;
  let penaltyReason = '';
  if (acc) { penalty = 0.15; penaltyReason = ` – Zubehör? (${acc})`; }
  else if (forPattern) { penalty = 0.6; penaltyReason = ' – "für …" im Titel'; }

  // EAN/GTIN eindeutig
  const ean = (p.ean ?? '').replace(/\D/g, '');
  const gtin = (extra.gtin ?? '').replace(/\D/g, '');
  if (ean && gtin && (ean === gtin || ean.padStart(14, '0') === gtin.padStart(14, '0'))) {
    return { score: 1, reason: 'EAN identisch' };
  }

  // Speichergrößen müssen passen (128GB vs 256GB)
  const capP = capacities(`${p.name} ${p.model ?? ''}`);
  const capT = capacities(title);
  if (capP.length && capT.length && !capT.some((c) => capP.includes(c))) {
    return { score: 0.05, reason: `andere Speichergröße (${capT.join('/')})` };
  }

  const keys = modelKeys(p);
  const mpn = norm(extra.mpn);
  if (mpn && keys.some((k) => mpn === k || (mpn.startsWith(k) && mpn.length - k.length <= 3))) {
    return { score: 0.97 * penalty, reason: 'Herstellernummer passt' + penaltyReason };
  }
  for (const k of keys) {
    const idx = nt.indexOf(k);
    if (idx >= 0) {
      // Nachfolgende Zeichen prüfen: "OLED65C4" passt zu "OLED65C47LA", aber "S921" nicht zu "S9210"
      const after = nt.slice(idx + k.length, idx + k.length + 1);
      const sameFamily = after === '' || /[A-Z]/.test(after) || k.length >= 8;
      const sc = (sameFamily ? 0.92 : 0.6) * penalty;
      return { score: sc, reason: `Modellnummer ${k} im Titel` + penaltyReason };
    }
  }

  // Namensvergleich (für Produkte ohne Modellnummer, z.B. "iPhone 16 Pro 256GB")
  const nameWords = words(p.name).filter((w) => w.length > 1 || /\d/.test(w));
  if (!nameWords.length) return { score: 0, reason: 'kein Name' };
  const hits = nameWords.filter((w) => tw.has(w) || nt.includes(norm(w)));
  let score = hits.length / nameWords.length;
  const extraVariant = VARIANT_WORDS.filter((v) => tw.has(v) && !pw.has(v));
  if (extraVariant.length) score *= 0.35;
  if (p.brand && !nt.includes(norm(p.brand)) && !(extra.brand && norm(extra.brand) === norm(p.brand))) score *= 0.7;
  const reason = `${hits.length}/${nameWords.length} Namensteile` + (extraVariant.length ? `, andere Variante (${extraVariant.join(',')})` : '') + penaltyReason;
  return { score: Math.round(score * 0.88 * penalty * 1000) / 1000, reason };
}

function capacities(s: string): string[] {
  const out: string[] = [];
  const re = /(\d{2,4})\s*(GB|TB)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(`${m[1]}${m[2].toUpperCase()}`);
  return out;
}

/** Suchbegriff für Shops: Modellnummer bevorzugt, sonst Name */
export function searchQuery(p: ProductQuery): string {
  if (p.model && p.model.trim().length >= 4) return [p.brand, p.model].filter(Boolean).join(' ');
  return p.name;
}
