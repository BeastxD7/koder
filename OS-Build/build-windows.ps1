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
  Requirements gate only; print the command sequence and skip the heavy build.
  Implies -NonInteractive (never prompts / installs).

.PARAMETER NonInteractive
  Never prompt for auto-fixes; just report the todo list and fail. Auto-enabled
  under CI or when input is redirected (so CI never hangs on a prompt).

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
	[switch]$Check,
	[switch]$NonInteractive
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
# Requirements gate — mirrors OS-Build/lib-preflight.sh (the bash builds) with
# the SAME collect-all model, the SAME exact preinstall.ts Node check, and the
# SAME opt-in interactive auto-fix. Re-implemented here because PowerShell can't
# source the bash helper. NOTE: this .ps1 was NOT run live (no pwsh on the build
# machine) — it is kept conservative / Windows PowerShell 5.1 compatible.
# ----------------------------------------------------------------------------
$script:PfRows = New-Object System.Collections.ArrayList
$script:PfFail = 0
$script:PfWarn = 0

function Add-PfResult($status, $name, $detail, $remediation, $fixCmd, $fixKind, $fixPrompt) {
	[void]$script:PfRows.Add([pscustomobject]@{
		Status = $status; Name = $name; Detail = $detail; Remediation = $remediation
		FixCmd = $fixCmd; FixKind = $fixKind; FixPrompt = $fixPrompt
	})
	if ($status -eq 'FAIL') { $script:PfFail++ }
	elseif ($status -eq 'WARN') { $script:PfWarn++ }
}
function Pf-Pass($n, $d) { Add-PfResult 'PASS' $n $d '' '' '' '' }
function Pf-Warn($n, $d, $r, $fc, $fk, $fp) { Add-PfResult 'WARN' $n $d $r $fc $fk $fp }
function Pf-Fail($n, $d, $r, $fc, $fk, $fp) { Add-PfResult 'FAIL' $n $d $r $fc $fk $fp }

# Parse "MAJOR.MINOR.PATCH..." into an int[3]; non-numeric parts -> 0.
function Get-SemverParts($v) {
	if (-not $v) { return @(0, 0, 0) }
	$v = ($v -replace '^v', '') -replace '-.*$', ''
	$p = $v.Split('.')
	$out = @(0, 0, 0)
	for ($i = 0; $i -lt 3 -and $i -lt $p.Count; $i++) {
		$n = 0
		if ([int]::TryParse($p[$i], [ref]$n)) { $out[$i] = $n }
	}
	return $out
}

