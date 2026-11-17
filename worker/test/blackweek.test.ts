// Black-Week-Härtung (Nov. 2026) – nur erfundene Beispiele
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exactShop, shopKey } from '../src/util/shop.ts';
import { effective, type Voucher, type Rate } from '../src/jobs/evaluate.ts';
import { isGeneralPromo, namesOtherCategory } from '../src/jobs/vouchers.ts';

const offer = (shop: string, price = 200) => ({ source: 'idealo', shop, price, shipping: 0, total: price });
const v = (x: Partial<Voucher>): Voucher => ({ id: 'v', kind: 'voucher', shop: null, label: 'Gutschein', code: null, value: 10, value_type: 'eur', min_order: null, valid_until: null, ...x });

test('Shops exakt vergleichen (kein Präfix, Marktplatz getrennt)', () => {
  assert.ok(exactShop('Media Markt Online Shop', 'mediamarkt'));
  assert.ok(exactShop('amazon.de', 'Amazon'));
  assert.ok(!exactShop('mediamarkt.de (Marktplatzhändler)', 'mediamarkt'));
  assert.ok(!exactShop('Amazon Marketplace', 'amazon'));
  assert.ok(!exactShop('Musterhaus Elektronik', 'musterhaus'));
  assert.ok(!exactShop('', ''));
  assert.equal(shopKey('www.musterladen.de'), 'musterladen');
});

test('Gutscheine nie global', () => {
  // ohne Shop → ignoriert
  assert.equal(effective(offer('musterladen.de'), [v({ shop: null })], []).eff, 200);
  // falscher / nur ähnlich beginnender Shop → ignoriert
  assert.equal(effective(offer('musterladen-outlet.de'), [v({ shop: 'musterladen' })], []).eff, 200);
  // exakt passender Shop → abgezogen
  assert.equal(effective(offer('Musterladen.de'), [v({ shop: 'musterladen' })], []).eff, 190);
  // anderer Bereich im Text → nicht beim Elektrogerät
  assert.equal(effective(offer('musterladen.de'), [v({ shop: 'musterladen', label: '20 % auf Backshop', value: 20, value_type: 'percent' })], [], 'Musterton MX-500').eff, 200);
});

test('Cashback: exakt, „bis zu“ nicht', () => {
  const acc = [v({ kind: 'cashback', label: 'Musterportal', value: null })];
  const r = (x: Partial<Rate>): Rate => ({ portal: 'Musterportal', shop: 'musterladen', rate_percent: 5, rate_eur: null, rate_text: '5 %', ...x });
  assert.equal(effective(offer('musterladen.de'), acc, [r({})]).eff, 190);
  assert.equal(effective(offer('musterladen.de'), acc, [r({ rate_text: 'bis zu 5 %' })]).eff, 200);
  assert.equal(effective(offer('musterladenxl.de'), acc, [r({})]).eff, 200);
});

test('Abteilungs-Aktionen sind keine allgemeinen Aktionen', () => {
  assert.ok(!isGeneralPromo('[Musterladen Plus] 20% auf alles aus dem Backshop | personalisiert'));
  assert.ok(!isGeneralPromo('15 % auf alles aus der Drogerie'));
  assert.ok(!isGeneralPromo('10 % auf das gesamte Sortiment – nur in der Filiale'));
  assert.ok(isGeneralPromo('11% Direktabzug auf alles'));
  assert.equal(namesOtherCategory('10 % auf Spielzeug', 'Musterton MX-500'), 'spielzeug');
  assert.equal(namesOtherCategory('10 € Gutschein', 'Musterton MX-500'), null);
});

import { promoValue, promoValidUntil } from '../src/jobs/vouchers.ts';
test('Wert einer Shop-Aktion', () => {
  assert.deepEqual(promoValue('ab 50 € 10 € Rabatt auf alles'), { value: 10, valueType: 'eur' });
  assert.deepEqual(promoValue('Singles Day: 11 € Rabatt ab 100 € Einkaufswert'), { value: 11, valueType: 'eur' });
  assert.deepEqual(promoValue('15 € auf das gesamte Sortiment, 200 € MBW'), { value: 15, valueType: 'eur' });
  assert.deepEqual(promoValue('11% Direktabzug ab 100 €'), { value: 11, valueType: 'percent' });
  assert.equal(promoValue('10 € ab 100 €, 25 € ab 200 € auf alles'), null);   // Staffel → mehrdeutig
  assert.equal(promoValue('10 % auf alles, 15 % ab 3 Artikeln'), null);
  assert.equal(promoValue('Rabatt ab 50 €'), null);
});

test('Gültigkeit einer Shop-Aktion', () => {
  const posted = new Date('2026-11-24T10:00:00Z');
  assert.equal(promoValidUntil('10 % auf alles', posted), '2026-11-24');
  assert.equal(promoValidUntil('10 % auf alles – gültig bis 30.11.', posted), '2026-11-30');
  assert.equal(promoValidUntil('10 % auf alles bis 05.01.', new Date('2026-12-20T10:00:00Z')), '2027-01-05');
  // 23:30 MEZ zählt noch zum selben Tag
  assert.equal(promoValidUntil('10 % auf alles', new Date('2026-11-24T22:30:00Z')), '2026-11-24');
});

import { usableTrend, lowerOnly } from '../src/jobs/autothresholds.ts';
test('Vorläufige Schwellen: Tendenz im November, nur senken', () => {
  assert.equal(usableTrend('rising', new Date('2026-11-17T12:00:00Z')), null);
  assert.equal(usableTrend('rising', new Date('2026-12-01T12:00:00Z')), null);   // noch Black Week
  assert.equal(usableTrend('rising', new Date('2026-09-10T12:00:00Z')), 'rising');
  assert.equal(usableTrend('falling', new Date('2026-11-17T12:00:00Z')), 'falling');
  assert.deepEqual(lowerOnly({ good: 100, top: 95, instant: 90 }, { good: 110, top: 93, instant: 91 }), { good: 100, top: 93, instant: 90 });
  assert.deepEqual(lowerOnly({ good: null, top: null, instant: null }, { good: 110, top: 100, instant: 90 }), { good: 110, top: 100, instant: 90 });
});

import { enoughBetter } from '../src/jobs/alerts.ts';
test('Erneute Meldung nur bei spürbarer Verbesserung', () => {
  assert.ok(!enoughBetter(2000, 1999));      // 1 € weniger beim teuren Gerät
  assert.ok(enoughBetter(2000, 1995));       // 5 €
  assert.ok(!enoughBetter(30, 29.5));        // 0,50 € (< 1 €)
  assert.ok(enoughBetter(30, 29));
  assert.ok(enoughBetter(12.5, 12.2, true)); // Stückpreis: 2 % = 0,25 €
  assert.ok(!enoughBetter(12.5, 12.4, true));
});
