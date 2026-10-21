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
  // Zubehör-Wort zählt nur, wenn es vor der Modellnummer steht („Wandhalterung für OLED77G6“) –
  // in der Ausstattungsliste dahinter („OLED77G67LW, 195 cm, Wandhalterung“) ist es kein Zubehör-Artikel
  const keyPos = (() => { const T = title.toUpperCase().replace(/[^A-Z0-9]/g, ''); const ps = modelKeys(p).map((k) => T.indexOf(k)).filter((i) => i >= 0); return ps.length ? Math.min(...ps) : -1; })();
  const accBeforeModel = (a: string) => {
    if (keyPos < 0) return true;
    const T = norm(title); const i = T.indexOf(norm(a));
    return i >= 0 && i < keyPos;
  };
  const acc = ACCESSORY.find((a) => tw.has(a) && !pw.has(a) && accBeforeModel(a));
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
  // Modellnummer im Titel suchen – pro Wort, damit der Rest des Wortes geprüft werden kann
  const tokens = (title.toUpperCase().match(/[A-Z0-9][A-Z0-9-]*[A-Z0-9]|[A-Z0-9]/g) ?? []).map((t) => t.replace(/-/g, ''));
  for (const k of keys) {
    // Erst wortgenau, dann über Wortgrenzen hinweg (z. B. "OLED 77G6" vs. "OLED77G6")
    const tok = tokens.find((t) => t.includes(k)) ?? (nt.includes(k) ? k : null);
    if (!tok) continue;
    const rest = tok.slice(tok.indexOf(k) + k.length);
    // "OLED65C4" passt zu "OLED65C47LA" (Händler-/Farbvariante), aber "S921" nicht zu "S9210" (anderes Modell)
    const variantSuffix = rest === '' || /^[A-Z]/.test(rest) || (rest.length <= 4 && /[A-Z]/.test(rest)) || k.length >= 8;
    const sc = (variantSuffix ? 0.92 : 0.6) * penalty;
    return { score: sc, reason: `Modellnummer ${k} im Titel${rest ? ` (Variante ${tok})` : ''}` + penaltyReason };
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
  const m = p.model?.trim() ?? '';
  // Kurze Nummern („77G6“) finden in Shop-Suchen wenig → dann lieber den ganzen Namen („LG OLED 77G6“)
  if (m && norm(m).length >= 6) return [p.brand, m].filter(Boolean).join(' ');
  if (m && norm(m).length >= 4 && !norm(p.name).includes(norm(m))) return [p.brand, m].filter(Boolean).join(' ');
  return p.name;
}

/** Modellnummern aus einem Titel, die die gesuchte Nummer enthalten (z. B. OLED77G68LW für OLED77G6) */
export function variantCodes(p: ProductQuery, title: string): string[] {
  const keys = modelKeys(p);
  if (!keys.length) return [];
  const out = new Set<string>();
  for (const t of title.toUpperCase().match(/[A-Z0-9][A-Z0-9-]{3,}[A-Z0-9]/g) ?? []) {
    const c = t.replace(/-/g, '');
    if (!/\d/.test(c) || !/[A-Z]/.test(c) || c.length > 20) continue;
    for (const k of keys) {
      if (c !== k && c.includes(k)) {
        const rest = c.slice(c.indexOf(k) + k.length);
        if (rest.length <= 4 && /[A-Z]/.test(rest + 'A'.repeat(rest === '' ? 1 : 0))) out.add(c);
      }
    }
  }
  return [...out];
}

/**
 * Modellnummer aus freiem Text/Link-Namen raten (z. B. „Sony WH-1000XM6 Kopfhörer“ → „WH-1000XM6“, „LG OLED77G6“ → „OLED77G6“).
 * Nur eindeutige Nummern mit Buchstaben nach den Ziffern („1000XM6“, „77G6“) – „iPhone 16“ zählt nicht, da zu allgemein.
 */
export function guessModel(text: string): string | null {
  const re = /(?<![A-Za-z0-9])([A-Za-z]{0,6})([- ]?)(\d{2,}[A-Za-z][A-Za-z0-9]*|\d{4,}[A-Za-z0-9]*)(?![A-Za-z0-9])/g;
  let m: RegExpExecArray | null; let best: string | null = null;
  while ((m = re.exec(text))) {
    const [full, prefix, , core] = m;
    if (/^\d+(GB|TB|MB|HZ|W|MAH|MM|CM|ZOLL|K|P|FPS|MP)$/i.test(core)) continue;   // 256GB, 120Hz, 4K …
    if (/^(19|20)\d{2}$/.test(core)) continue;                                        // Jahreszahl
    const cand = prefix ? full : core;
    if (norm(cand).length < 5) continue;
    if (!best || norm(cand).length > norm(best).length) best = cand.replace(/ /, '-');
  }
  return best;
}
