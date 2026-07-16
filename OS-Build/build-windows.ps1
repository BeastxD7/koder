<#
.SYNOPSIS
  Build a single distributable LakshX .exe installer for Windows (x64).

.DESCRIPTION
  Mirrors the real CI pipeline (.github/workflows/build.yml) for the win32-x64
  target. The prep phase (fetch-vscode / agent bundle / prepare.sh) is written
  in bash, so this script calls those through Git Bash (`bash`) — the same
  tested code path CI uses. Git Bash MUST be installed and on PATH.

  The installer is produced by Inno Setup via the `innosetup` npm devDependency
  (installed by upstream `npm ci`) — no extra tooling on the machine.
  The two gulp tasks (inno-updater, then system-setup) MUST run as SEPARATE
  invocations (build.yml:236-242).

.PARAMETER Check
  Preflight + print the command sequence only; skip the heavy build.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File OS-Build\build-windows.ps1
  powershell -ExecutionPolicy Bypass -File OS-Build\build-windows.ps1 -Check

.NOTES
  Env overrides (sane defaults):
    VSCODE_ARCH=x64        target arch
    VSCODE_QUALITY=stable  build quality
    GITHUB_TOKEN=...        (optional) avoids GitHub rate-limits during npm ci
#>
[CmdletBinding()]
param(
	[switch]$Check
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --- locate repo root from this script's own location (never hardcode paths) --
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir '..')).Path

if (-not $env:VSCODE_ARCH)    { $env:VSCODE_ARCH = 'x64' }
if (-not $env:VSCODE_QUALITY) { $env:VSCODE_QUALITY = 'stable' }
$Arch    = $env:VSCODE_ARCH
$Quality = $env:VSCODE_QUALITY

$Target   = "win32-$Arch"
$Artifact = "LakshX-Windows-$Arch"
$SetupExe = Join-Path $RepoRoot "upstream\.build\$Target\system-setup\VSCodeSetup.exe"
$ExeOut   = Join-Path $RepoRoot "$Artifact.exe"

function Write-Phase($msg) { Write-Host "`n==> [Windows] $msg" -ForegroundColor Cyan }
function Write-Info($msg)  { Write-Host "    $msg" }
function Die($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------
Write-Phase 'Preflight checks'

# Guard on $env:OS only — $IsWindows does not exist on Windows PowerShell 5.1
# (the shell `powershell.exe` launches), and StrictMode would throw on it.
if ($env:OS -ne 'Windows_NT') {
	Die 'This script only runs on Windows. Use OS-Build/build-macos.sh or build-linux.sh.'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die 'node not found. Install Node 24 (see upstream/.nvmrc).' }
$nodeMajor = (& node -p 'process.versions.node.split(".")[0]').Trim()
$wantMajor = '24'
$nvmrc = Join-Path $RepoRoot 'upstream\.nvmrc'
if (Test-Path $nvmrc) { $wantMajor = ((Get-Content $nvmrc -Raw).Trim() -replace '^v','').Split('.')[0] }
if ($nodeMajor -ne $wantMajor) { Die "Node major $wantMajor required (found $(& node --version))." }
Write-Info "node $(& node --version) (major $nodeMajor) OK"

$bash = Get-Command bash -ErrorAction SilentlyContinue
if (-not $bash) { Die 'Git Bash (bash) not found on PATH. Install Git for Windows — the prepare step is a bash script.' }
Write-Info "bash: $($bash.Source)"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'git not found.' }

# Native modules need the MSVC toolchain (VS Build Tools / "Desktop development
# with C++"). Probe for cl.exe or a VS install; warn rather than hard-fail so a
# preflight can run before the toolchain is on PATH.
$hasCl = Get-Command cl.exe -ErrorAction SilentlyContinue
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$hasVs = $false
if (Test-Path $vswhere) {
	$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
	if ($vsPath) { $hasVs = $true; Write-Info "VS Build Tools: $vsPath" }
}
if (-not $hasCl -and -not $hasVs) {
	Write-Info 'WARNING: MSVC toolchain not detected. Install "Visual Studio Build Tools" with the'
	Write-Info '         "Desktop development with C++" workload before building native modules.'
} elseif ($hasCl) {
	Write-Info "cl.exe: $($hasCl.Source)"
}

