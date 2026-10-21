import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice } from '../src/util/money.ts';
import { matchTitle } from '../src/util/match.ts';
import { conditionFromTitle } from '../src/adapters/common.ts';

test('Preise lesen', () => {
  const cases: [string, number | null][] = [
    ['1.299,00 €', 1299], ['1 299,99 €', 1299.99], ['€1,299.00', 1299], ['2749.-', 2749], ['849,–', 849], ['2.778,90 € inkl. Versand', 2778.9],
    ['0,00 €', null], ['ab 79,90 € Versand', 79.9], ['EUR 12,5', 12.5], ['1.000', 1000], ['3099', 3099], ['', null],
  ];
  for (const [i, o] of cases) assert.equal(parsePrice(i), o, i);
});

test('Produktabgleich', () => {
  const q = { name: 'LG OLED77G6', brand: 'LG', model: 'OLED77G6', terms: ['OLED77G68LW'] };
  assert.ok(matchTitle(q, 'LG OLED77G68LW evo 77 Zoll').score >= 0.9);
  assert.ok(matchTitle(q, 'LG OLED77G58LW (77 Zoll)').score < 0.75);
  assert.ok(matchTitle(q, 'Wandhalterung für LG OLED77G68LW').score < 0.75);
  const ip = { name: 'iPhone 16 Pro 256GB', brand: 'Apple' };
  assert.ok(matchTitle(ip, 'Apple iPhone 16 Pro 256GB Titan Schwarz').score >= 0.75);
  assert.ok(matchTitle(ip, 'Apple iPhone 16 Pro 128GB Titan Schwarz').score < 0.75);
  assert.ok(matchTitle(ip, 'Apple iPhone 16 Pro Max 256GB').score < 0.75);
  assert.ok(matchTitle(ip, 'Panzerglas für iPhone 16 Pro 256GB').score < 0.75);
});

test('Zustand erkennen', () => {
  assert.equal(conditionFromTitle('LG OLED77G68LW – B-Ware, Verpackung beschädigt'), 'bware');
  assert.equal(conditionFromTitle('iPhone 15 generalüberholt'), 'refurbished');
  assert.equal(conditionFromTitle('LG OLED77G68LW evo'), 'new');
});

import { computeThresholds } from '../src/jobs/autothresholds.ts';
test('Vorläufige Schwellen', () => {
  const t = computeThresholds(2599, 2599, [2474, 2593, 2599, 2649, 3238, 3538, 2349]);
  assert.ok(t.good > t.top && t.top > t.instant, JSON.stringify(t));
  assert.ok(t.good < 2599 && t.instant < 2474, JSON.stringify(t));
  const n = computeThresholds(289, null, []);
  assert.ok(n.good < 289 && n.instant < n.top, JSON.stringify(n));
  console.log(t, n);
});

import { variantCodes } from '../src/util/match.ts';
test('Kurze Modellnummer und Varianten', () => {
  const q = { name: 'LG OLED 77G6', model: '77G6' };
  assert.ok(matchTitle(q, 'LG OLED77G68LW (77 Zoll)').score >= 0.9);
  assert.ok(matchTitle(q, 'LG OLED77G58LW (77 Zoll)').score < 0.75);
  assert.ok(matchTitle({ name: 'Samsung S921', model: 'S921' }, 'Samsung Galaxy S9210').score < 0.75);
  assert.deepEqual(variantCodes({ name: 'LG Oled77g6', model: 'OLED77G6' }, 'LG OLED77G68LW evo 77 Zoll').sort(), ['OLED77G68LW']);
});

import { effectivePrice } from '../src/adapters/pepper.ts';
test('Effektivpreis aus Deal-Titel', () => {
  assert.equal(effectivePrice('[ eff. 2474,-] LG OLED77G68LW Gallery Design'), 2474);
  assert.equal(effectivePrice('LG 2026 77 G6 (eff. 3440) OLED77G68LW'), 3440);
  assert.equal(effectivePrice('[CB] (eff. 2788,-) LG OLED77G67LW'), 2788);
  assert.equal(effectivePrice('effektiv 2.474,50 €'), 2474.5);
  assert.equal(effectivePrice('LG OLED77G68LW Berlet'), null);
});

import { nextShoppingEvent, shoppingEvents } from '../src/util/events.ts';
test('Aktionstage', () => {
  const bf = shoppingEvents(2026).find((e) => e.name === 'Black Friday')!;
  assert.equal(bf.date.toISOString().slice(0, 10), '2026-11-27');
  assert.equal(shoppingEvents(2025).find((e) => e.name === 'Black Friday')!.date.toISOString().slice(0, 10), '2025-11-28');
  const n = nextShoppingEvent(new Date('2026-10-21T10:00:00Z'))!;
  assert.equal(n.name, 'Singles Day');
});
