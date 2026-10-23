# Kaufberater

Persönliche Wunschliste mit Preisüberwachung: Produkt eintragen → die App sucht alle Angebote, beobachtet die Preise,
setzt Kaufschwellen und meldet sich per Push, wenn sich der Kauf lohnt.

## Aufbau

| Teil | Wo | Aufgabe |
|---|---|---|
| **App** (`app/`) | GitHub Pages, öffentliches Repo `Kaufberater-app` | Oberfläche (Web-App für den iPhone-Home-Bildschirm), Push-Empfang |
| **Datenbank** | Supabase-Projekt `marsihome`, Tabellen `kb_*` | Produkte, Angebote, Preisverlauf, Deals, Analysen, Meldungen |
| **Worker** (`worker/`) | GitHub Actions (stündlich + sofort beim Eintragen), später Raspberry Pi | Preise abrufen, Deals suchen, bewerten, Push senden |
| **Tiefenanalyse** | Geplante Claude-Aufgabe, täglich 05:49 | Preisgeschichte, Vorgänger, Aktionstage, Nachfolger, Alternativen → Schwellen |

Ablauf eines Worker-Durchlaufs (`worker/src/run.ts`):
1. **Suche** (`jobs/discovery.ts`): neue Produkte bei allen Quellen suchen, passende Treffer als Abfrageziele (`kb_listings`) speichern, Modellvarianten lernen.
2. **Preise** (`jobs/check.ts`): fällige Abfrageziele abrufen, Angebote (`kb_offers`) und Verlauf (`kb_price_history`) speichern.
3. **Deals** (`jobs/deals.ts`): mydealz, Preisjäger, Dealabs, Chollometro, Pepper.it durchsuchen (auch abgelaufene Deals = Preisgeschichte).
4. **Bewerten** (`jobs/evaluate.ts`): Endpreis nach eigenen Gutscheinen/Cashback, Schwellen prüfen, Preisschutz nach dem Kauf, Fristen, Fake-Rabatte, Bündeln.
5. **Vorläufige Schwellen** (`jobs/autothresholds.ts`): sofort aus Bestpreis + früheren Deals, bis die Tiefenanalyse übernimmt.
6. **Zustellen** (`jobs/alerts.ts`): Web-Push (und optional E-Mail).

## Preisverlauf
- Eigene Abfragen: je Angebot ein Stützpunkt pro Kalendertag und bei jeder Preisänderung (`series='offer'`).
- billiger.de liefert auf der Produktseite ca. 6 Monate Tagestiefstpreise mit (`data-pricehistory-data`) → `series='hist:billiger'` (nur fehlende Tage). Fließt in Diagramm (`kb_price_series`), vorläufige Schwellen (10-%-Tiefpunkt) und die Tiefenanalyse ein.
- Deals als Punkte (`series='deal:<portal>'`); im Diagramm werden Deals unter 40 % des Bestpreises ausgeblendet (Zubehör/Fehlzuordnung).

## Mengen, Packungen, Namen, Bilder
- **Stückzahl** (`kb_products.quantity`): Bei > 1 (z. B. 40 Lampen) gelten Bestpreis, Schwellen und Diagramm **pro Stück**; der Höchstpreis gilt für die ganze Menge. `jobs/evaluate.ts` rechnet je Händler die günstigste Kombination aus Packungsgrößen (Versand einmal) → `best_basket`.
- **Packungsgrößen** (`util/pack.ts`): aus Angebots-/Quellen-/Deal-Titeln („3er-Pack“, „Doppelpack“, „Lot de 3“, „2x 3er-Pack“) → `pack_size` an Angeboten, Deals und Verlauf. Bei Einzelprodukten werden Mehrfachpackungs-Deals nicht mit dem Einzelpreis verglichen; Sets mit Zubehör (Starter-Set, Bridge …) bekommen eine Notiz.
- **Saubere Namen** (`util/naming.ts`): eingetippter Name bekommt die Schreibweise der Treffer („lg oled77g6“ → „LG OLED77G6“, Original in `name_original`). Ohne Modellnummer und bei mehreren Produktvarianten fragt die App „Welches Produkt meinst du?“ (`name_suggestions`); abgewählte Varianten werden nicht mehr überwacht.
- **Vorschaubild** (`image_url`): og:image/Produktdaten der abgerufenen Seiten (Preisvergleiche bevorzugt).

## Schutzmechanismen
- **Freischaltung:** Nur Konten in `kb_members` dürfen Produkte/Schnellchecks anlegen (Anmeldung ist mit MarsiHome geteilt). Neues Konto freischalten: `insert into kb_members (user_id) values ('<uuid>')`.
- **Unplausible Angebote** (`util/plausible.ts`): Miet-/Abo-Shops (Grover …) und Preise < 35 % des Mittelwerts von wenig bekannten Shops fliegen raus; Deals von Import-Marktplätzen (AliExpress …) werden markiert und nicht für Schwellen genutzt.
- **Leere Preisvergleich-Seiten:** Liefert idealo/billiger plötzlich keine Angebote, obwohl vorher welche da waren, bleibt der Stand erhalten (Wiederholung nach 20 Min., Seite landet in `kb_debug` mit Tag `idealo-leer`).
- **Heiße Phase** (`util/events.ts` / `kb_hot_window()`): Singles Day und Black Week → Abfragen alle 25–30 Min., Deal-Portale alle 15 Min.; Ersatz-Taktgeber `kb_backup_tick` (pg_cron :22/:52) mit Freiminuten-Bremse (Hochrechnung ≤ 1.850 Min.). Am Sonntag vor der Black Week wird die Tiefenanalyse automatisch fällig.
- **Mitteilungen (APNs):** Schlüssel wird beim Einlesen repariert; lehnt Apple ihn ab (403), bleiben die Geräte erhalten und es kommt eine Meldung. `node worker/src/cli.ts apnsprobe` testet die Verbindung zu Apple.