Write-Info "Target:  $Target"
Write-Info "Quality: $Quality"
Write-Info "Output:  $ExeOut"

# ----------------------------------------------------------------------------
# Command sequence
# ----------------------------------------------------------------------------
Write-Host @"

Command sequence (mirrors .github/workflows/build.yml win32-x64):
  1. bash ./scripts/fetch-vscode.sh                   # build.yml:73
  2. bash -c 'cd agent && npm ci && npm run bundle'   # build.yml:76-80
  3. bash ./scripts/prepare.sh                         # build.yml:84
  4. (in upstream) npm ci                              # build.yml:90-130
        env: ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
             NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false [GITHUB_TOKEN]
  5. (in upstream) npm run gulp vscode-$Target-min      # build.yml:135
  6. (in upstream) npm run gulp vscode-win32-$Arch-inno-updater   # build.yml:241
  7. (in upstream) npm run gulp vscode-win32-$Arch-system-setup   # build.yml:242
        # steps 6 & 7 MUST be separate invocations — inno-updater populates
        # tools/ that system-setup's ISCC globs (build.yml:211-235)
  8. Copy .build\$Target\system-setup\VSCodeSetup.exe -> $Artifact.exe  # build.yml:251
"@

if ($Check) {
	Write-Phase '-Check: preflight passed, skipping the heavy build'
	Write-Host "OK: would build $ExeOut"
	exit 0
}

Set-Location $RepoRoot

# Prep phase via Git Bash (the tested code path).
Write-Phase '1/8 Fetch pinned code-oss (bash scripts/fetch-vscode.sh)'
& bash ./scripts/fetch-vscode.sh
if ($LASTEXITCODE -ne 0) { Die 'fetch-vscode.sh failed.' }

Write-Phase '2/8 Bundle agent runtime (bash: agent npm ci && npm run bundle)'
& bash -c 'cd agent && npm ci && npm run bundle'
if ($LASTEXITCODE -ne 0) { Die 'agent bundle failed.' }

Write-Phase '3/8 Apply LakshX overlay (bash scripts/prepare.sh)'
& bash ./scripts/prepare.sh
if ($LASTEXITCODE -ne 0) { Die 'prepare.sh failed.' }

Write-Phase '4/8 Install upstream dependencies (upstream: npm ci)'
Push-Location (Join-Path $RepoRoot 'upstream')
try {
	$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
	$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
	$env:NPM_CONFIG_AUDIT = 'false'
	$env:NPM_CONFIG_FUND = 'false'
	& npm ci
	if ($LASTEXITCODE -ne 0) { Die 'upstream npm ci failed.' }

	Write-Phase "5/8 Package (upstream: npm run gulp vscode-$Target-min)"
	& npm run gulp "vscode-$Target-min"
	if ($LASTEXITCODE -ne 0) { Die 'gulp min build failed.' }

	# 6 + 7: two SEPARATE invocations (build.yml:236-242).
	Write-Phase "6/8 Populate tools/ (gulp vscode-win32-$Arch-inno-updater)"
	& npm run gulp "vscode-win32-$Arch-inno-updater"
	if ($LASTEXITCODE -ne 0) { Die 'inno-updater task failed.' }

	Write-Phase "7/8 Build installer (gulp vscode-win32-$Arch-system-setup)"
	& npm run gulp "vscode-win32-$Arch-system-setup"
	if ($LASTEXITCODE -ne 0) { Die 'system-setup task failed.' }
}
finally {
	Pop-Location
}

# 8: collect the single artifact.
Write-Phase '8/8 Finalize artifact'
if (-not (Test-Path $SetupExe)) { Die "Installer not found at $SetupExe" }
Copy-Item -Force $SetupExe $ExeOut

Write-Host "`n[OK] Built single distributable: $ExeOut" -ForegroundColor Green
Write-Host ''
Write-Host 'NOTE: This installer is UNSIGNED. Downloaded copies trigger Windows'
Write-Host '      SmartScreen ("Windows protected your PC" -> More info -> Run anyway).'
Write-Host '      Real distribution requires an Authenticode code-signing certificate'
Write-Host '      (not implemented here — see OS-Build/README.md).'
