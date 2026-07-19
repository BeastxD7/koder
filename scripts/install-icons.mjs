// Installs LakshX icons into upstream resources for whichever platforms the
// assets exist for. Called from prepare.sh — cross-platform (pure Node).
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = join(root, "upstream");
const assets = join(root, "assets");

const installs = [
  ["lakshx.icns", "resources/darwin/code.icns"],
  ["lakshx.ico", "resources/win32/code.ico"],
  ["lakshx-512.png", "resources/linux/code.png"],
  // Web/remote-access surface (the QR-code remote-access feature serves this
  // over HTTP) — resources/server/favicon.ico, wired into <link rel="icon">
  // by src/vs/code/browser/workbench/workbench{,-dev}.html and copied into
  // the web/reh builds by build/gulpfile.vscode.web.ts +
  // build/gulpfile.reh.ts. Reusing lakshx.ico is fine: it already carries a
  // 16x16/24x24 (down to smaller) size set, a superset of what a favicon
  // needs, and browsers pick the closest match from a multi-size .ico.
  ["lakshx.ico", "resources/server/favicon.ico"],
];
for (const [asset, dest] of installs) {
  const src = join(assets, asset);
  const dst = join(upstream, dest);
  if (existsSync(src) && existsSync(dirname(dst))) {
    copyFileSync(src, dst);
    console.log(`icon: ${asset} → ${dest}`);
  }
}

// The in-workbench app icon (SVG, not the native .icns/.ico/.png above) —
// vs/workbench/browser/parts/titlebar/media/titlebarpart.css's
// `.window-appicon` (the widget rendered top-left of the CUSTOM title bar on
// Windows/Linux, i.e. window.titleBarStyle !== 'native') points at
// vs/workbench/browser/media/code-icon.svg. Stock VS Code ships that file as
// a plain blue "pages" glyph and relies on Microsoft's internal vscode-distro
// pipeline to overlay it with the quality-branded icon at build time (see
// vs/sessions/browser/media/openInVSCode.css's comments for confirmation of
// that mechanism) — this fork doesn't run vscode-distro, so the file was
// never overlaid and the stock blue icon leaked through. The same file is
// also reused (without any distro step) by the update-available tooltip,
// the onboarding page, the Getting Started walkthrough, the generic
// walkthrough part, and the banner part, so this one swap fixes all of them
// at once. Source is assets/icon.svg directly (same 1024x1024 viewBox as the
// file it replaces, self-contained, no external refs) — no compositing
// needed since it's a vector swap, unlike the Inno Setup bitmaps.
const codeIconTargets = [
  "src/vs/workbench/browser/media/code-icon.svg",
  // Also refresh out/, if a previous compile already populated it, so a dev
  // session doesn't need a full rebuild to see the fix (same reasoning as
  // apply-ui.mjs's letterpress src+out dual write).
  "out/vs/workbench/browser/media/code-icon.svg",
];
for (const dest of codeIconTargets) {
  const src = join(assets, "icon.svg");
  const dst = join(upstream, dest);
  if (existsSync(src) && existsSync(dirname(dst))) {
    copyFileSync(src, dst);
    console.log(`icon: icon.svg → ${dest}`);
  }
}

// Inno Setup wizard imagery (the big page-side image + small corner icon
// shown during Windows install, at 7 DPI scales each) is a SEPARATE asset
// pair from code.ico above — code.iss references resources/win32/inno-
// {big,small}-<scale>.bmp directly (see build/win32/code.iss's
// WizardImageFile/WizardSmallImageFile), and code.ico only covers the
// installer .exe's own file icon, not what the wizard UI itself displays.
// Without this, the wizard silently falls back to Microsoft's stock VS Code
// wizard bitmaps — exactly the bug this closes (real report: installer
// screenshots showing a generic icon that was never actually branded).
// Pre-rendered (not regenerated per-build) — see assets/win32/README.md for
// how these were produced; keeps CI from needing a Python/Pillow toolchain
// on the Windows runner just to composite 14 bitmaps.
const win32AssetsDir = join(assets, "win32");
const win32Dest = join(upstream, "resources", "win32");
if (existsSync(win32AssetsDir) && existsSync(win32Dest)) {
  let count = 0;
  for (const f of readdirSync(win32AssetsDir).filter((f) => f.endsWith(".bmp"))) {
    copyFileSync(join(win32AssetsDir, f), join(win32Dest, f));
    count++;
  }
  console.log(`icon: ${count} Inno Setup wizard bitmaps → resources/win32/`);
}

// live dev bundle on macOS, if present. The .app name derives from
// product.nameLong (see upstream/build/lib/electron.ts's
// `productAppName: product.nameLong`), not a fixed "LakshX.app" — same
// rebrand-staleness class as the "Archive (macOS)" step in
// .github/workflows/build.yml. Not CI-reachable (this path only exists
// after a local `dev.sh`/`scripts/code.sh` run, never created by the CI
// pipeline), but glob for whatever .app actually landed instead of
// hardcoding a name that will go stale on the next rebrand too.
const electronDir = join(upstream, ".build/electron");
if (existsSync(electronDir) && existsSync(join(assets, "lakshx.icns"))) {
  const appDir = readdirSync(electronDir).find((f) => f.endsWith(".app"));
  const app = appDir ? join(electronDir, appDir, "Contents/Resources") : null;
  if (app && existsSync(app)) {
    for (const f of readdirSync(app).filter((f) => f.endsWith(".icns"))) {
      copyFileSync(join(assets, "lakshx.icns"), join(app, f));
    }
    console.log("icon: refreshed dev bundle");
  }
}
