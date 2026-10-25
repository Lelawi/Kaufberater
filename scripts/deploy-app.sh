#!/bin/bash
# Kopiert die Web-App ins öffentliche Repo kaufberater-app (GitHub Pages) und veröffentlicht sie.
# Im öffentlichen Repo liegt nur die Oberfläche – keine Zugangsdaten, keine Nutzerdaten.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)/app"
DST="${1:-/home/claude/kaufberater-app}"
VERSION=$(date +%Y%m%d%H%M)
find "$DST" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$SRC"/. "$DST"/
# iPhone-App: Quellcode + Bau-Ablauf (wird auf GitHubs Macs gebaut, kostenlos weil öffentlich)
IOS="$(cd "$(dirname "$0")/.." && pwd)/ios"
mkdir -p "$DST/ios" "$DST/.github/workflows"
cp -r "$IOS"/. "$DST/ios/"
cp "$IOS/ci/ios.yml" "$DST/.github/workflows/ios.yml"
# Neue Version → Service Worker lädt Dateien frisch
sed -i "s/const CACHE = 'kb-v[0-9a-z]*';/const CACHE = 'kb-$VERSION';/" "$DST/sw.js"
# Versionsnummer an alle eigenen Dateien hängen, damit iPhone-App und Browser nach jedem Deploy sofort die neuen
# Dateien laden statt alter Kopien aus dem Zwischenspeicher (GitHub Pages erlaubt bis zu 10 Min. Caching)
sed -i -E "s#(href|src)=\"(styles\.css|app\.js|vendor/supabase\.js)\"#\1=\"\2?v=$VERSION\"#g" "$DST/index.html"
for f in "$DST"/*.js; do
  [ "$(basename "$f")" = sw.js ] && continue
  sed -i -E "s#(from|import\() *'\./([a-z0-9_-]+)\.js'#\1 './\2.js?v=$VERSION'#g" "$f"
done
touch "$DST/.nojekyll"
cat > "$DST/README.md" <<'MD'
# Kaufberater – App

Oberfläche der persönlichen Kaufberater-App (Wunschliste mit Preisüberwachung).
Enthält keine Zugangsdaten oder Nutzerdaten; die Anmeldung läuft über Supabase.
Der Ordner `ios/` enthält die iPhone-App (Rahmen um diese Oberfläche), gebaut über `.github/workflows/ios.yml`.
MD
cd "$DST"
git add -A
git -c user.name=Claude -c user.email=noreply@anthropic.com commit -qm "App-Version $VERSION" || echo "keine Änderungen"
git push -q origin HEAD:main
echo "veröffentlicht: Version $VERSION"
