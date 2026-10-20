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
