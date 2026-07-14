#!/usr/bin/env bash
# Apply the Koder overlay to upstream/: merge product overrides, apply patches.
# Idempotent — always starts from a clean upstream tree.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d upstream/.git ] || { echo "upstream/ missing — run scripts/fetch-vscode.sh first" >&2; exit 1; }

# Reset any previous overlay so re-running is safe
git -C upstream checkout -f -- . 2>/dev/null || true

# Merge product/product.overrides.json into upstream/product.json
node -e '
const fs = require("fs");
const product = JSON.parse(fs.readFileSync("upstream/product.json", "utf8"));
const overrides = JSON.parse(fs.readFileSync("product/product.overrides.json", "utf8"));
for (const [k, v] of Object.entries(overrides)) {
  if (v === null) delete product[k];
  else product[k] = v;
}
fs.writeFileSync("upstream/product.json", JSON.stringify(product, null, "\t") + "\n");
console.log("product.json: applied " + Object.keys(overrides).length + " overrides");
'

# Apply fork-level patches (keep this directory TINY — thin-fork discipline)
shopt -s nullglob
for p in patches/*.patch; do
  echo "applying $p"
  git -C upstream apply --3way "../$p"
done

# Koder UI layer: built-in theme extension + CSS injection
node scripts/apply-ui.mjs

# Koder icons for every platform whose assets exist
node scripts/install-icons.mjs

echo "upstream/ prepared for Koder"
