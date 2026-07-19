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
#
# Patches are applied in an EXPLICIT order (PATCH_ORDER below), never bare
# alphabetical globbing. Reason: two patches can both touch the same upstream
# file, where one patch's expected starting content (the "before" hash on its
# `index <before>..<after>` diff header) is exactly the OTHER patch's "after"
# hash — i.e. they form a chain and must apply in that chain's order. Bare
# `patches/*.patch` globbing applies files in alphabetical order, which has no
# relationship to a chain's required order and WILL apply such a pair
# backwards if their filenames happen to sort the wrong way.
#
# This can go undetected for a long time: `git apply --3way` falls back to a
# content-aware 3-way merge (via the blob referenced in the patch's "before"
# hash) when a plain/direct apply fails, and that fallback can succeed even
# with the patches applied backwards IF the relevant blob objects already
# happen to exist in upstream/'s local object database (e.g. because
# upstream/ is a long-lived checkout that has been through a prior successful
# `prepare.sh` run — `scripts/fetch-vscode.sh` reuses an existing upstream/
# rather than re-cloning when it's already at the pinned tag, and `git reset
# --hard` + `git clean -fd` do not prune the object database, so old loose
# objects linger). On a genuinely fresh clone (fresh CI runner, fresh
# worktree, fresh `upstream/`), none of those objects exist yet, the 3-way
# fallback fails outright ("repository lacks the necessary blob"), apply falls
# back further to a raw direct application, and the NEXT patch in the chain
# then fails hard with "does not match index" — this is exactly how this bug
# was found (reproduced via a fresh Docker build; a same-session macOS build
# reusing an already-patched-before upstream/ masked it completely).
#
# If you add a new patch that touches a file another existing patch already
# touches, add its filename to PATCH_ORDER in the correct position — compare
# the `index <before>..<after>` line from `git diff` for both patches to see
# which one's "before" hash matches the other's "after" hash, and order them
# so that chain reads start-to-finish. Patches with no such dependency don't
# need to be listed; they're applied afterward in plain alphabetical order.
PATCH_ORDER=(
  # gettingStarted.contribution.ts: 067580a4 -> bcf5e9e2 -> a737d338
  welcome-onboarding-disable-signin-popup.patch
  welcome-help-menu-lakshx-entry.patch
)

shopt -s nullglob
# Plain space-separated string, not an associative array: the macOS system
# `bash` (3.2, pre-`declare -A`) is a real target for this script, not just
# Linux/CI bash 4+.
_patch_applied=" "

apply_patch() {
  local name="$1" p="patches/$1"
  [ -f "$p" ] || { echo "PATCH_ORDER lists '$name' but patches/$name does not exist" >&2; exit 1; }
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
  _patch_applied="${_patch_applied}${name} "
}

for name in "${PATCH_ORDER[@]}"; do
  apply_patch "$name"
done

for p in patches/*.patch; do
  base="$(basename "$p")"
  case "$_patch_applied" in
    *" $base "*) continue ;;
  esac
  apply_patch "$base"
done

# LakshX UI layer: built-in theme extension + CSS injection
node scripts/apply-ui.mjs

# LakshX icons for every platform whose assets exist
node scripts/install-icons.mjs

echo "upstream/ prepared for LakshX"
