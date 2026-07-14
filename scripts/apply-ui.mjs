#!/usr/bin/env node
/**
 * Applies the Koder UI layer to the upstream tree:
 *  1. copies product/koder-ui into upstream/extensions/koder-ui (built-in ext)
 *  2. injects product/koder-ui/koder.css inline into the workbench HTML files
 *     (src/ so future compiles keep it, out/ so it's live without a rebuild)
 * Idempotent: re-running replaces the previous injection between markers.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = join(root, "upstream");

if (!existsSync(join(upstream, "package.json"))) {
  console.error("upstream/ missing — run scripts/fetch-vscode.sh first");
  process.exit(1);
}

// 1. built-in extension
const extSrc = join(root, "product", "koder-ui");
const extDst = join(upstream, "extensions", "koder-ui");
cpSync(extSrc, extDst, { recursive: true });
console.log("koder-ui extension → extensions/koder-ui");

// 2. CSS injection
const css = readFileSync(join(extSrc, "koder.css"), "utf8");
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

console.log("Koder UI applied.");
