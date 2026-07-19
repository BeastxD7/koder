#!/usr/bin/env bash
# Installs the LakshX app icon (assets/lakshx.icns, pre-rendered from
# assets/icon.svg — regenerate with scripts/render-icon.mjs if the SVG changes)
# into upstream resources (future builds) and the live dev bundle.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f assets/lakshx.icns ] || { echo "assets/lakshx.icns missing — run node scripts/render-icon.mjs" >&2; exit 1; }

cp assets/lakshx.icns upstream/resources/darwin/code.icns
# .app name derives from product.nameLong (upstream/build/lib/electron.ts),
# not a fixed "LakshX.app" — glob for whatever actually landed, same fix as
# scripts/install-icons.mjs and .github/workflows/build.yml's macOS Archive step.
APP=$(ls -d upstream/.build/electron/*.app 2>/dev/null | head -1 || true)
if [ -n "$APP" ] && [ -d "$APP" ]; then
  for f in "$APP"/Contents/Resources/*.icns; do
    cp assets/lakshx.icns "$f"
  done
  touch "$APP"
fi
echo "LakshX icon installed"
