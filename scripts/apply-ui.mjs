#!/usr/bin/env node
/**
 * Applies the Koder UI layer to the upstream tree:
 *  1. copies product/lakshx-ui into upstream/extensions/lakshx-ui (built-in ext)
 *  2. injects product/lakshx-ui/lakshx.css inline into the workbench HTML files
 *     (src/ so future compiles keep it, out/ so it's live without a rebuild)
 * Idempotent: re-running replaces the previous injection between markers.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = join(root, "upstream");

if (!existsSync(join(upstream, "package.json"))) {
  console.error("upstream/ missing — run scripts/fetch-vscode.sh first");
  process.exit(1);
}

// 1. built-in extensions
for (const ext of ["lakshx-ui", "lakshx-chat", "lakshx-graph", "lakshx-db", "lakshx-commentary", "lakshx-welcome", "lakshx-commandbar", "lakshx-extensions", "lakshx-search", "lakshx-structural-search", "lakshx-tab", "lakshx-terminal", "lakshx-testing", "lakshx-secrets", "lakshx-trace", "theme-lakshx-carbon", "theme-lakshx-symbols"]) {
  cpSync(join(root, "product", ext), join(upstream, "extensions", ext), { recursive: true });
  console.log(`${ext} extension → extensions/${ext}`);
}

// 1b. de-VSCode: the bundled Copilot chat extension must not exist in Koder
rmSync(join(upstream, "extensions", "copilot"), { recursive: true, force: true });
console.log("removed extensions/copilot");

// 1c. build/npm/postinstall.ts still lists 'extensions/copilot' as an
// npm-install target (build/npm/dirs.ts) — it doesn't know we just deleted
// that directory. When its concurrency-limited install pool reaches that
// entry, child_process.spawn gets a nonexistent cwd, and Node/libuv
// mis-report the failure as "spawn /bin/sh ENOENT" instead of a missing-
// directory error, which crashes `npm ci` in upstream/ 3/3 times,
// deterministically, on every install (confirmed via CI log evidence —
// raising the fd ulimit had zero effect, ruling out resource exhaustion).
// Drop the entry so postinstall never tries to install into it.
{
  const dirsFile = join(upstream, "build", "npm", "dirs.ts");
  // Normalize CRLF->LF before matching: on Windows CI, core.autocrlf=true
  // checks upstream/ out with CRLF line endings (confirmed for this same
  // repo by the git-apply --ignore-whitespace fix in scripts/prepare.sh),
  // and this regex's trailing \n would never match a `,\r\n` sequence,
  // silently or loudly depending on the check below. Writing back LF-only
  // is safe — this is a disposable, gitignored build tree, and TypeScript
  // doesn't care about line-ending style.
  const dirsSrc = readFileSync(dirsFile, "utf8").replace(/\r\n/g, "\n");
  let patched = dirsSrc.replace(/^\t'extensions\/copilot',\n/m, "");
  if (patched === dirsSrc) {
    console.error(
      "upstream/build/npm/dirs.ts: expected to find and remove the 'extensions/copilot' entry, but it wasn't there — upstream's dirs.ts format may have changed. Fix scripts/apply-ui.mjs's regex."
    );
    process.exit(1);
  }

  // 1d. the opposite problem: lakshx-db is the first LakshX built-in
  // extension with a REAL npm dependency (the `mongodb` driver — see
  // product/lakshx-db/package.json). Unlike lakshx-ui/lakshx-chat/lakshx-graph
  // (zero deps, so their absence from dirs.ts was harmless), upstream's own
  // `npm ci`/postinstall in extensions/ only installs into directories
  // listed here — without this entry, extensions/lakshx-db/node_modules
  // never gets populated by CI and `require("mongodb")` fails at runtime in
  // a packaged build (works locally only because this repo's own
  // `npm install` was already run inside product/lakshx-db by hand).
  const beforeDb = patched;
  patched = patched.replace(/^\t'extensions',\n/m, "\t'extensions',\n\t'extensions/lakshx-db',\n");
  if (patched === beforeDb) {
    console.error(
      "upstream/build/npm/dirs.ts: expected to find the 'extensions' entry to insert 'extensions/lakshx-db' after it, but it wasn't there — upstream's dirs.ts format may have changed. Fix scripts/apply-ui.mjs's regex."
    );
    process.exit(1);
  }

  // 1e. lakshx-chat now has the same real-dependency problem as lakshx-db
  // above, for the same reason: `agent/src/browser.ts`'s `browser_preview`
  // tool uses `playwright-core`, and `agent/package.json`'s esbuild bundle
  // deliberately marks it `--external` rather than inlining it into
  // `server.cjs` (see docs/architecture.md §3 — playwright-core's own
  // internal `__dirname`-relative lookups, e.g. `browsers.json`, break once
  // flattened into a different file by esbuild). That means
  // `product/lakshx-chat/package.json`'s `playwright-core` dependency needs
  // real `npm install`, same as lakshx-db's `mongodb` — without this entry,
  // `require("playwright-core")` fails at runtime in a packaged build.
  const beforeChat = patched;
  patched = patched.replace(/^\t'extensions\/lakshx-db',\n/m, "\t'extensions/lakshx-db',\n\t'extensions/lakshx-chat',\n");
  if (patched === beforeChat) {
    console.error(
      "upstream/build/npm/dirs.ts: expected to find the just-inserted 'extensions/lakshx-db' entry to insert 'extensions/lakshx-chat' after it. Fix scripts/apply-ui.mjs's regex."
    );
    process.exit(1);
  }

  writeFileSync(dirsFile, patched);
  console.log("patched build/npm/dirs.ts (dropped extensions/copilot install target, added extensions/lakshx-db and extensions/lakshx-chat)");
}

// 2. CSS injection
const css = readFileSync(join(root, "product", "lakshx-ui", "lakshx.css"), "utf8");
const OPEN = "<!-- KODER-UI-BEGIN -->";
const CLOSE = "<!-- KODER-UI-END -->";
const block = `${OPEN}<style id="lakshx-ui">\n${css}\n</style>${CLOSE}`;

const htmlFiles = [
  "src/vs/code/electron-browser/workbench/workbench.html",
  "src/vs/code/electron-browser/workbench/workbench-dev.html",
  "src/vs/code/browser/workbench/workbench.html",
  "src/vs/code/browser/workbench/workbench-dev.html",
  "out/vs/code/electron-browser/workbench/workbench.html",
  "out/vs/code/electron-browser/workbench/workbench-dev.html",
  "out/vs/code/browser/workbench/workbench.html",
  "out/vs/code/browser/workbench/workbench-dev.html",
];

for (const rel of htmlFiles) {
  const file = join(upstream, rel);
  if (!existsSync(file)) continue;
  let html = readFileSync(file, "utf8");
  const marker = new RegExp(`${OPEN}[\\s\\S]*?${CLOSE}`);
  if (marker.test(html)) {
    html = html.replace(marker, block);
  } else {
    html = html.replace("</head>", `\t${block}\n\t</head>`);
  }
  writeFileSync(file, html);
  console.log(`css injected → ${rel}`);
}

// 2b. replace the VS Code letterpress watermark with the Koder spark
const lpSrcDir = join(root, "product", "lakshx-ui");
const lpTargets = [
  "src/vs/workbench/browser/parts/editor/media",
  "out/vs/workbench/browser/parts/editor/media",
  "out/media",
];
for (const dir of lpTargets) {
  const abs = join(upstream, dir);
  if (!existsSync(abs)) continue;
  for (const variant of ["dark", "hcDark"]) {
    const dst = join(abs, `letterpress-${variant}.svg`);
    if (existsSync(dst)) cpSync(join(lpSrcDir, "letterpress-dark.svg"), dst);
  }
  for (const variant of ["light", "hcLight"]) {
    const dst = join(abs, `letterpress-${variant}.svg`);
    if (existsSync(dst)) cpSync(join(lpSrcDir, "letterpress-light.svg"), dst);
  }
  console.log(`letterpress → ${dir}`);
}

// 3. build-system tweak: Koder ships no copilot extension — the packaging
// pipeline's ripgrep-shim step must skip instead of throwing.
const copilotBuild = join(upstream, "build", "lib", "copilot.ts");
if (existsSync(copilotBuild)) {
  // Normalize CRLF->LF defensively (this particular match is single-line so
  // it's unaffected today, but a future upstream reflow that wraps it across
  // lines would silently re-expose the same CRLF issue fixed below for
  // dirs.ts/gulpfile.vscode.ts — cheap insurance to normalize unconditionally).
  let src = readFileSync(copilotBuild, "utf8").replace(/\r\n/g, "\n");
  const throwLine = "throw new Error(`[prepareBuiltInCopilotRipgrepShim] Copilot SDK directory not found at ${copilotSdkBase}`);";
  const skipLine = "console.log(`[koder] copilot extension not bundled — skipping ripgrep shim`); return;";
  if (src.includes(throwLine)) {
    src = src.replace(throwLine, skipLine);
    writeFileSync(copilotBuild, src);
    console.log("patched build/lib/copilot.ts (shim skips when copilot absent)");
  }
}

// 3b. build-system tweak: patchWin32DependenciesTask (win32 packaging) probes
// every .node/rg.exe/etc dependency binary for an existing Authenticode
// signature via `signtool.exe verify` before rcedit touches it, and hard-
// crashes the whole build ("spawn signtool.exe ENOENT") if the Windows SDK
// isn't installed — which it isn't on stock GitHub-hosted windows-2022
// runners, and we have no code-signing certificate to use it with anyway.
// Treat "signtool not present" as "nothing to strip" instead of a fatal
// error; genuine signtool failures (SDK present, real error) still reject.
const gulpfileVscode = join(upstream, "build", "gulpfile.vscode.ts");
{
  // Normalize CRLF->LF before matching: this `before` literal spans two
  // lines joined by a literal \n, so on Windows CI (upstream/ checked out
  // CRLF, same root cause as scripts/prepare.sh's --ignore-whitespace fix
  // for patches/*.patch) the \r before each \n breaks the match outright.
  // Confirmed locally against a CRLF-converted copy of the pristine file —
  // this pattern fails to match without the normalization below.
  let src = readFileSync(gulpfileVscode, "utf8").replace(/\r\n/g, "\n");
  const before = "\t\tproc.on('error', reject);\n\t\tproc.on('exit', code => resolve(code === 0));";
  const after =
    "\t\tproc.on('error', (err) => {\n" +
    "\t\t\t// signtool.exe (Windows SDK) not installed on this runner and no cert\n" +
    "\t\t\t// to use it with — nothing to verify, so nothing to strip either.\n" +
    "\t\t\tif ((err as NodeJS.ErrnoException).code === 'ENOENT') { resolve(false); return; }\n" +
    "\t\t\treject(err);\n" +
    "\t\t});\n" +
    "\t\tproc.on('exit', code => resolve(code === 0));";
  if (!src.includes(before)) {
    console.error(
      "upstream/build/gulpfile.vscode.ts: expected hasAuthenticodeSignature's signtool.exe spawn to patch, but it wasn't found — upstream's format may have changed. Fix scripts/apply-ui.mjs's patch."
    );
    process.exit(1);
  }
  src = src.replace(before, after);

  // 3b-ii. Same task (patchWin32DependenciesTask) globs EVERY **/*.node in the
  // package and runs rcedit on each to stamp Windows version resources.
  // smart-whisper (voice mode) bundles whisper.cpp's example addon at
  //   node_modules/smart-whisper/whisper.cpp/examples/addon.node
  // which is a NON-PE .node that rcedit cannot load ("rcedit.exe failed ...
  // Unable to load file ... addon.node", exit 1), failing the whole min build
  // at the very last step (package-win32 -> vscode-win32-x64-min-ci). Upstream
  // already excludes @parcel/watcher's .node from this exact glob for the same
  // "rcedit fails on non-PE .node" reason (see build/.moduleignore); extend the
  // ignore list to also skip smart-whisper. Stamping is cosmetic version
  // metadata, so skipping it is harmless — voice mode still loads its real
  // addon at runtime.
  const rceditBefore = "glob('**/*.node', { cwd, ignore: 'extensions/node_modules/@parcel/watcher/**' }),";
  const rceditAfter = "glob('**/*.node', { cwd, ignore: ['extensions/node_modules/@parcel/watcher/**', '**/smart-whisper/**'] }),";
  if (!src.includes(rceditBefore)) {
    console.error(
      "upstream/build/gulpfile.vscode.ts: expected patchWin32DependenciesTask's **/*.node rcedit glob to patch, but it wasn't found — upstream's format may have changed. Fix scripts/apply-ui.mjs's patch."
    );
    process.exit(1);
  }
  src = src.replace(rceditBefore, rceditAfter);

  writeFileSync(gulpfileVscode, src);
  console.log("patched build/gulpfile.vscode.ts (signtool.exe ENOENT no longer fatal; rcedit skips smart-whisper non-PE .node)");
}

