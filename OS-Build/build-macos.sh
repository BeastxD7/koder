#!/usr/bin/env bash
#
# build-macos.sh — Build a single distributable LakshX .dmg for macOS (arm64).
#
# Mirrors the real CI pipeline (.github/workflows/build.yml) for the
# darwin-arm64 target, then adds the DMG-creation step (which CI itself does
# NOT do — CI only zips the .app; the .dmg path is taken from upstream's own
# Azure pipeline + this session's tested manual run).
#
# Usage:
#   OS-Build/build-macos.sh            # full build -> single .dmg
#   OS-Build/build-macos.sh --check    # preflight + print command sequence only
#
# Env overrides (sane defaults):
#   VSCODE_ARCH=arm64      target arch
#   VSCODE_QUALITY=stable  build quality
#   GITHUB_TOKEN=...        (optional) avoids GitHub rate-limits during npm ci
#
set -euo pipefail

# --- locate repo root from this script's own location (never hardcode paths) --
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VSCODE_ARCH="${VSCODE_ARCH:-arm64}"
VSCODE_QUALITY="${VSCODE_QUALITY:-stable}"
export VSCODE_ARCH VSCODE_QUALITY

CHECK_ONLY=0
for arg in "$@"; do
	case "$arg" in
		--check|--dry-run) CHECK_ONLY=1 ;;
		-h|--help)
			grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//; 1d'
			exit 0 ;;
		*) echo "Unknown argument: $arg" >&2; exit 2 ;;
	esac
done

