#!/usr/bin/env bash
#
# lib-preflight.sh — shared requirements/environment gate for LakshX builds.
#
# Sourced by OS-Build/build-macos.sh and OS-Build/build-linux.sh (the Windows
# build re-implements the same logic in build-windows.ps1). Provides:
#   - a collect-ALL results model (never bail on the first failure, so the user
#     sees the complete todo list and fixes everything in one pass)
#   - an exact replica of upstream/build/npm/preinstall.ts's Node.js gate
#     (>= the version pinned in upstream/.nvmrc AND the same major version),
#     so the preflight never green-lights a Node the upstream build rejects.
#   - an OPT-IN, interactive, OS-aware auto-fix step: after the checklist, for
#     the fixable items it prompts [y/N], shows the exact command, and only runs
#     it on an explicit "yes". Never prompts in --check / CI / non-TTY / when
#     --non-interactive is passed. It never silently installs anything.
#
# IMPORTANT (set -e safety): the callers run under `set -euo pipefail`. A bare
# probe that returns non-zero (e.g. `command -v foo`, a false `[ ]` test, or
# `x=$(failing_cmd)`) would abort the WHOLE script before the rest of the gate
# runs — silently breaking the "collect all results" contract. Every probe in
# here is therefore wrapped in an `if`/guarded with `|| true`. Keep it that way.
#
# Results are recorded, not printed, during the checks; pf_summarize() prints
# the aligned PASS/FAIL/WARN table at the end and returns non-zero iff any FAIL.

# --- result store (bash 3.2 compatible: indexed array of delimited strings) ---
# Row = STATUS | NAME | DETAIL | REMEDIATION | FIXCMD | FIXKIND | FIXPROMPT
#   FIXKIND: install  -> real auto-install, effective in the same shell -> re-run gate
#            shell    -> real install but needs a fresh shell (nvm)     -> re-run script
#            guided   -> NOT a silent install (e.g. xcode-select --install pops a GUI)
#            ""       -> no auto-fix; remediation text only
PF_SEP=$'\x1f'          # unit separator — will not appear in our text
PF_ROWS=()
PF_FAIL=0
PF_WARN=0

pf_reset() { PF_ROWS=(); PF_FAIL=0; PF_WARN=0; }

# pf_record STATUS NAME DETAIL REMEDIATION [FIXCMD] [FIXKIND] [FIXPROMPT]
pf_record() {
	PF_ROWS+=("${1}${PF_SEP}${2}${PF_SEP}${3}${PF_SEP}${4:-}${PF_SEP}${5:-}${PF_SEP}${6:-}${PF_SEP}${7:-}")
	case "$1" in
		FAIL) PF_FAIL=$((PF_FAIL + 1)) ;;
		WARN) PF_WARN=$((PF_WARN + 1)) ;;
	esac
}
pf_pass() { pf_record PASS "$1" "$2" "$3"; }
pf_warn() { pf_record WARN "$1" "$2" "$3" "${4:-}" "${5:-}" "${6:-}"; }
pf_fail() { pf_record FAIL "$1" "$2" "$3" "${4:-}" "${5:-}" "${6:-}"; }

# pf_split_row ROWSTRING -> sets globals _PF_ST _PF_NM _PF_DT _PF_RM _PF_FC _PF_FK _PF_FP
pf_split_row() {
	local r="$1"
	_PF_ST="${r%%${PF_SEP}*}"; r="${r#*${PF_SEP}}"
	_PF_NM="${r%%${PF_SEP}*}"; r="${r#*${PF_SEP}}"
	_PF_DT="${r%%${PF_SEP}*}"; r="${r#*${PF_SEP}}"
	_PF_RM="${r%%${PF_SEP}*}"; r="${r#*${PF_SEP}}"
	_PF_FC="${r%%${PF_SEP}*}"; r="${r#*${PF_SEP}}"
	_PF_FK="${r%%${PF_SEP}*}"; r="${r#*${PF_SEP}}"
	_PF_FP="$r"
}

