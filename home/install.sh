#!/bin/bash
# Kaufberater auf dem Raspberry Pi (oder jedem Linux-Rechner zuhause) einrichten.
# Aufruf auf dem Pi:  curl -fsSL <Link zu dieser Datei> | bash
# Danach fragt das Skript einmal nach dem Datenbank-Passwort und einem GitHub-Zugangsschlüssel (nur Lesen).
set -euo pipefail
DIR="$HOME/kaufberater"
echo "== Kaufberater Heim-Server einrichten =="

# 1) Node.js 22 installieren (falls nicht vorhanden)
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  echo "Installiere Node.js 22 …"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs git
fi

# 2) Zugangsdaten abfragen
if [ ! -f "$DIR/.env" ]; then
  read -rsp "Datenbank-Passwort (KB_DB_PASSWORD): " DBPW </dev/tty; echo
  read -rsp "GitHub-Zugangsschlüssel (nur Lesen, für das private Repo): " GHT </dev/tty; echo
else
  source "$DIR/.env"; DBPW="$KB_DB_PASSWORD"; GHT="$KB_GH_TOKEN"
fi

# 3) Code holen bzw. aktualisieren
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull -q
else
  git clone -q "https://x-access-token:${GHT}@github.com/Lelawi/Kaufberater.git" "$DIR"
fi
cd "$DIR"
umask 077
cat > .env <<ENV
KB_DB_PASSWORD=$DBPW
KB_GH_TOKEN=$GHT
KB_RUNNER=home
KB_BUDGET_MINUTES=8
ENV
npm install --no-audit --no-fund --omit=dev
npx playwright install chromium --with-deps --only-shell || echo "Browser optional – weiter ohne"

# 4) Alle 10 Minuten laufen lassen (systemd-Timer), Code nachts automatisch aktualisieren
sudo tee /etc/systemd/system/kaufberater.service >/dev/null <<UNIT
[Unit]
Description=Kaufberater Preisabfrage
After=network-online.target
[Service]
Type=oneshot
User=$USER
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
ExecStartPre=-/usr/bin/git -C $DIR pull -q
ExecStartPre=-/usr/bin/npm install --no-audit --no-fund --omit=dev --prefix $DIR
ExecStart=/usr/bin/node worker/src/cli.ts run all
TimeoutStartSec=900
Nice=10
UNIT
sudo tee /etc/systemd/system/kaufberater.timer >/dev/null <<UNIT
[Unit]
Description=Kaufberater alle 10 Minuten
[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
Persistent=true
[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now kaufberater.timer
echo
echo "Fertig. Erster Lauf startet in Kürze. Status ansehen:  systemctl status kaufberater"
echo "Protokoll ansehen:  journalctl -u kaufberater -n 50"
