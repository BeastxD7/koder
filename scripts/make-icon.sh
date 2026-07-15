#!/usr/bin/env bash
# Installs the LakshX app icon (assets/koder.icns, pre-rendered from
# assets/icon.svg — regenerate with scripts/render-icon.mjs if the SVG changes)
# into upstream resources (future builds) and the live dev bundle.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f assets/koder.icns ] || { echo "assets/koder.icns missing — run node scripts/render-icon.mjs" >&2; exit 1; }

cp assets/koder.icns upstream/resources/darwin/code.icns
APP=upstream/.build/electron/Koder.app
if [ -d "$APP" ]; then
  for f in "$APP"/Contents/Resources/*.icns; do
    cp assets/koder.icns "$f"
  done
  touch "$APP"
fi
echo "LakshX icon installed"
