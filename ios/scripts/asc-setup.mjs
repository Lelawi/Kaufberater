// Bereitet den Apple-Account vor (über die App-Store-Connect-Schnittstelle):
// 1. App-ID (Bundle-ID) registrieren, falls noch nicht vorhanden
// 2. Push-Mitteilungen für die App-ID einschalten
// 3. Prüfen, ob es den App-Eintrag in App Store Connect schon gibt (den muss man einmal von Hand anlegen)
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';

const { ASC_KEY_ID, ASC_ISSUER_ID } = process.env;
const BUNDLE = process.env.BUNDLE_ID ?? 'de.lelawi.kaufberater';
const keyPem = readFileSync(`${process.env.HOME}/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8`, 'utf8');

const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' });
  const body = b64({ iss: ASC_ISSUER_ID, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' });
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: createPrivateKey(keyPem), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64(sig)}`;
}
async function api(method, path, body) {
  const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method, headers: { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { status: r.status, json, text };
}

let r = await api('GET', `/v1/bundleIds?filter[identifier]=${BUNDLE}&limit=5`);
if (r.status !== 200) { console.log(`::error::App Store Connect lehnt den Schlüssel ab (${r.status}). Key-ID, Issuer-ID und .p8 prüfen; Zugriff muss „Admin“ sein.`); console.log(r.text); process.exit(1); }
let bundle = r.json.data.find((b) => b.attributes.identifier === BUNDLE);
if (!bundle) {
  r = await api('POST', '/v1/bundleIds', { data: { type: 'bundleIds', attributes: { identifier: BUNDLE, name: 'Kaufberater', platform: 'IOS' } } });
  if (r.status !== 201) { console.log('::error::App-ID konnte nicht angelegt werden'); console.log(r.text); process.exit(1); }
  bundle = r.json.data;
  console.log('App-ID angelegt:', BUNDLE);
} else console.log('App-ID vorhanden:', BUNDLE);

r = await api('POST', '/v1/bundleIdCapabilities', {
  data: { type: 'bundleIdCapabilities', attributes: { capabilityType: 'PUSH_NOTIFICATIONS' },
          relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } } } },
});
console.log('Push-Mitteilungen:', r.status === 201 ? 'eingeschaltet' : r.status === 409 ? 'schon an' : `Status ${r.status}`);

r = await api('GET', `/v1/apps?filter[bundleId]=${BUNDLE}&limit=1`);
if (!r.json?.data?.length) {
  console.log(`::error::Es gibt noch keinen App-Eintrag in App Store Connect. Bitte einmal anlegen: appstoreconnect.apple.com → Apps → + → Neue App, Plattform iOS, Bundle-ID „${BUNDLE}“, Name z. B. „Kaufberater (privat)“, SKU „kaufberater“. Danach diesen Ablauf erneut starten.`);
  process.exit(2);
}
console.log('App-Eintrag vorhanden:', r.json.data[0].attributes.name);