# pf_semver_parts VERSION -> sets globals _PF_MAJ _PF_MIN _PF_PAT (numeric)
pf_semver_parts() {
	local v="${1%%-*}"          # strip any -prerelease suffix
	v="${v#v}"                  # tolerate a leading v
	local maj min pat rest
	maj="${v%%.*}"
	rest="${v#*.}"
	min="${rest%%.*}"
	pat="${rest#*.}"
	pat="${pat%%.*}"
	case "$maj" in ''|*[!0-9]*) maj=0 ;; esac
	case "$min" in ''|*[!0-9]*) min=0 ;; esac
	case "$pat" in ''|*[!0-9]*) pat=0 ;; esac
	_PF_MAJ="$maj"; _PF_MIN="$min"; _PF_PAT="$pat"
}

# pf_nvm_available -> 0 if an nvm we can source/use is present.
pf_nvm_available() {
	if command -v nvm >/dev/null 2>&1; then return 0; fi
	local d="${NVM_DIR:-$HOME/.nvm}"
	[ -s "${d}/nvm.sh" ]
}

# ---------------------------------------------------------------------------
# Individual checks. Each takes what it needs and calls pf_pass/warn/fail.
# ---------------------------------------------------------------------------

# pf_check_node REPO_ROOT
# Exact replica of upstream/build/npm/preinstall.ts:
#   FAIL if  major != reqMajor  OR  minor < reqMinor
#            OR (minor == reqMinor AND patch < reqPatch)
# i.e. running Node must be the SAME major AND >= the .nvmrc version. A numeric
# (not string) compare is essential: 24.9.0 vs 24.17.0 must read 9 < 17.
pf_check_node() {
	local repo_root="$1"
	local nvmrc="${repo_root}/upstream/.nvmrc"
	local req="24.17.0"
	if [ -f "$nvmrc" ]; then
		local parsed
		parsed="$(sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^v//' "$nvmrc" 2>/dev/null | head -1 || true)"
		[ -n "$parsed" ] && req="$parsed"
	fi
	pf_semver_parts "$req"; local rmaj="$_PF_MAJ" rmin="$_PF_MIN" rpat="$_PF_PAT"

	# OS-aware auto-fix: nvm (mac+linux) if available, else guided remediation.
	local fixcmd="" fixkind="" fixprompt=""
	if pf_nvm_available; then
		fixcmd="export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"; nvm install ${req} && nvm use ${req}"
		fixkind="shell"
		fixprompt="Install Node v${req} now via nvm? (nvm changes apply to a fresh shell) [y/N]"
	fi
	local guided_rem
	guided_rem="nvm install ${req} && nvm use ${req}   (no nvm? install Node v${req}, major ${rmaj}, from nodejs.org or your package manager)"

	if ! command -v node >/dev/null 2>&1; then
		pf_fail "Node.js" "not found (required v${req})" "$guided_rem" "$fixcmd" "$fixkind" "$fixprompt"
		return
	fi

	local cur
	cur="$(node -p 'process.versions.node' 2>/dev/null || true)"
	[ -n "$cur" ] || cur="$(node --version 2>/dev/null | sed 's/^v//' || true)"
	if [ -z "$cur" ]; then
		pf_fail "Node.js" "installed but version unreadable (required v${req})" "$guided_rem" "$fixcmd" "$fixkind" "$fixprompt"
		return
	fi
	pf_semver_parts "$cur"; local cmaj="$_PF_MAJ" cmin="$_PF_MIN" cpat="$_PF_PAT"

	if [ "$cmaj" -ne "$rmaj" ] || [ "$cmin" -lt "$rmin" ] \
		|| { [ "$cmin" -eq "$rmin" ] && [ "$cpat" -lt "$rpat" ]; }; then
		pf_fail "Node.js" "v${cur} installed, need v${req} (same major ${rmaj}, >= ${req})" \
			"$guided_rem" "$fixcmd" "$fixkind" "$fixprompt"
	else
		pf_pass "Node.js" "v${cur} (>= v${req}, major ${rmaj}) OK" ""
	fi
}

