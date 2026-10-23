// Packungsgrößen: „3er-Pack“, „Doppelpack“, „(GU10, 345 lm, 3x)“ … → Stückzahl je Angebot.
// Damit lassen sich Einzel- und Mehrfachpackungen fair vergleichen (Preis pro Stück) und für eine
// gewünschte Menge (z. B. 40 Lampen) der günstigste Einkauf je Händler berechnen.

const WORD: Record<string, number> = {
  einzel: 1, single: 1, doppel: 2, zweier: 2, twin: 2, duo: 2, dreier: 3, trio: 3, vierer: 4, fuenfer: 5, funfer: 5,
  sechser: 6, achter: 8, zehner: 10, zwoelfer: 12, zwolfer: 12,
};

/** Stückzahl aus einem Titel lesen; null = nichts erkannt (dann gilt 1 bzw. der Titel der Quelle) */
export function packSize(title: string | null | undefined): number | null {
  if (!title) return null;
  const t = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .replace(/fünf/g, 'fuenf').replace(/zwölf/g, 'zwoelf')
    .replace(/\+\s*\d{1,2}\s*x\s*[a-z][^+|,]*/g, ' ');   // Beigaben („+ 2x xboom Buds“) zählen nicht
  const ok = (n: number) => (Number.isInteger(n) && n >= 1 && n <= 500 ? n : null);
  let m: RegExpMatchArray | null;
  // 2x 3er-Pack, 2 x 6er Set → 6 / 12
  if ((m = t.match(/\b(\d{1,2})\s*x\s*(\d{1,3})\s*er[\s-]*(?:pack|set|packung)/))) return ok(+m[1] * +m[2]);
  // Lot de 3, Pack de 6, Set de 4, Confezione da 3, Pack 3 (FR/ES/IT-Portale)
  if ((m = t.match(/\b(?:lot|pack|set|kit|confezione|conf\.?)\s+(?:de|da|di)\s+(\d{1,3})\b/))) return ok(+m[1]);
  // 3er-Pack, 18er Pack, 2er Set, 4er-Packung, 6er Spar-Set
  if ((m = t.match(/\b(\d{1,3})\s*er[\s-]*(?:spar[\s-]*)?(?:pack|set|packung|paket|bundle|karton|box|starter)/))) return ok(+m[1]);
  // Doppelpack, Dreierpack, Einzelpack, Zweier-Set
  if ((m = t.match(/\b(einzel|single|doppel|zweier|twin|duo|dreier|trio|vierer|fuenfer|funfer|sechser|achter|zehner|zwoelfer|zwolfer)[\s-]*(?:pack|set|packung|paket)/))) return WORD[m[1]];
  // 3-Pack, 3 Pack, 3-pack, 10 pcs, 3pcs, 1P (Herstellerkürzel)
  if ((m = t.match(/\b(\d{1,3})\s*[-]?\s*(?:pack|pck|pk|pcs|pieces)\b/))) return ok(+m[1]);
  if ((m = t.match(/\b(\d{1,2})p\b(?!\s*(?:\d|ip))/))) return ok(+m[1]);
  // Pack of 4 / Packung mit 4 / Set mit 3 / Set of 3
  if ((m = t.match(/\b(?:pack|packung|set|box)\s+(?:of|mit|à|a|x)\s+(\d{1,3})\b/))) return ok(+m[1]);
  // 3 Stück, 3 Stk., 3 St., 1 St
  if ((m = t.match(/\b(\d{1,3})\s*(?:stuck|stueck|stk|st)\b\.?/))) return ok(+m[1]);
  // SET 3x …, 3x GU10, 3x350lm, 2x 4,7W, (… 3x) – aber nicht Maße wie 5x5.5x5 cm
  if ((m = t.match(/\b(\d{1,3})\s*x\s*(?!hdmi|usb|lan|sata|pci|thunderbolt|displayport|dp\b|ethernet|rj|xlr|kern|core|zoom|optisch|digital|gb|tb|mb|ghz|mhz)(?=gu\d|e\d{2}|[a-z]|\d+(?:[.,]\d+)?\s*(?:lm|w|watt|lumen)\b)/)) && !/\d\s*x\s*\d+(?:[.,]\d+)?\s*x/.test(t)) return ok(+m[1]);
  if ((m = t.match(/[\s,(](\d{1,3})\s*x\s*[)\]]/))) return ok(+m[1]);
  if ((m = t.match(/^\s*(?:\[[^\]]*\]\s*)?(\d{1,3})\s*x\s+[a-z]/))) return ok(+m[1]);
  // 4 Stück / 4 Stk am Ende schon oben; „3 Essential GU10 … Lampen“ in Starter-Sets bleibt unerkannt (Set mit Bridge, nicht vergleichbar)
  if ((m = t.match(/\bx\s*(\d{1,3})\b(?!\s*(?:cm|mm|m|x|\d))/)) && !/\d\s*x\s*\d/.test(t)) return ok(+m[1]);
  return null;
}