phase() { printf '\n\033[1;36m==> [macOS] %s\033[0m\n' "$1"; }
info()  { printf '    %s\n' "$1"; }
die()   { printf '\033[1;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

TARGET="darwin-${VSCODE_ARCH}"
ARTIFACT="LakshX-macOS-${VSCODE_ARCH}"
APP_BUILD_DIR="${REPO_ROOT}/VSCode-${TARGET}"    # gulp `-min` emits here (repo root)
DMG_RAW="${REPO_ROOT}/VSCode-${TARGET}.dmg"      # create-dmg names it VSCode-darwin-<arch>.dmg
DMG_OUT="${REPO_ROOT}/${ARTIFACT}.dmg"           # final, human-named artifact

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------
phase "Preflight checks"

[ "$(uname -s)" = "Darwin" ] || die "This script only runs on macOS (uname=$(uname -s)). Use OS-Build/build-linux.sh or build-windows.ps1."

command -v node >/dev/null 2>&1 || die "node not found. Install Node 24 (see upstream/.nvmrc)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
WANT_MAJOR="24"
[ -f "${REPO_ROOT}/upstream/.nvmrc" ] && WANT_MAJOR="$(sed 's/^v//' "${REPO_ROOT}/upstream/.nvmrc" | cut -d. -f1)"
[ "$NODE_MAJOR" = "$WANT_MAJOR" ] || die "Node major ${WANT_MAJOR} required (found $(node --version)). create-dmg.ts needs Node >= 24.2."
info "node $(node --version) (major ${NODE_MAJOR}) OK"

command -v git >/dev/null 2>&1 || die "git not found."

xcode-select -p >/dev/null 2>&1 || die "Xcode Command Line Tools missing. Run: xcode-select --install"
info "Xcode CLT: $(xcode-select -p)"

# create-dmg clones dmgbuild into a Python venv; needs python3 >= 3.10.
command -v python3 >/dev/null 2>&1 || die "python3 not found (needed by create-dmg.ts / dmgbuild)."
PYV="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
PYMAJ="${PYV%%.*}"; PYMIN="${PYV##*.}"
if [ "$PYMAJ" -lt 3 ] || { [ "$PYMAJ" -eq 3 ] && [ "$PYMIN" -lt 10 ]; }; then
	die "python3 >= 3.10 required (found ${PYV}). dmgbuild will otherwise try to brew install python@3.12."
fi
info "python3 ${PYV} OK"

info "Target:  ${TARGET}"
info "Quality: ${VSCODE_QUALITY}"
info "Output:  ${DMG_OUT}"

# ----------------------------------------------------------------------------
# Command sequence (printed always; executed only when not --check)
# ----------------------------------------------------------------------------
cat <<EOF

Command sequence (mirrors .github/workflows/build.yml darwin-arm64):
  1. ./scripts/fetch-vscode.sh                        # build.yml:73
  2. (cd agent && npm ci && npm run bundle)           # build.yml:76-80
  3. ./scripts/prepare.sh                              # build.yml:84
  4. (cd upstream && <ulimit raise> && npm ci)         # build.yml:90-130
        env: ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
             NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false [GITHUB_TOKEN]
  5. (cd upstream && npm run gulp vscode-${TARGET}-min)  # build.yml:135
  6. codesign --force --deep -s - "VSCode-${TARGET}/<app>"  # build.yml:152 (ad-hoc)
  7. VSCODE_ARCH=${VSCODE_ARCH} VSCODE_QUALITY=${VSCODE_QUALITY} \\
     node build/darwin/create-dmg.ts "${REPO_ROOT}" "${REPO_ROOT}"
        # source: upstream/build/azure-pipelines/darwin/.../product-build-darwin-compile.yml:311
  8. mv VSCode-${TARGET}.dmg ${ARTIFACT}.dmg
EOF

if [ "$CHECK_ONLY" -eq 1 ]; then
	phase "--check: preflight passed, skipping the heavy build"
	echo "OK: would build ${DMG_OUT}"
	exit 0
fi

cd "$REPO_ROOT"

# 1. Fetch pinned code-oss
phase "1/8 Fetch pinned code-oss (scripts/fetch-vscode.sh)"
./scripts/fetch-vscode.sh

# 2. Bundle the agent runtime
phase "2/8 Bundle agent runtime (agent: npm ci && npm run bundle)"
( cd agent && npm ci && npm run bundle )

# 3. Apply the LakshX overlay (product.json merge + patches + UI + icons)
phase "3/8 Apply LakshX overlay (scripts/prepare.sh)"
./scripts/prepare.sh

# 4. Install upstream dependencies (with the CI's load-bearing env + ulimit fix)
phase "4/8 Install upstream dependencies (upstream: npm ci)"
(
	cd upstream
	# macOS-only ulimit raise — fixes the "spawn /bin/sh ENOENT" crash from
	# ~50 parallel per-extension npm installs (build.yml:98-113).
	ulimit -n "$(ulimit -Hn)" 2>/dev/null || ulimit -n 10240 2>/dev/null || true
	ulimit -u "$(ulimit -Hu)" 2>/dev/null || ulimit -u 2048 2>/dev/null || true
	export ELECTRON_SKIP_BINARY_DOWNLOAD=1
	export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
	export NPM_CONFIG_AUDIT=false          # build.yml:129 — avoids the ENOENT crash
	export NPM_CONFIG_FUND=false
	npm ci
)

# 5. Package (gulp min build)
phase "5/8 Package (upstream: npm run gulp vscode-${TARGET}-min)"
( cd upstream && npm run gulp "vscode-${TARGET}-min" )

[ -d "$APP_BUILD_DIR" ] || die "Build output missing: ${APP_BUILD_DIR}"
APP_NAME="$(cd "$APP_BUILD_DIR" && ls -d *.app 2>/dev/null | head -1 || true)"
[ -n "$APP_NAME" ] || die "No .app found in ${APP_BUILD_DIR}"
info "Built app: ${APP_NAME}"

# 6. Ad-hoc codesign BEFORE packaging (mirrors CI's codesign-before-zip)
phase "6/8 Ad-hoc codesign (codesign --force --deep -s -)"
codesign --force --deep -s - "${APP_BUILD_DIR}/${APP_NAME}"
info "Ad-hoc signed (NOT a Developer ID signature — see README notarization caveat)."

# 7. Create the DMG
phase "7/8 Create DMG (node build/darwin/create-dmg.ts)"
( cd upstream && node build/darwin/create-dmg.ts "$REPO_ROOT" "$REPO_ROOT" )
[ -f "$DMG_RAW" ] || die "DMG not created at ${DMG_RAW}"

# 8. Rename to the human-friendly artifact name
phase "8/8 Finalize artifact"
mv -f "$DMG_RAW" "$DMG_OUT"

printf '\n\033[1;32m✔ Built single distributable:\033[0m %s\n' "$DMG_OUT"
echo ""
echo "NOTE: This DMG is ad-hoc signed only. Downloaded copies will hit Gatekeeper"
echo "      (\"LakshX is damaged and can't be opened\"). Users can bypass with:"
echo "        xattr -cr /Applications/${APP_NAME}"
echo "      Real distribution requires a Developer ID signature + Apple notarization"
echo "      (not implemented here — see OS-Build/README.md)."