# pf_check_npm — present, and major < 12 (preinstall.ts hard-rejects npm >= 12).
pf_check_npm() {
	if ! command -v npm >/dev/null 2>&1; then
		pf_fail "npm" "not found" "Comes with Node; reinstall Node (nvm install <ver>)"
		return
	fi
	local ver
	ver="$(npm --version 2>/dev/null || true)"
	if [ -z "$ver" ]; then
		pf_warn "npm" "present but version unreadable" "Ensure npm works: npm --version"
		return
	fi
	pf_semver_parts "$ver"
	if [ "$_PF_MAJ" -ge 12 ]; then
		pf_fail "npm" "v${ver} (upstream requires npm < 12.0.0)" \
			"Downgrade npm below 12 (e.g. use the npm bundled with the pinned Node)"
	else
		pf_pass "npm" "v${ver} (< 12) OK" ""
	fi
}

# pf_check_git — present.
pf_check_git() {
	if command -v git >/dev/null 2>&1; then
		pf_pass "git" "$(git --version 2>/dev/null || echo present)" ""
	else
		pf_fail "git" "not found" "Install git (mac: xcode-select --install; linux: apt-get install -y git)"
	fi
}

# pf_check_python MODE INSTALLCMD
# MODE = hard  -> missing / < 3.10 is a FAIL (macOS: create-dmg builds a dmgbuild venv)
#        warn  -> missing / < 3.10 is a WARN (linux/win: node-gyp uses it for natives)
# INSTALLCMD (optional) = OS-aware install command offered as an auto-fix.
pf_check_python() {
	local mode="${1:-warn}"
	local installcmd="${2:-}"
	local emit="pf_warn"
	[ "$mode" = "hard" ] && emit="pf_fail"
	local fixkind="" fixprompt=""
	if [ -n "$installcmd" ]; then
		fixkind="install"
		fixprompt="Install python3 >= 3.10 now? [y/N]"
	fi

	if ! command -v python3 >/dev/null 2>&1; then
		$emit "python3" "not found (>= 3.10 required)" \
			"Install python3 >= 3.10 (mac: ships with the Xcode CLT; linux: apt-get install -y python3)" \
			"$installcmd" "$fixkind" "$fixprompt"
		return
	fi
	local pyv
	pyv="$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || true)"
	if [ -z "$pyv" ]; then
		$emit "python3" "present but version unreadable" "Ensure python3 works: python3 --version"
		return
	fi
	pf_semver_parts "$pyv"
	if [ "$_PF_MAJ" -lt 3 ] || { [ "$_PF_MAJ" -eq 3 ] && [ "$_PF_MIN" -lt 10 ]; }; then
		$emit "python3" "v${pyv} (>= 3.10 required)" "Install/select python3 >= 3.10" \
			"$installcmd" "$fixkind" "$fixprompt"
	else
		pf_pass "python3" "v${pyv} (>= 3.10) OK" ""
	fi
}

# pf_check_disk DIR — build writes several GB. FAIL < 10 GB, WARN < 25 GB.
pf_check_disk() {
	local dir="$1"
	local kb
	# -P forces POSIX single-line output with fixed columns on macOS & Linux;
	# Available is field 4.
	kb="$(df -Pk "$dir" 2>/dev/null | awk 'NR==2 {print $4}')"
	case "$kb" in
		''|*[!0-9]*)
			pf_warn "Disk space" "could not determine free space" \
				"Ensure >= 25 GB free on the build volume (build writes several GB)"
			return ;;
	esac
	local gb
	gb="$(awk "BEGIN{printf \"%.1f\", ${kb}/1024/1024}" 2>/dev/null || echo "?")"
	if [ "$kb" -lt 10485760 ]; then          # < 10 GB
		pf_fail "Disk space" "${gb} GB free (need >= 10 GB, 25+ recommended)" \
			"Free up disk space before building — the build writes several GB"
	elif [ "$kb" -lt 26214400 ]; then        # < 25 GB
		pf_warn "Disk space" "${gb} GB free (low; 25+ GB recommended)" \
			"Consider freeing space — the build writes several GB"
	else
		pf_pass "Disk space" "${gb} GB free" ""
	fi
}

# pf_check_repo REPO_ROOT
#   upstream/          -> WARN if missing (fetch-vscode.sh will create it)
#   scripts/prepare.sh -> FAIL if missing (committed; nothing downstream restores it)
pf_check_repo() {
	local repo_root="$1"
	if [ -d "${repo_root}/upstream" ]; then
		pf_pass "upstream/ tree" "present" ""
	else
		pf_warn "upstream/ tree" "missing" "Will be fetched by scripts/fetch-vscode.sh during the build"
	fi
	if [ -f "${repo_root}/scripts/prepare.sh" ]; then
		pf_pass "scripts/prepare.sh" "present" ""
	else
		pf_fail "scripts/prepare.sh" "missing" "Repo is incomplete — re-clone; the overlay step needs it"
	fi
}

