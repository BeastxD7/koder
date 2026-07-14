#!/usr/bin/env node
/**
 * Applies the Koder UI layer to the upstream tree:
 *  1. copies product/koder-ui into upstream/extensions/koder-ui (built-in ext)
 *  2. injects product/koder-ui/koder.css inline into the workbench HTML files
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
for (const ext of ["koder-ui", "koder-chat", "theme-koder-carbon", "theme-koder-symbols"]) {
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
  const dirsSrc = readFileSync(dirsFile, "utf8");
  const patched = dirsSrc.replace(/^\t'extensions\/copilot',\n/m, "");
  if (patched === dirsSrc) {
    console.error(
      "upstream/build/npm/dirs.ts: expected to find and remove the 'extensions/copilot' entry, but it wasn't there — upstream's dirs.ts format may have changed. Fix scripts/apply-ui.mjs's regex."
    );
    process.exit(1);
  }
  writeFileSync(dirsFile, patched);
  console.log("patched build/npm/dirs.ts (dropped extensions/copilot install target)");
}

// 2. CSS injection
const css = readFileSync(join(root, "product", "koder-ui", "koder.css"), "utf8");
const OPEN = "<!-- KODER-UI-BEGIN -->";
const CLOSE = "<!-- KODER-UI-END -->";
const block = `${OPEN}<style id="koder-ui">\n${css}\n</style>${CLOSE}`;

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
const lpSrcDir = join(root, "product", "koder-ui");
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
  let src = readFileSync(copilotBuild, "utf8");
  const throwLine = "throw new Error(`[prepareBuiltInCopilotRipgrepShim] Copilot SDK directory not found at ${copilotSdkBase}`);";
  const skipLine = "console.log(`[koder] copilot extension not bundled — skipping ripgrep shim`); return;";
  if (src.includes(throwLine)) {
    src = src.replace(throwLine, skipLine);
    writeFileSync(copilotBuild, src);
    console.log("patched build/lib/copilot.ts (shim skips when copilot absent)");
  }
}

console.log("Koder UI applied.");
