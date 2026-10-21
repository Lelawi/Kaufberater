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

import { plausibleOffers, isRental } from '../src/util/plausible.ts';
test('Mietangebote und Ausreißer aussortieren', () => {
  const o = (shop: string, price: number, extra: any = {}) => ({ offerKey: shop, shop, country: 'DE', condition: 'new' as const, price, ...extra });
  const list = [o('grover.com', 13.99), o('Amazon', 329, { shopReviews: 90000 }), o('MediaMarkt', 339), o('Otto', 349), o('Saturn', 339),
    o('billig-xyz.de', 49, { shopReviews: 3 }), o('Amazon Preisfehler', 99, { shopReviews: 90000 }), o('Shop', 19.9, { title: 'Sony WH-1000XM6 mieten ab 19,90 €/Monat' })];
  const keep = plausibleOffers(list).map((x) => x.shop);
  assert.deepEqual(keep, ['Amazon', 'MediaMarkt', 'Otto', 'Saturn', 'Amazon Preisfehler']);
  assert.equal(isRental({ shop: 'expert.de', title: 'LG OLED77G68LW – Payback Punkte sammeln' }), false);
  assert.equal(isRental({ shop: 'otto.de', title: 'LG OLED77G6 – Finanzierung ab 89 € pro Monat', price: 2799 }, 2800), false);
});

import { hotWindow } from '../src/util/events.ts';
test('Heiße Phase (Black Week, Singles Day)', () => {
  assert.equal(hotWindow(new Date('2026-10-21T12:00:00Z')), null);
  assert.equal(hotWindow(new Date('2026-11-11T09:00:00Z')), 'Singles Day');
  assert.equal(hotWindow(new Date('2026-11-22T12:00:00Z')), null);
  assert.equal(hotWindow(new Date('2026-11-23T08:00:00Z')), 'Black Week');   // Montag vor BF (27.11.)
  assert.equal(hotWindow(new Date('2026-12-01T20:00:00Z')), 'Black Week');   // Dienstag nach Cyber Monday
  assert.equal(hotWindow(new Date('2026-12-02T12:00:00Z')), null);
});

import { preBlackWeekAnalysis } from '../src/util/events.ts';
test('Analyse vor der Black Week', () => {
  assert.equal(preBlackWeekAnalysis(new Date('2026-10-21T12:00:00Z')), null);
  assert.equal(preBlackWeekAnalysis(new Date('2026-11-05T12:00:00Z'))!.toISOString(), '2026-11-22T03:00:00.000Z');
  assert.equal(preBlackWeekAnalysis(new Date('2026-11-23T12:00:00Z')), null);
});

import { parseBilligerHistory } from '../src/adapters/billiger.ts';
test('Preisverlauf von billiger.de lesen', () => {
  const html = `<script type="application/json" data-pricehistory-data>{"series":[{"name":"billiger","data":[4999.0,null,4499.5]}],"labels":["21.05.2026","22.05.2026","23.05.2026"]}</script>`;
  assert.deepEqual(parseBilligerHistory(html), [{ date: '2026-05-21', price: 4999 }, { date: '2026-05-23', price: 4499.5 }]);
  assert.deepEqual(parseBilligerHistory('<html></html>'), []);
});

import { hitsFromJsonLd, hitsFromLinks } from '../src/adapters/searchshops.ts';
test('Shop-Suche: Treffer aus JSON-LD und Links', () => {
  const ld = `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"Product","name":"LG OLED77G68LW","url":"/p/123","offers":{"price":"2599.00"}}}]}</script>`;
  assert.deepEqual(hitsFromJsonLd(ld, 'https://shop.de'), [{ title: 'LG OLED77G68LW', url: 'https://shop.de/p/123', price: 2599 }]);
  const links = `<a href="/product/lg-oled77g68lw-123.html" title="LG OLED77G68LW 77 Zoll">x</a><a href="/hilfe">Hilfe und Kontakt</a>`;
  assert.deepEqual(hitsFromLinks(links, 'https://shop.de', /\/product\//).map((h) => h.url), ['https://shop.de/product/lg-oled77g68lw-123.html']);
});

import { ebayOffers, ebayCondition } from '../src/adapters/ebay.ts';
test('eBay-Angebote auswerten', () => {
  const items = [
    { itemId: 'v1|1|0', title: 'LG OLED77G68LW 77 Zoll OLED evo Gallery Neu OVP', itemWebUrl: 'https://www.ebay.de/itm/1', conditionId: '1000', price: { value: '2399.00', currency: 'EUR' }, shippingOptions: [{ shippingCost: { value: '0.00', currency: 'EUR' } }], seller: { feedbackPercentage: '99.6', feedbackScore: 15230 }, buyingOptions: ['FIXED_PRICE'] },
    { itemId: 'v1|2|0', title: 'Wandhalterung für LG OLED77G68LW', itemWebUrl: 'https://www.ebay.de/itm/2', conditionId: '1000', price: { value: '49.00', currency: 'EUR' } },
    { itemId: 'v1|3|0', title: 'LG OLED77G68LW generalüberholt', itemWebUrl: 'https://www.ebay.de/itm/3', conditionId: '2010', price: { value: '1999.00', currency: 'EUR' } },
    { itemId: 'v1|4|0', title: 'LG OLED77G68LW', itemWebUrl: 'https://www.ebay.de/itm/4', conditionId: '1000', price: { value: '2000', currency: 'GBP' } },
  ];
  const o = ebayOffers(items as any, { name: 'LG OLED77G6', model: 'OLED77G6' });
  assert.deepEqual(o.map((x) => [x.offerKey, x.condition, x.price]), [['ebay:v1|1|0', 'new', 2399], ['ebay:v1|3|0', 'refurbished', 1999]]);
  assert.equal(o[0].shopRating, 5); assert.equal(o[0].shopReviews, 15230); assert.equal(o[0].shipping, 0);
  assert.equal(ebayCondition('1500'), 'bware'); assert.equal(ebayCondition('3000'), 'used');
});

test('Zubehör-Wort in der Ausstattung ist kein Zubehör-Artikel', () => {
  const q = { name: 'LG OLED77G6', model: 'OLED77G6' };
  assert.ok(matchTitle(q, 'LG OLED77G67LW.AEUD, OLED-Fernseher 195 cm (77 Zoll), Wandhalterung, 120Hz Panel').score >= 0.9);
  assert.ok(matchTitle(q, 'Wandhalterung für LG OLED77G6 schwenkbar').score < 0.5);
});
