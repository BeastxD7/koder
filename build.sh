#!/usr/bin/env bash
#
# build.sh — LakshX one-command native installer builder.
#
# Detects the current OS and dispatches to the matching per-OS script in
# OS-Build/, producing a single distributable for that platform:
#     macOS   -> LakshX-macOS-<arch>.dmg   (OS-Build/build-macos.sh)
#     Linux   -> LakshX-Linux-<arch>.deb   (OS-Build/build-linux.sh)
#     Windows -> LakshX-Windows-<arch>.exe (OS-Build/build-windows.ps1)
#
# Usage:
#   ./build.sh              # build the installer for THIS OS
#   ./build.sh --check      # preflight + print the command sequence only
#   ./build.sh --help
#
# All extra args are passed straight through to the per-OS script.
# Env overrides (VSCODE_ARCH / VSCODE_QUALITY) are inherited by the child.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS_BUILD_DIR="${SCRIPT_DIR}/OS-Build"

phase() { printf '\033[1;35m%s\033[0m\n' "$1"; }
die()   { printf '\033[1;31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
	grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//; 1d'
	exit 0
fi

UNAME="$(uname -s)"
case "$UNAME" in
	Darwin)
		OS_NAME="macOS"; SCRIPT="${OS_BUILD_DIR}/build-macos.sh"; ARTIFACT="a single .dmg" ;;
	Linux)
		OS_NAME="Linux"; SCRIPT="${OS_BUILD_DIR}/build-linux.sh"; ARTIFACT="a single .deb" ;;
	MINGW*|MSYS*|CYGWIN*)
		# Windows under Git Bash — the build itself is a PowerShell script.
		OS_NAME="Windows"; SCRIPT=""; ARTIFACT="a single .exe" ;;
	*)
		die "Unsupported OS: ${UNAME}. Supported: macOS (Darwin), Linux, Windows." ;;
esac

phase "LakshX build orchestrator"
echo "  Detected OS:   ${OS_NAME} (uname=${UNAME})"
echo "  Will produce:  ${ARTIFACT} for ${OS_NAME}"
echo "  Arch:          ${VSCODE_ARCH:-<default>}   Quality: ${VSCODE_QUALITY:-stable}"
echo ""

if [ "$OS_NAME" = "Windows" ]; then
	PS1_SCRIPT="${OS_BUILD_DIR}/build-windows.ps1"
	# Translate bash-style flags to PowerShell params (the .ps1 uses -Check).
	PS_ARGS=()
	for a in "$@"; do
		case "$a" in
			--check|--dry-run) PS_ARGS+=("-Check") ;;
			*) PS_ARGS+=("$a") ;;
		esac
	done
	# Expand the args array safely even when empty (macOS bash 3.2 + set -u).
	[ ${#PS_ARGS[@]} -gt 0 ] || PS_ARGS=()
	echo "Windows builds run through PowerShell (native toolchain + Inno Setup)."
	if command -v powershell.exe >/dev/null 2>&1; then
		echo "Invoking: powershell.exe -ExecutionPolicy Bypass -File ${PS1_SCRIPT} ${PS_ARGS[*]-}"
		exec powershell.exe -ExecutionPolicy Bypass -File "$PS1_SCRIPT" ${PS_ARGS[@]+"${PS_ARGS[@]}"}
	elif command -v pwsh >/dev/null 2>&1; then
		echo "Invoking: pwsh -File ${PS1_SCRIPT} ${PS_ARGS[*]-}"
		exec pwsh -File "$PS1_SCRIPT" ${PS_ARGS[@]+"${PS_ARGS[@]}"}
	else
		die "PowerShell not found. Run it manually:\n    powershell -ExecutionPolicy Bypass -File OS-Build\\build-windows.ps1"
	fi
fi

[ -f "$SCRIPT" ] || die "Per-OS script missing: ${SCRIPT}"
[ -x "$SCRIPT" ] || chmod +x "$SCRIPT" 2>/dev/null || true

echo "Dispatching to: ${SCRIPT} $*"
exec "$SCRIPT" "$@"
