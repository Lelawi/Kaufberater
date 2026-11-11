import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packSize, cheapestBasket, basketText } from '../src/util/pack.ts';

test('Packungsgrößen erkennen', () => {
  const cases: [string, number | null][] = [
    ['Philips Hue GU10 LED Spot, 5er Pack | White & Color', 5], ['Philips Hue White Ambiance GU10 Doppelpack', 2],
    ['Philips Hue, Leuchtmittel, Essential White & Color Ambiance (GU10, 345 lm, 3x)', 3], ['Philips Hue Essential White & Cool Amb. 345 GU10 1P EU', 1],
    ['Philips Hue Essential White & Color Ambiance GU10 345 lm 4,7 W 3 St.', 3], ['Philips Hue White & Color Ambiance GU10 Dreierpack 3x230lm', 3],
    ['Philips HUE Led-Leuchtmittel, Weiß, Kunststoff, F, 4,7 W, 5x5.5x5 cm', null], ['Philips Hue White Ambiance GU10 18er-Pack', 18],
    ['Hue Essential GU10 - 345 Lumen - 4.7 W - 3 pack (10.590)', 3], ['Philips HUE White & Color Ambiance Essential GU10 (2x 3er-Pack)', 6],
    ['[Prime] Lot de 3 Ampoules LED connectées Philips Hue', 3], ['10x PHILIPS Hue GU10 White Ambiance', 10], ['Pack de 6 Philips Hue GU10', 6],
    ['LG OLED77G68LW 4x HDMI 2.1 120Hz', null], ['LG Fernseher OLED77G57LW + 2x xboom Buds Lite', null], ['LG OLED77G68LW, 195,6 cm (77"), 3840 x 2160 Pixel', null],
    ['iPhone 16 Pro 256GB', null], ['Philips Hue White & Color Ambiance GU10 4-fach Payback Punkte', null],
    // Review 11.11.: Beigaben/Eigenschaften sind keine Stückzahl
    ['Bosch Smart Home Heizkörper-Thermostat II inkl. 2x AA Batterien', null], ['Philips Hue White Ambiance GU10 LED 4.3W, 350lm (10 St. verfügbar)', null],
    ['Philips Hue GU10 Spot 2 x heller', null], ['Philips Hue Spot, 16 St. Szenen', null], ['Sony WH-1000XM6 inkl. 2 St. Ohrpolster', null],
    ['Philips Hue GU10 3 Stück', 3], ['Philips Hue White Ambiance GU10 2x 4,2W', 2],
  ];
  for (const [t, n] of cases) assert.equal(packSize(t), n, t);
});

test('Günstigster Einkauf für eine Menge', () => {
  const o = [{ id: 'a', shop: 'c', pack: 1, price: 29.9, shipping: 0 }, { id: 'b', shop: 'c', pack: 3, price: 55.9, shipping: 4.95 },
    { id: 'c', shop: 'c', pack: 18, price: 325.9, shipping: 0 }, { id: 'd', shop: 'c', pack: 2, price: 40.9, shipping: 0 }];
  assert.equal(cheapestBasket(o, 1)!.total, 29.9);
  const b40 = cheapestBasket(o, 40)!;
  assert.equal(b40.pieces, 40); assert.equal(b40.total, 733.6); assert.equal(basketText(b40), '2× 18er + 2× 2er');
  const b3 = cheapestBasket(o, 3)!;             // 3er (55,90 + 4,95 Versand = 60,85) vs. 2er + 1er (70,80) – Versand einmal
  assert.equal(b3.total, 60.85);
});

import { cleanName, variantSuggestions } from '../src/util/naming.ts';
test('Saubere Namen und Rückfrage bei Varianten', () => {
  assert.equal(cleanName('Lg oled77c6', ['LG OLED77C68LA', 'LG OLED77C6ELB 77" OLED evo']), 'LG OLED77C6');
  assert.equal(cleanName('Philips hue gu10 white ambiance', ['Philips Hue White Ambiance GU10 3er-Pack', 'PHILIPS Hue White Ambiance GU10']), 'Philips Hue GU10 White Ambiance');
  const s = variantSuggestions('Philips hue gu10 white ambiance', [
    'Philips Hue White Ambiance GU10 3er-Pack', 'Philips Hue White Ambiance GU10 Doppelpack mit Bridge',
    'Philips Hue Essential White & Color Ambiance GU10 345 lm 4,7 W 1 St.', 'Philips Hue White Ambiance GU10 Doppelpack',
  ].map((title, i) => ({ id: String(i), title })));
  assert.deepEqual(s.map((x) => x.label), ['Philips Hue White Ambiance GU10', 'Philips Hue White Ambiance GU10 mit Bridge', 'Philips Hue Essential White & Color Ambiance GU10']);
  assert.deepEqual(s[0].listing_ids, ['0', '3']);
  // Gleiches Produkt in verschiedenen Packungen → keine Rückfrage
  assert.equal(variantSuggestions('Philips hue gu10 white ambiance', [{ id: 'a', title: 'Philips Hue White Ambiance GU10 3er-Pack' }, { id: 'b', title: 'Philips Hue White Ambiance GU10 18er-Pack' }]).length, 1);
  // Größenvarianten (Compact/Large/groß, Länge in cm) → Rückfrage
  const tube = variantSuggestions('Hue play gradient light tube', [
    'Philips Hue Play Gradient Light Tube 125cm weiß', 'Philips Hue Play Gradient Light Tube Compact', 'Philips Hue Play Gradient Light Tube Compact White (915005987901)',
    'Philips Hue Play Gradient Light Tube groß Schwarz', 'Philips Hue Play Gradient Light Tube Large', 'Philips Hue Play Gradient Light Tube Large Black (915005988201)',
  ].map((title, i) => ({ id: String(i), title })));
  assert.deepEqual(tube.map((x) => x.key), ['Large', 'Compact', '125 cm']);
  assert.deepEqual(tube[0].listing_ids, ['3', '4', '5']);
  assert.deepEqual(tube[1].exclude, ['compact', 'kompakt']);
  // Größe schon im Namen → keine Rückfrage deswegen
  assert.equal(variantSuggestions('Hue gradient light tube large', [{ id: 'a', title: 'Philips Hue Play Gradient Light Tube Large' }, { id: 'b', title: 'Philips Hue Play Gradient Light Tube groß Schwarz' }]).length, 1);
});

import { computeTrend } from '../src/jobs/trend.ts';
test('Preistendenz', () => {
  const today = new Date('2026-10-25T12:00:00Z');
  const days = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ day: new Date(Number(today) - (n - 1 - i) * 864e5).toISOString().slice(0, 10), price: f(i) }));
  assert.equal(computeTrend(days(180, (i) => (i < 100 ? 1999 : 2199)), today)?.trend, 'rising');
  assert.equal(computeTrend(days(180, (i) => (i < 100 ? 2199 : 1999)), today)?.trend, 'falling');
  assert.equal(computeTrend(days(180, (i) => 2000 + (i % 7) * 10), today)?.trend, 'stable');
  assert.equal(computeTrend(days(40, () => 100), today), null);   // zu kurz
});