function Check-Node {
	$nvmrc = Join-Path $RepoRoot 'upstream\.nvmrc'
	$req = '24.17.0'
	if (Test-Path $nvmrc) {
		$parsed = ((Get-Content $nvmrc -Raw).Trim() -replace '^v', '')
		if ($parsed) { $req = $parsed }
	}
	$r = Get-SemverParts $req
	# OS-aware auto-fix: nvm-windows if present (fresh shell), else guided winget/choco.
	$fixCmd = ''; $fixKind = ''; $fixPrompt = ''
	if (Get-Command nvm -ErrorAction SilentlyContinue) {
		$fixCmd = "nvm install $req; nvm use $req"
		$fixKind = 'shell'
		$fixPrompt = "Install Node v$req now via nvm-windows? (applies to a new shell) [y/N]"
	} else {
		# Keep FixCmd runnable (Invoke-Expression executes it verbatim on "y").
		# The choco alternative lives in the remediation text, not the command.
		$fixCmd = "winget install OpenJS.NodeJS.$($r[0])"
		$fixKind = 'guided'
		$fixPrompt = "Install Node v$req now via winget? (guided — you may need a new shell / admin) [y/N]"
	}
	$nodeRem = "Install Node v$req, major $($r[0]) (winget install OpenJS.NodeJS.$($r[0])  or  choco install nodejs --version $req)"
	$node = Get-Command node -ErrorAction SilentlyContinue
	if (-not $node) {
		Pf-Fail 'Node.js' "not found (required v$req)" $nodeRem $fixCmd $fixKind $fixPrompt
		return
	}
	$cur = (& node -p 'process.versions.node' 2>$null)
	if ($cur) { $cur = "$cur".Trim() }
	if (-not $cur) {
		Pf-Fail 'Node.js' "installed but version unreadable (required v$req)" $nodeRem $fixCmd $fixKind $fixPrompt
		return
	}
	$c = Get-SemverParts $cur
	# Exact preinstall.ts condition: FAIL if major != req OR minor < req OR (minor == req AND patch < req).
	if (($c[0] -ne $r[0]) -or ($c[1] -lt $r[1]) -or (($c[1] -eq $r[1]) -and ($c[2] -lt $r[2]))) {
		Pf-Fail 'Node.js' "v$cur installed, need v$req (same major $($r[0]), >= $req)" `
			"nvm install $req && nvm use $req (or install Node >= v$req, major $($r[0]))" $fixCmd $fixKind $fixPrompt
	} else {
		Pf-Pass 'Node.js' "v$cur (>= v$req, major $($r[0])) OK"
	}
}

function Check-Npm {
	if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
		Pf-Fail 'npm' 'not found' 'Comes with Node; reinstall Node' '' '' ''
		return
	}
	$ver = (& npm --version 2>$null)
	if ($ver) { $ver = "$ver".Trim() }
	if (-not $ver) { Pf-Warn 'npm' 'present but version unreadable' 'Ensure npm works: npm --version' '' '' ''; return }
	$p = Get-SemverParts $ver
	if ($p[0] -ge 12) {
		Pf-Fail 'npm' "v$ver (upstream requires npm < 12.0.0)" 'Downgrade npm below 12 (use the npm bundled with the pinned Node)' '' '' ''
	} else {
		Pf-Pass 'npm' "v$ver (< 12) OK"
	}
}

function Check-Git {
	if (Get-Command git -ErrorAction SilentlyContinue) {
		Pf-Pass 'git' ((& git --version 2>$null) -join ' ')
	} else {
		Pf-Fail 'git' 'not found' 'Install Git for Windows (https://git-scm.com)' '' '' ''
	}
}

function Check-Bash {
	$bash = Get-Command bash -ErrorAction SilentlyContinue
	if ($bash) {
		Pf-Pass 'bash (Git Bash)' $bash.Source
	} else {
		Pf-Fail 'bash (Git Bash)' 'not found on PATH' 'Install Git for Windows — the prepare step is a bash script' `
			'winget install Git.Git' 'guided' 'Install Git for Windows now via winget? (guided) [y/N]'
	}
}

function Check-Python {
	$py = Get-Command python3 -ErrorAction SilentlyContinue
	if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
	$fixCmd = 'winget install Python.Python.3.12'; $fixKind = 'guided'; $fixPrompt = 'Install Python 3.12 now via winget? (guided) [y/N]'
	if (-not $py) {
		Pf-Warn 'python3' 'not found (node-gyp uses it for native modules)' 'Install python3 >= 3.10' $fixCmd $fixKind $fixPrompt
		return
	}
	$pv = (& $py.Source -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>$null)
	if ($pv) { $pv = "$pv".Trim() }
	if (-not $pv) { Pf-Warn 'python3' 'present but version unreadable' 'Ensure python works' '' '' ''; return }
	$p = Get-SemverParts $pv
	if (($p[0] -lt 3) -or (($p[0] -eq 3) -and ($p[1] -lt 10))) {
		Pf-Warn 'python3' "v$pv (>= 3.10 recommended)" 'Install/select python3 >= 3.10' $fixCmd $fixKind $fixPrompt
	} else {
		Pf-Pass 'python3' "v$pv (>= 3.10) OK"
	}
}

