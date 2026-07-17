#!/usr/bin/env bash
# Apply the LakshX overlay to upstream/: merge product overrides, apply patches.
# Idempotent — always starts from a clean upstream tree.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -d upstream/.git ] || { echo "upstream/ missing — run scripts/fetch-vscode.sh first" >&2; exit 1; }

# Reset any previous overlay so re-running is safe. NOTE: `git apply --3way`
# (below) implies --index, so a prior successful run leaves the patched content
# STAGED in upstream/'s index. A plain `checkout -f -- .` restores the working
# tree FROM that dirty index, so the tree stays patched and the patches then
# fail to re-apply on the next run with "<file>: does not match index". Reset
# hard to the pinned tag (clears BOTH index and working tree), then clean the
# overlay-added untracked files (built-in extensions, injected assets) so
# apply-ui.mjs / install-icons.mjs regenerate from scratch. No -x on clean, so
# the gitignored node_modules / .build are preserved (no needless reinstall).
git -C upstream reset --hard HEAD
git -C upstream clean -fd

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
  # --ignore-whitespace: Windows CI runners have core.autocrlf=true globally,
  # so upstream/ is checked out with CRLF line endings there while every
  # patch here is generated (and reviewed) on a LF-only machine — without
  # this, git apply fails matching context on the very first hunk on Windows
  # only (found the hard way: a patch that applied cleanly on macOS/Linux CI
  # broke the Windows job outright). --ignore-whitespace tolerates the CRLF
  # difference when matching context without needing to touch upstream/'s
  # own autocrlf setting.
  #
  # `tr -d '\r'`: autocrlf=true ALSO checks the patch FILES out with CRLF, and
  # git apply rejects a bare \r on an otherwise-empty context line as "corrupt
  # patch at <file>:N" (hit on voice-mode-webview-inner-iframe-microphone.patch:7
  # — an empty context line in that hunk). Feed the LF-normalized patch in on
  # stdin so application is EOL-agnostic regardless of how git checked the file
  # out. (.gitattributes pins *.patch to LF for future checkouts, but that does
  # not rewrite a working tree already sitting on disk with CRLF.)
  tr -d '\r' < "$p" | git -C upstream apply --3way --ignore-whitespace
done

# LakshX UI layer: built-in theme extension + CSS injection
node scripts/apply-ui.mjs

# LakshX icons for every platform whose assets exist
node scripts/install-icons.mjs

echo "upstream/ prepared for LakshX"