## Quellen (`worker/src/adapters/`)
Stand der Erreichbarkeit (geprüft 21.10.2026 von GitHub-Actions aus): siehe Tabelle. Blockierte Shops kommen meist trotzdem über die Preisvergleiche herein.

| Quelle | Datei | Läuft auf |
|---|---|---|
| idealo.de (hunderte Händler) | `idealo.ts` | GitHub + Pi |
| billiger.de (+ ca. 6 Monate Preisverlauf) | `billiger.ts` | GitHub + Pi |
| CHECK24 Preisvergleich (inkl. Amazon, MediaMarkt, Otto, Galaxus, Kaufland, Cyberport …; + Preisverlauf). Produktseiten antworten gelegentlich mit 403 → 30 Min. Pause, dann erneut | `check24.ts` | GitHub + Pi |
| Shops mit eigener Suche: Coolblue, Alternate, Berlet, Medimax, jacob, technikdirekt, BAUR, Quelle, voelkner, rebuy (gebraucht), HiFi-Profis (Shopify) | `shopconfigs.ts` (Baustein `searchshops.ts`) | GitHub + Pi |
| eBay (offizielle Browse-API, nur mit `EBAY_APP_ID`/`EBAY_CERT_ID`) | `ebay.ts` | GitHub + Pi |
| Pepper-Portale (DE/AT/FR/ES/IT) | `pepper.ts` | GitHub + Pi |
| Einzelne Shop-Seiten mit Produktdaten (Links aus Analyse/Eintragen) | `shops.ts` | GitHub + Pi |
| Amazon DE/FR/IT/ES/NL | `amazon.ts` | nur Pi (blockt Rechenzentren) |
| Geizhals | `geizhals.ts` | nur Pi |
| MediaMarkt, Saturn, Otto, Cyberport, Kaufland, Galaxus … (Shop-Seiten) | `shops.ts` | nur Pi |

Bewusst nicht genutzt: Proxy-Dienste, Captcha-Löser, Tarn-Browser (Umgehung von Bot-Schutz). Amazon-API (Creators API) braucht 10 Partner-Verkäufe/30 Tage – für Privatnutzung nicht erreichbar; Keepa-API kostet Geld.
Weitere Ideen (Recherche 21.10.): Keepa/camelcamelcamel-Preisalarme als RSS, Geizhals-/idealo-Preisalarm-Mails per IMAP auslesen, Klarna-Preisvergleich (nur mit Browser).

Neuer Shop mit Suche: Eintrag in `shopconfigs.ts` (Such-Adresse + Auswertung). Neue eigene Quelle: Datei in `adapters/` mit `search()` und `fetch()`, in `registry.ts` eintragen.

## Befehle

```bash
node worker/src/cli.ts run all              # kompletter Durchlauf
node worker/src/cli.ts run product:<id>     # nur ein Produkt
node --test worker/test/*.test.ts            # Tests
scripts/deploy-app.sh                        # App veröffentlichen
```

## Zugangsdaten

- GitHub-Secret `KB_DB_PASSWORD`: eingeschränkter Datenbankbenutzer `kb_worker` (sieht nur `kb_*`).
- Supabase Vault `kb_github_token`: GitHub-Schlüssel (nur „Actions“ für dieses Repo), damit die Datenbank den Worker sofort starten kann.
- Push-Schlüssel (VAPID) liegen in `kb_worker_config`.

## iPhone-App (`ios/`)
- Gebaut im öffentlichen Repo `Kaufberater-app` (Workflow `ios`): ohne Apple-Secrets nur Testbuild + Probe-Archiv, mit Secrets Signieren + TestFlight-Upload.
- Schalter `share_ext=true`: baut zusätzlich den Eintrag im Teilen-Menü (`project-share.yml`, Ziel `KaufberaterShare`). Die Erweiterung übergibt per lokaler Mitteilung an die App (Erweiterungen dürfen Apps nicht direkt öffnen).
- Brücke Web-App ↔ iPhone: `window.kbNative.call('push-status' | 'push-enable' | 'push-token' | 'badge' | 'open')`, `kbNative.share` = Erweiterung vorhanden.

## Raspberry Pi

`home/install.sh` auf dem Pi ausführen → Worker läuft alle 10 Minuten mit Heimanschluss (dann auch Amazon, Geizhals, MediaMarkt …).
GitHub pausiert automatisch, solange der Pi läuft.