// 3c. build-system tweak: the Windows installer (Inno Setup) task sets
// AppxPackage/AppxPackageDll/AppxPackageName/FileExplorerContextMenuCLSID
// definitions whenever product.json's "quality" is "stable"/"insider" —
// unconditionally, regardless of whether an actual .appx/.dll pair exists on
// disk to reference. Those files come from Microsoft's own separate Windows
// Store packaging pipeline, which this fork doesn't build. code.iss (the
// Inno Setup script) already handles their ABSENCE gracefully — its own
// comment says "No-op when FileExplorerContextMenuCLSID is not defined
// (e.g. OSS builds)" — but only if the definition is never set in the first
// place; Koder's product.overrides.json sets "quality": "stable" for other
// reasons (branding/update-channel semantics elsewhere), which would
// otherwise wrongly opt into this Microsoft-only branch and make Inno Setup
// fail looking for a source file that was never built. Gate the branch
// behind a new, Koder-specific opt-in flag (win32AppxPackagingEnabled) that
// product.overrides.json never sets, instead of touching "quality" itself.
const gulpfileWin32 = join(upstream, "build", "gulpfile.vscode.win32.ts");
{
  // Normalize CRLF->LF defensively — see the copilot.ts comment above for
  // why this unconditional normalization is applied even to matches that
  // are single-line-safe today.
  let src = readFileSync(gulpfileWin32, "utf8").replace(/\r\n/g, "\n");
  const before = "\t\tif (quality === 'stable' || quality === 'insider') {";
  const after =
    "\t\t// Koder: Microsoft's Windows Store (AppX) packaging pipeline isn't built\n" +
    "\t\t// by this fork — gated behind an explicit opt-in product.json flag that\n" +
    "\t\t// is never set here, rather than the quality check upstream uses (which\n" +
    "\t\t// Koder sets to 'stable' for unrelated reasons). See scripts/apply-ui.mjs.\n" +
    "\t\tif ((product as { win32AppxPackagingEnabled?: boolean }).win32AppxPackagingEnabled === true) {";
  if (!src.includes(before)) {
    console.error(
      "upstream/build/gulpfile.vscode.win32.ts: expected the AppX-definitions quality check to patch, but it wasn't found — upstream's format may have changed. Fix scripts/apply-ui.mjs's patch."
    );
    process.exit(1);
  }
  src = src.replace(before, after);
  writeFileSync(gulpfileWin32, src);
  console.log("patched build/gulpfile.vscode.win32.ts (AppX packaging opt-in, not quality-gated)");
}

console.log("LakshX UI applied.");
