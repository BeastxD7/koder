# OS-Build — native per-OS installers for LakshX

One command per OS produces **a single distributable installer** for that OS.
These scripts faithfully mirror the CI pipeline in
[`.github/workflows/build.yml`](../.github/workflows/build.yml) (the source of
truth for how each platform is actually built) — they do not invent commands.

| OS      | Script                    | Output artifact          |
| ------- | ------------------------- | ------------------------ |
| macOS   | `build-macos.sh`          | `LakshX-macOS-<arch>.dmg`   |
| Windows | `build-windows.ps1`       | `LakshX-Windows-<arch>.exe` |
| Linux   | `build-linux.sh`          | `LakshX-Linux-<arch>.deb`   |

## Quick start

From the repo root, on the machine matching your target OS:

```bash
./build.sh            # detects your OS and builds its installer
./build.sh --check    # preflight + print the exact command sequence, no heavy build
```

`build.sh` dispatches to the right `OS-Build/` script. On Windows (Git Bash) it
invokes the PowerShell script for you, or you can run it directly:

```powershell
powershell -ExecutionPolicy Bypass -File OS-Build\build-windows.ps1
powershell -ExecutionPolicy Bypass -File OS-Build\build-windows.ps1 -Check
```

You can also run any per-OS script directly (each supports `--check` / `-Check`).

### Config (env overrides, sane defaults)

| Var              | Default (mac / win / linux) | Meaning       |
| ---------------- | --------------------------- | ------------- |
| `VSCODE_ARCH`    | `arm64` / `x64` / `x64`     | target arch   |
| `VSCODE_QUALITY` | `stable`                    | build quality |
| `GITHUB_TOKEN`   | _(unset)_                   | optional; avoids GitHub rate-limits during `npm ci` |

## What every build does (mirrors build.yml)

All three scripts run the same prep sequence before the platform-specific
packaging (skipped entirely under `--check`):

1. `scripts/fetch-vscode.sh` — shallow-clone pinned code-oss into `upstream/`.
2. `agent`: `npm ci && npm run bundle` — bundle the agent runtime.
3. `scripts/prepare.sh` — merge `product/product.overrides.json` into
   `upstream/product.json`, apply `patches/*.patch`, run `apply-ui.mjs` +
   `install-icons.mjs`.
4. `upstream`: `npm ci` with the CI's load-bearing env
   (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`,
   `NPM_CONFIG_AUDIT=false`, `NPM_CONFIG_FUND=false`). macOS additionally raises
   `ulimit -n/-u` — both fix the macOS-only "spawn /bin/sh ENOENT" crash.
5. `upstream`: `npm run gulp vscode-<target>-min` — the packaged build.

Then per platform:

- **macOS**: ad-hoc `codesign --force --deep -s -` the `.app`, then
  `node build/darwin/create-dmg.ts <repoRoot> <repoRoot>` (dmgbuild via a Python
  venv) → `.dmg`. _(CI itself only zips the `.app`; the DMG step comes from
  upstream's own Azure pipeline + this session's tested manual run.)_
- **Windows**: `gulp vscode-win32-x64-inno-updater` **then** (separately)
  `gulp vscode-win32-x64-system-setup` → Inno Setup `.exe`. Two invocations,
  never one command line (inno-updater populates `tools/` that system-setup's
  ISCC globs).
- **Linux**: `gulp vscode-linux-x64-prepare-deb` **then** (separately)
  `gulp vscode-linux-x64-build-deb` → `.deb` via `dpkg-deb`/`fakeroot`. Two
  invocations, never one — passing both on one command line is a real race.

## Prerequisites per OS

**Common:** Node **24** (see [`upstream/.nvmrc`](../upstream/.nvmrc), currently
`24.17.0`; any 24.x works), `git`, and network access.

**macOS** (`build-macos.sh`)

- Xcode Command Line Tools: `xcode-select --install`
- `python3` >= 3.10 (create-dmg builds a dmgbuild venv; without it, it tries to
  `brew install python@3.12`)

**Windows** (`build-windows.ps1`)

- **Git for Windows** — the prep step is a bash script, called via `bash`.
- **Visual Studio Build Tools** with the "Desktop development with C++"
  workload (MSVC toolchain for native modules). Inno Setup itself is pulled in
  by `npm ci` (the `innosetup` devDependency) — no separate install.

**Linux** (`build-linux.sh`) — Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y build-essential g++ libx11-dev libxkbfile-dev \
  libsecret-1-dev libkrb5-dev fakeroot rpm dpkg-dev
```

## Signing / notarization caveats (these hit real users)

These scripts produce **installable but not distribution-signed** artifacts.
Signing/notarization is deliberately **not** implemented here — document only:

- **macOS — Gatekeeper "damaged" on download.** The `.app` is only *ad-hoc*
  signed (`-s -`), not Developer ID signed + notarized. A user who downloads
  the `.dmg` will see **"LakshX is damaged and can't be opened."** Workaround
  (user side): `xattr -cr /Applications/LakshX.app`. Proper fix: a Developer ID
  Application certificate, `codesign` with it, then `xcrun notarytool submit`
  + `xcrun stapler staple`.
- **Windows — SmartScreen on unsigned `.exe`.** The installer is unsigned, so
  Windows Defender SmartScreen shows **"Windows protected your PC."** Users
  click *More info → Run anyway*. Proper fix: an Authenticode (ideally EV)
  code-signing certificate applied to the `.exe`.
- **Linux — none.** The `.deb` needs no signing to install
  (`sudo apt install ./LakshX-Linux-x64.deb`).

## What was verified

- `bash -n` syntax-checked: `build.sh`, `build-macos.sh`, `build-linux.sh`.
- `build.sh --check` run live on macOS (dispatch + preflight + printed command
  sequence). The full end-to-end build was **not** run (time/disk); its
  correctness rests on faithfully mirroring `build.yml`, which is the proof the
  underlying commands work.
- `build-windows.ps1` was **not** syntax-checked (no `pwsh` on the build
  machine); it uses conservative, standard PowerShell only.
