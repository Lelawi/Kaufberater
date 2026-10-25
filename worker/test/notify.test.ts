import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldNotify, prefsFromSettings, DEFAULT_PREFS } from '../src/util/notify.ts';

const a = (kind: string, level: string, dedup_key = 'x') => ({ kind, level, dedup_key });

test('Standard: nur Kaufsignale', () => {
  const p = prefsFromSettings(null);
  assert.deepEqual(p, DEFAULT_PREFS);
  assert.equal(shouldNotify(a('threshold', 'good'), p), true);
  assert.equal(shouldNotify(a('deal', 'top'), p), true);
  assert.equal(shouldNotify(a('analysis', 'top'), p), true);          // Analyse „Jetzt kaufen“
  assert.equal(shouldNotify(a('analysis', 'info'), p), false);        // Analyse „Warten“, Überwachung läuft
  assert.equal(shouldNotify(a('deal', 'info'), p), false);            // Deal über der Schwelle
  assert.equal(shouldNotify(a('bundle', 'info'), p), false);
  assert.equal(shouldNotify(a('system', 'info', 'digest:2026-43'), p), false);
  assert.equal(shouldNotify(a('successor', 'warning'), p), false);
  assert.equal(shouldNotify(a('system', 'warning'), p), false);
  assert.equal(shouldNotify(a('quick_check', 'info'), p), true);
  assert.equal(shouldNotify(a('price_protection', 'top'), p), true);
  assert.equal(shouldNotify(a('threshold', 'warning'), p), true);     // Zeitfenster endet
  assert.equal(shouldNotify(a('system', 'good', 'test:1'), p), true);
});

test('Strengere Stufe und Zusatzoptionen', () => {
  const p = prefsFromSettings({ notify_min_level: 'instant', notify_quick_check: false, notify_important: true, notify_info: false });
  assert.equal(shouldNotify(a('threshold', 'good'), p), false);
  assert.equal(shouldNotify(a('threshold', 'top'), p), false);
  assert.equal(shouldNotify(a('threshold', 'instant'), p), true);
  assert.equal(shouldNotify(a('quick_check', 'top'), p), false);
  assert.equal(shouldNotify(a('successor', 'warning'), p), true);
  assert.equal(shouldNotify(a('analysis', 'info'), p), false);
  assert.equal(shouldNotify(a('analysis', 'info'), prefsFromSettings({ notify_info: true })), true);
});