# pf_check_toolchain_macos — Xcode Command Line Tools. `xcode-select --install`
# pops the OS GUI installer, so it is offered as a GUIDED fix, not a silent one.
pf_check_toolchain_macos() {
	local clt
	if clt="$(xcode-select -p 2>/dev/null)" && [ -n "$clt" ]; then
		pf_pass "Xcode CLT" "$clt" ""
	else
		pf_fail "Xcode CLT" "not found" "Run: xcode-select --install" \
			"xcode-select --install" "guided" \
			"Trigger the macOS Command Line Tools installer now? (opens Apple's GUI installer — NOT a silent install) [y/N]"
	fi
}

# pf_check_toolchain_linux — dpkg-deb + fakeroot (hard, apt/dnf auto-fix);
# native build deps (warn).
pf_check_toolchain_linux() {
	local apt=""
	command -v apt-get >/dev/null 2>&1 && apt="apt-get"
	if command -v dpkg-deb >/dev/null 2>&1; then
		pf_pass "dpkg-deb" "$(command -v dpkg-deb)" ""
	else
		if [ -n "$apt" ]; then
			pf_fail "dpkg-deb" "not found" "sudo apt-get install -y dpkg-dev" \
				"sudo apt-get install -y dpkg-dev" "install" \
				"Install dpkg-deb now via apt (needs sudo)? [y/N]"
		else
			pf_fail "dpkg-deb" "not found" "Install the dpkg toolchain (dnf: sudo dnf install -y dpkg)"
		fi
	fi
	if command -v fakeroot >/dev/null 2>&1; then
		pf_pass "fakeroot" "$(command -v fakeroot)" ""
	else
		if [ -n "$apt" ]; then
			pf_fail "fakeroot" "not found" "sudo apt-get install -y fakeroot" \
				"sudo apt-get install -y fakeroot" "install" \
				"Install fakeroot now via apt (needs sudo)? [y/N]"
		else
			pf_fail "fakeroot" "not found" "Install fakeroot (dnf: sudo dnf install -y fakeroot)"
		fi
	fi
	# Native module compile deps — WARN only (a --check preflight can run without
	# them; the build itself needs them). Mirrors build.yml:68-69.
	local missing=""
	local pc
	for pc in x11 xkbfile libsecret-1 krb5; do
		if command -v pkg-config >/dev/null 2>&1 && ! pkg-config --exists "$pc" 2>/dev/null; then
			missing="${missing} ${pc}"
		fi
	done
	command -v g++ >/dev/null 2>&1 || missing="${missing} g++"
	if [ -n "$missing" ]; then
		pf_warn "Linux build deps" "possibly missing:${missing}" \
			"sudo apt-get install -y build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev fakeroot rpm dpkg-dev"
	else
		pf_pass "Linux build deps" "build-essential/g++ + X11/xkbfile/secret/krb5 present" ""
	fi
}

