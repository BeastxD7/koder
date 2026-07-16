#!/usr/bin/env bash
#
# build-linux.sh — Build a single distributable LakshX .deb for Linux (x64).
#
# Mirrors the real CI pipeline (.github/workflows/build.yml) for the
# linux-x64 target, including the 2-step prepare-deb -> build-deb sequence
# that must run as SEPARATE gulp invocations (a genuine race exists if the two
# task names are passed on one command line — build.yml:184-190).
#
# Usage:
#   OS-Build/build-linux.sh            # full build -> single .deb
#   OS-Build/build-linux.sh --check    # preflight + print command sequence only
#
# Env overrides (sane defaults):
#   VSCODE_ARCH=x64        target arch
#   VSCODE_QUALITY=stable  build quality
#   GITHUB_TOKEN=...        (optional) avoids GitHub rate-limits during npm ci
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VSCODE_ARCH="${VSCODE_ARCH:-x64}"
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

phase() { printf '\n\033[1;36m==> [Linux] %s\033[0m\n' "$1"; }
info()  { printf '    %s\n' "$1"; }
die()   { printf '\033[1;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

TARGET="linux-${VSCODE_ARCH}"
# dpkg maps x64 -> amd64 (see gulpfile.vscode.linux.ts debArch).
DEB_ARCH="amd64"
case "$VSCODE_ARCH" in
	x64)   DEB_ARCH="amd64" ;;
	arm64) DEB_ARCH="arm64" ;;
	armhf) DEB_ARCH="armhf" ;;
esac
ARTIFACT="LakshX-Linux-${VSCODE_ARCH}"
DEB_DIR="${REPO_ROOT}/upstream/.build/linux/deb/${DEB_ARCH}/deb"
DEB_OUT="${REPO_ROOT}/${ARTIFACT}.deb"

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------
phase "Preflight checks"

[ "$(uname -s)" = "Linux" ] || die "This script only runs on Linux (uname=$(uname -s)). Use build-macos.sh or build-windows.ps1."

command -v node >/dev/null 2>&1 || die "node not found. Install Node 24 (see upstream/.nvmrc)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
WANT_MAJOR="24"
[ -f "${REPO_ROOT}/upstream/.nvmrc" ] && WANT_MAJOR="$(sed 's/^v//' "${REPO_ROOT}/upstream/.nvmrc" | cut -d. -f1)"
[ "$NODE_MAJOR" = "$WANT_MAJOR" ] || die "Node major ${WANT_MAJOR} required (found $(node --version))."
info "node $(node --version) (major ${NODE_MAJOR}) OK"

command -v git >/dev/null 2>&1 || die "git not found."

# The gulp build-deb task uses dpkg-deb + fakeroot (build.yml:69,160-162).
command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb not found. Install with: sudo apt-get install -y dpkg-dev"
command -v fakeroot >/dev/null 2>&1 || die "fakeroot not found. Install with: sudo apt-get install -y fakeroot"
info "dpkg-deb: $(command -v dpkg-deb)"
info "fakeroot: $(command -v fakeroot)"

# Native module compilation deps (build.yml:65-69). Warn (don't hard-fail) so a
# preflight can run on a box without them, but the build itself needs them.
MISSING=""
for pc in libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev; do
	if command -v pkg-config >/dev/null 2>&1 && ! pkg-config --exists "${pc%-dev}" 2>/dev/null; then
		MISSING="${MISSING} ${pc}"
	fi
done
command -v g++ >/dev/null 2>&1 || MISSING="${MISSING} build-essential/g++"
[ -n "$MISSING" ] && info "WARNING: possibly missing build deps:${MISSING}"
info "  (CI installs: build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev fakeroot rpm)"

info "Target:  ${TARGET} (deb arch: ${DEB_ARCH})"
info "Quality: ${VSCODE_QUALITY}"
info "Output:  ${DEB_OUT}"

# ----------------------------------------------------------------------------
# Command sequence
# ----------------------------------------------------------------------------
cat <<EOF

Command sequence (mirrors .github/workflows/build.yml linux-x64):
  1. ./scripts/fetch-vscode.sh                        # build.yml:73
  2. (cd agent && npm ci && npm run bundle)           # build.yml:76-80
  3. ./scripts/prepare.sh                              # build.yml:84
  4. (cd upstream && npm ci)                           # build.yml:90-130
        env: ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
             NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false [GITHUB_TOKEN]
  5. (cd upstream && npm run gulp vscode-${TARGET}-min)  # build.yml:135
  6. (cd upstream && npm run gulp vscode-linux-${VSCODE_ARCH}-prepare-deb)  # build.yml:189
  7. (cd upstream && npm run gulp vscode-linux-${VSCODE_ARCH}-build-deb)    # build.yml:190
        # steps 6 & 7 MUST be separate invocations — one command line races
        # (build.yml:164-183)
  8. cp .build/linux/deb/${DEB_ARCH}/deb/*.deb ${ARTIFACT}.deb  # build.yml:199
EOF

if [ "$CHECK_ONLY" -eq 1 ]; then
	phase "--check: preflight passed, skipping the heavy build"
	echo "OK: would build ${DEB_OUT}"
	exit 0
fi

cd "$REPO_ROOT"

phase "1/8 Fetch pinned code-oss (scripts/fetch-vscode.sh)"
./scripts/fetch-vscode.sh

phase "2/8 Bundle agent runtime (agent: npm ci && npm run bundle)"
( cd agent && npm ci && npm run bundle )

phase "3/8 Apply LakshX overlay (scripts/prepare.sh)"
./scripts/prepare.sh

phase "4/8 Install upstream dependencies (upstream: npm ci)"
(
	cd upstream
	export ELECTRON_SKIP_BINARY_DOWNLOAD=1
	export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
	export NPM_CONFIG_AUDIT=false
	export NPM_CONFIG_FUND=false
	npm ci
)

phase "5/8 Package (upstream: npm run gulp vscode-${TARGET}-min)"
( cd upstream && npm run gulp "vscode-${TARGET}-min" )

# 6 + 7: two SEPARATE gulp invocations — prepare-deb must fully finish before
# build-deb starts (build.yml:164-190 documents the race in detail).
phase "6/8 Prepare .deb tree (gulp vscode-linux-${VSCODE_ARCH}-prepare-deb)"
( cd upstream && npm run gulp "vscode-linux-${VSCODE_ARCH}-prepare-deb" )

phase "7/8 Build .deb package (gulp vscode-linux-${VSCODE_ARCH}-build-deb)"
( cd upstream && npm run gulp "vscode-linux-${VSCODE_ARCH}-build-deb" )

# 8: collect the single artifact (dpkg-deb names it from control fields).
phase "8/8 Finalize artifact"
[ -d "$DEB_DIR" ] || die "Expected deb output dir missing: ${DEB_DIR}"
BUILT_DEB="$(ls -1 "${DEB_DIR}"/*.deb 2>/dev/null | head -1)"
[ -n "$BUILT_DEB" ] || die "No .deb produced in ${DEB_DIR}"
cp -f "$BUILT_DEB" "$DEB_OUT"

printf '\n\033[1;32m✔ Built single distributable:\033[0m %s\n' "$DEB_OUT"
echo ""
echo "Install with:  sudo apt install ${DEB_OUT}   (or: sudo dpkg -i ${DEB_OUT})"