# MSVC is a HARD requirement: preinstall.ts throws on win32 without a supported
# Visual Studio (2022/2019). Cannot be reliably silent-installed -> guided fix.
function Check-Msvc {
	$hasCl = Get-Command cl.exe -ErrorAction SilentlyContinue
	$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
	$vsPath = $null
	if (Test-Path $vswhere) {
		$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
	}
	if ($hasCl) {
		Pf-Pass 'MSVC toolchain' "cl.exe: $($hasCl.Source)"
	} elseif ($vsPath) {
		Pf-Pass 'MSVC toolchain' "VS Build Tools: $vsPath"
	} else {
		Pf-Fail 'MSVC toolchain' 'not detected (VS Build Tools / "Desktop development with C++")' `
			'Install VS Build Tools with the C++ workload (preinstall.ts hard-requires VS 2022/2019)' `
			'winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' `
			'guided' 'Install VS Build Tools (C++) now via winget? (guided — large download, may need admin) [y/N]'
	}
}

# Inno Setup ships as the `innosetup` npm devDependency (installed by upstream
# `npm ci`) — no separate system install is required. Reported as info only.
function Check-InnoSetup {
	Pf-Pass 'Inno Setup' 'provided by npm ci (innosetup devDependency) — no system install needed'
}

function Check-Disk {
	$free = $null
	try {
		$qual = (Split-Path -Qualifier $RepoRoot).TrimEnd(':')
		$drive = Get-PSDrive -Name $qual -ErrorAction SilentlyContinue
		if ($drive -and ($drive.Free -ne $null)) { $free = [double]$drive.Free }
	} catch { $free = $null }
	if ($null -eq $free) {
		Pf-Warn 'Disk space' 'could not determine free space' 'Ensure >= 25 GB free on the build volume' '' '' ''
		return
	}
	$gb = [math]::Round($free / 1GB, 1)
	if ($free -lt 10GB) {
		Pf-Fail 'Disk space' "$gb GB free (need >= 10 GB, 25+ recommended)" 'Free up disk space — the build writes several GB' '' '' ''
	} elseif ($free -lt 25GB) {
		Pf-Warn 'Disk space' "$gb GB free (low; 25+ GB recommended)" 'Consider freeing space — the build writes several GB' '' '' ''
	} else {
		Pf-Pass 'Disk space' "$gb GB free"
	}
}

function Check-Repo {
	if (Test-Path (Join-Path $RepoRoot 'upstream')) {
		Pf-Pass 'upstream/ tree' 'present'
	} else {
		Pf-Warn 'upstream/ tree' 'missing' 'Will be fetched by scripts/fetch-vscode.sh during the build' '' '' ''
	}
	if (Test-Path (Join-Path $RepoRoot 'scripts\prepare.sh')) {
		Pf-Pass 'scripts/prepare.sh' 'present'
	} else {
		Pf-Fail 'scripts/prepare.sh' 'missing' 'Repo is incomplete — re-clone; the overlay step needs it' '' '' ''
	}
}

function Invoke-WindowsGate {
	Check-Node
	Check-Npm
	Check-Git
	Check-Bash
	Check-Python
	Check-Msvc
	Check-InnoSetup
	Check-Disk
	Check-Repo
}

function Show-PfSummary {
	Write-Host "`n  Requirements gate" -ForegroundColor White
	Write-Host ("  {0,-6} {1,-22} {2}" -f 'STATUS', 'CHECK', 'DETAIL')
	Write-Host ("  {0,-6} {1,-22} {2}" -f '------', '----------------------', '-----------------------------------')
	foreach ($row in $script:PfRows) {
		$color = 'Green'
		if ($row.Status -eq 'FAIL') { $color = 'Red' } elseif ($row.Status -eq 'WARN') { $color = 'Yellow' }
		Write-Host ("  {0,-6}" -f $row.Status) -ForegroundColor $color -NoNewline
		Write-Host (" {0,-22} {1}" -f $row.Name, $row.Detail)
		if ($row.Status -ne 'PASS' -and $row.Remediation) {
			Write-Host ("         -> {0}" -f $row.Remediation) -ForegroundColor DarkGray
		}
	}
	$passed = $script:PfRows.Count - $script:PfFail - $script:PfWarn
	Write-Host ("`n  {0} passed, {1} warning(s), {2} failure(s)" -f $passed, $script:PfWarn, $script:PfFail)
	return ($script:PfFail -eq 0)
}

# Opt-in, interactive, OS-aware auto-fix. Shows the EXACT command; runs only on
# an explicit "y". Sets $script:PfDidInstall / $script:PfRerunShell.
function Invoke-PfFixes {
	$script:PfDidInstall = $false
	$script:PfRerunShell = $false
	$any = $false
	foreach ($row in $script:PfRows) {
		if (($row.Status -ne 'FAIL') -and ($row.Status -ne 'WARN')) { continue }
		if (-not $row.FixCmd) { continue }
		$any = $true
		Write-Host "`n  Fixable: $($row.Name)" -ForegroundColor White
		switch ($row.FixKind) {
			'guided' { Write-Host '    (guided — opens/uses an installer; NOT a silent auto-install)' }
			'shell'  { Write-Host '    (real install; nvm applies to a NEW shell — you will be asked to re-run afterwards)' }
		}
		Write-Host "    Command to run: $($row.FixCmd)" -ForegroundColor Cyan
		$prompt = $row.FixPrompt
		if (-not $prompt) { $prompt = "Attempt to fix $($row.Name) now? [y/N]" }
		$ans = Read-Host "    $prompt"
		if ($ans -match '^(y|Y|yes|YES|Yes)$') {
			Write-Host "    Running: $($row.FixCmd)"
			try {
				Invoke-Expression $row.FixCmd
				Write-Host '    done.' -ForegroundColor Green
				if ($row.FixKind -eq 'shell') { $script:PfRerunShell = $true }
				elseif ($row.FixKind -ne 'guided') { $script:PfDidInstall = $true }
			} catch {
				Write-Host "    fix command failed — resolve it manually (see remediation above)." -ForegroundColor Red
			}
		} else {
			Write-Host '    skipped.'
		}
	}
	if (-not $any) { Write-Host "`n  (no auto-fixable items — resolve the FAIL items above manually)" }
}

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------
Write-Phase 'Preflight checks'

# Guard on $env:OS only — $IsWindows does not exist on Windows PowerShell 5.1
# (the shell `powershell.exe` launches), and StrictMode would throw on it.
if ($env:OS -ne 'Windows_NT') {
	Die 'This script only runs on Windows. Use OS-Build/build-macos.sh or build-linux.sh.'
}

# Interactive only when it makes sense: not -Check, not -NonInteractive, not CI,
# and input not redirected (so CI / piped runs never hang on a prompt).
$Interactive = $true
if ($Check) { $Interactive = $false }
if ($NonInteractive) { $Interactive = $false }
if ($env:CI) { $Interactive = $false }
try { if ([Console]::IsInputRedirected) { $Interactive = $false } } catch { }

$script:PfRerunShell = $false
Invoke-WindowsGate
$gateOk = Show-PfSummary
if (-not $gateOk) {
	if ($Interactive) {
		Invoke-PfFixes
		if ($script:PfRerunShell) {
			$reArg = ''
			if ($Check) { $reArg = '-Check' }
			Write-Host "`nA fix was installed that needs a fresh shell (nvm)." -ForegroundColor Yellow
			Write-Host "Open a new terminal and re-run: OS-Build\build-windows.ps1 $reArg"
			exit 1
		}
		if ($script:PfDidInstall) {
			Write-Host "`n  Re-running requirements gate after fixes..."
			$script:PfRows = New-Object System.Collections.ArrayList
			$script:PfFail = 0; $script:PfWarn = 0
			Invoke-WindowsGate
			$gateOk = Show-PfSummary
		}
	}
}

# Real build: fail fast BEFORE printing the sequence / doing any heavy work.
# -Check still prints the full command sequence below (report-everything mode).
if ((-not $Check) -and (-not $gateOk)) {
	Write-Host "`nBuild cannot proceed. Fix the items marked FAIL above." -ForegroundColor Red
	exit 1
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
	if (-not $gateOk) {
		Write-Host "`nBuild cannot proceed. Fix the items marked FAIL above." -ForegroundColor Red
		exit 1
	}
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
