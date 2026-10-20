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

## Quellen (`worker/src/adapters/`)

| Quelle | Datei | Läuft auf |
|---|---|---|
| idealo.de (hunderte Händler) | `idealo.ts` | GitHub + Pi |
| billiger.de | `billiger.ts` | GitHub + Pi |
| Pepper-Portale (DE/AT/FR/ES/IT) | `pepper.ts` | GitHub + Pi |
| Shop-Seiten mit Produktdaten (expert, Galaxus, Coolblue, Hersteller …) | `shops.ts` | GitHub + Pi |
| Amazon DE/FR/IT/ES/NL | `amazon.ts` | nur Pi (blockt Rechenzentren) |
| Geizhals | `geizhals.ts` | nur Pi |
| MediaMarkt, Saturn, Otto, Cyberport … (Shop-Seiten) | `shops.ts` | nur Pi |

Neue Quelle: Datei in `adapters/` mit `search()` (Produkt finden) und `fetch()` (Angebote lesen), in `registry.ts` eintragen.

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

## Raspberry Pi

`home/install.sh` auf dem Pi ausführen → Worker läuft alle 10 Minuten mit Heimanschluss (dann auch Amazon, Geizhals, MediaMarkt …).
GitHub pausiert automatisch, solange der Pi läuft.