/** Stückzahl für ein Angebot: zuerst der Angebotstitel, dann der Titel der Quelle (Produktseite im Preisvergleich) */
export function offerPackSize(offerTitle: string | null | undefined, listingTitle: string | null | undefined): number {
  return packSize(offerTitle) ?? packSize(listingTitle) ?? 1;
}

export interface PackOffer { id: string; shop: string; pack: number; price: number; shipping: number | null }
export interface Basket {
  shop: string;
  pieces: number;            // gekaufte Stückzahl (kann über der benötigten liegen)
  goods: number;             // Warenwert ohne Versand
  shipping: number;          // einmal pro Bestellung
  total: number;             // goods + shipping
  items: { id: string; pack: number; count: number; price: number }[];
}

/**
 * Günstigster Einkauf von mindestens `need` Stück bei EINEM Händler (eine Bestellung, Versand einmal).
 * Kombiniert beliebige Packungsgrößen (z. B. 2× 18er + 2× 3er für 40 Stück).
 */
export function cheapestBasket(offers: PackOffer[], need: number): Basket | null {
  if (!offers.length || need < 1) return null;
  // je Packungsgröße nur das günstigste Angebot
  const byPack = new Map<number, PackOffer>();
  for (const o of offers) {
    if (!(o.pack >= 1) || !(o.price > 0)) continue;
    const cur = byPack.get(o.pack);
    if (!cur || o.price < cur.price) byPack.set(o.pack, o);
  }
  const packs = [...byPack.values()];
  if (!packs.length) return null;
  const maxPack = Math.max(...packs.map((p) => p.pack));
  const limit = need + maxPack;                // mehr als eine Packung „Überschuss“ lohnt nie
  const cost = new Array<number>(limit + 1).fill(Infinity);
  const pick = new Array<number>(limit + 1).fill(-1);
  cost[0] = 0;
  for (let n = 1; n <= limit; n++) {
    for (let i = 0; i < packs.length; i++) {
      const prev = n - packs[i].pack;
      if (prev < 0 || cost[prev] === Infinity) continue;
      const c = cost[prev] + packs[i].price;
      if (c < cost[n] - 1e-9) { cost[n] = c; pick[n] = i; }
    }
  }
  // günstigste Menge ≥ need; bei gleichem Preis die kleinere
  let best = -1;
  for (let n = need; n <= limit; n++) if (cost[n] < Infinity && (best < 0 || cost[n] < cost[best] - 1e-9)) best = n;
  if (best < 0) return null;
  const counts = new Map<number, number>();
  for (let n = best; n > 0; n -= packs[pick[n]].pack) counts.set(pick[n], (counts.get(pick[n]) ?? 0) + 1);
  const items = [...counts.entries()].map(([i, count]) => ({ id: packs[i].id, pack: packs[i].pack, count, price: packs[i].price }))
    .sort((a, b) => b.pack - a.pack);
  const used = items.map((it) => packs.find((p) => p.id === it.id)!);
  const shipping = Math.max(0, ...used.map((p) => p.shipping ?? 0));
  const goods = Math.round(cost[best] * 100) / 100;
  return { shop: offers[0].shop, pieces: best, goods, shipping, total: Math.round((goods + shipping) * 100) / 100, items };
}

/** „2× 18er + 1× 3er“ */
export function basketText(b: Pick<Basket, 'items'>): string {
  return b.items.map((i) => `${i.count}× ${i.pack === 1 ? 'einzeln' : i.pack + 'er'}`).join(' + ');
}
