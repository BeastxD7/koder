// Installs Koder icons into upstream resources for whichever platforms the
// assets exist for. Called from prepare.sh — cross-platform (pure Node).
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = join(root, "upstream");
const assets = join(root, "assets");

const installs = [
  ["koder.icns", "resources/darwin/code.icns"],
  ["koder.ico", "resources/win32/code.ico"],
  ["koder-512.png", "resources/linux/code.png"],
];
for (const [asset, dest] of installs) {
  const src = join(assets, asset);
  const dst = join(upstream, dest);
  if (existsSync(src) && existsSync(dirname(dst))) {
    copyFileSync(src, dst);
    console.log(`icon: ${asset} → ${dest}`);
  }
}

// live dev bundle on macOS, if present
const app = join(upstream, ".build/electron/Koder.app/Contents/Resources");
if (existsSync(app) && existsSync(join(assets, "koder.icns"))) {
  for (const f of readdirSync(app).filter((f) => f.endsWith(".icns"))) {
    copyFileSync(join(assets, "koder.icns"), join(app, f));
  }
  console.log("icon: refreshed dev bundle");
}