# ---------------------------------------------------------------------------
# Summary. Prints the aligned table; returns 0 if no FAIL, 1 otherwise.
# ---------------------------------------------------------------------------
pf_summarize() {
	printf '\n\033[1m  Requirements gate\033[0m\n'
	printf '  %-6s %-22s %s\n' "STATUS" "CHECK" "DETAIL"
	printf '  %-6s %-22s %s\n' "------" "----------------------" "-----------------------------------"
	local i=0
	while [ "$i" -lt "${#PF_ROWS[@]}" ]; do
		pf_split_row "${PF_ROWS[$i]}"
		local color="0;32"   # green
		case "$_PF_ST" in
			FAIL) color="1;31" ;;   # red
			WARN) color="1;33" ;;   # yellow
		esac
		printf '  \033[%sm%-6s\033[0m %-22s %s\n' "$color" "$_PF_ST" "$_PF_NM" "$_PF_DT"
		if [ "$_PF_ST" != "PASS" ] && [ -n "$_PF_RM" ]; then
			printf '         \033[2m-> %s\033[0m\n' "$_PF_RM"
		fi
		i=$((i + 1))
	done
	printf '\n  %d passed, \033[1;33m%d warning(s)\033[0m, \033[1;31m%d failure(s)\033[0m\n' \
		"$(( ${#PF_ROWS[@]} - PF_FAIL - PF_WARN ))" "$PF_WARN" "$PF_FAIL"
	[ "$PF_FAIL" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Interactive, opt-in, OS-aware auto-fix.
#   Only called for the interactive path. For every FAIL/WARN row that carries a
#   FIXCMD it prints the prompt, SHOWS THE EXACT COMMAND, and runs it only on an
#   explicit "y"/"yes". Sets:
#     PF_DID_INSTALL=1  if a same-shell install ran (caller should re-run gate)
#     PF_RERUN_SHELL=1  if a fresh-shell fix ran (caller should ask user to re-run)
# ---------------------------------------------------------------------------
pf_offer_fixes() {
	PF_DID_INSTALL=0
	PF_RERUN_SHELL=0
	local any=0 i=0
	while [ "$i" -lt "${#PF_ROWS[@]}" ]; do
		pf_split_row "${PF_ROWS[$i]}"
		i=$((i + 1))
		{ [ "$_PF_ST" = "FAIL" ] || [ "$_PF_ST" = "WARN" ]; } || continue
		[ -n "$_PF_FC" ] || continue
		any=1
		printf '\n\033[1m  Fixable: %s\033[0m\n' "$_PF_NM"
		local prompt="$_PF_FP"
		[ -n "$prompt" ] || prompt="Attempt to fix ${_PF_NM} now? [y/N]"
		case "$_PF_FK" in
			guided) printf '    (guided — this opens an OS installer, it is NOT a silent auto-install)\n' ;;
			shell)  printf '    (real install; nvm applies to a NEW shell — you will be asked to re-run afterwards)\n' ;;
		esac
		printf '    Command to run: \033[36m%s\033[0m\n' "$_PF_FC"
		printf '    %s ' "$prompt"
		# We only get here on the interactive path, where the caller has already
		# confirmed stdin is a TTY ([ -t 0 ]); read the answer straight from it.
		local ans=""
		read -r ans || ans=""
		case "$ans" in
			y|Y|yes|YES|Yes)
				printf '    Running: %s\n' "$_PF_FC"
				if bash -c "$_PF_FC"; then
					printf '\033[32m    done.\033[0m\n'
					case "$_PF_FK" in
						shell)  PF_RERUN_SHELL=1 ;;
						guided) : ;;   # cannot assume it completed (GUI / async)
						*)      PF_DID_INSTALL=1 ;;
					esac
				else
					printf '\033[1;31m    fix command failed — resolve it manually (see remediation above).\033[0m\n'
				fi
				;;
			*)
				printf '    skipped.\n'
				;;
		esac
	done
	[ "$any" -eq 1 ] || printf '\n  (no auto-fixable items — resolve the FAIL items above manually)\n'
}

# ---------------------------------------------------------------------------
# Orchestrator: run gate, summarize, optionally offer fixes, re-run once.
#   pf_preflight_main GATE_FN INTERACTIVE
#     GATE_FN     — name of a function that runs all pf_check_* for this OS.
#     INTERACTIVE — 1 to allow prompts, 0 to report-only (check/CI/no-TTY).
#   Returns 0 if the gate ultimately passes (no FAIL). On failure sets:
#     PF_RERUN_SHELL=1  — a fresh-shell fix ran; caller should tell user to re-run.
# ---------------------------------------------------------------------------
pf_preflight_main() {
	local gate_fn="$1" interactive="$2"
	PF_RERUN_SHELL=0
	pf_reset; "$gate_fn"
	if pf_summarize; then
		return 0
	fi
	if [ "$interactive" != "1" ]; then
		return 1
	fi
	pf_offer_fixes
	if [ "${PF_RERUN_SHELL:-0}" = "1" ]; then
		return 1
	fi
	if [ "${PF_DID_INSTALL:-0}" = "1" ]; then
		printf '\n  Re-running requirements gate after fixes...\n'
		pf_reset; "$gate_fn"
		if pf_summarize; then
			return 0
		fi
	fi
	return 1
}
