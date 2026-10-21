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

import { normalizePem, token } from '../src/util/apns.ts';
import { generateKeyPairSync, verify } from 'node:crypto';
test('Apple-Push-Schlüssel: verunstaltet eingefügt → trotzdem gültige Signatur', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const messy = '  ' + pem.replace(/\n/g, ' ') + '  ';                          // alles in einer Zeile
  const bare = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');        // ohne Kopf/Fuß
  for (const k of [pem, messy, bare]) {
    const jwt = token({ key: normalizePem(k), key_id: 'ABC123DEFG', team_id: 'TEAM123456' });
    const [h, c, s] = jwt.split('.');
    assert.equal(JSON.parse(Buffer.from(h, 'base64url').toString()).kid, 'ABC123DEFG');
    assert.equal(JSON.parse(Buffer.from(c, 'base64url').toString()).iss, 'TEAM123456');
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  }
});

import { guessModel } from '../src/util/match.ts';
test('Modellnummer aus Text raten', () => {
  assert.equal(guessModel('Sony WH 1000XM6 Noise Cancelling Kopfhörer Schwarz'), 'WH-1000XM6');
  assert.equal(guessModel('Sony WH-1000XM6 279 €'), 'WH-1000XM6');
  assert.equal(guessModel('LG OLED77G6 für 2.399 €'), 'OLED77G6');
  assert.equal(guessModel('Samsung GQ65S95F 2025'), 'GQ65S95F');
  assert.equal(guessModel('Apple iPhone 16 Pro 256 GB'), null);
  assert.equal(guessModel('Dyson V15 Detect Absolute'), null);
  assert.equal(guessModel('Philips Hue 4K 120Hz Sync Box 2024'), null);
});
