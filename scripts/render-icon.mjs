// Renders assets/icon.svg → assets/lakshx.icns (needs `npm i sharp` somewhere on PATH).
// Usage: node scripts/render-icon.mjs [path-to-node_modules-with-sharp]
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(resolve(process.argv[2] ?? ".", "package.json"));
const sharp = require("sharp");

const tmp = mkdtempSync(join(tmpdir(), "lakshx-icon-"));
await sharp("assets/icon.svg", { density: 300 }).resize(1024, 1024).png().toFile(join(tmp, "icon.png"));

const iconset = join(tmp, "lakshx.iconset");
execSync(`mkdir -p ${iconset}`);
for (const s of [16, 32, 128, 256, 512]) {
  execSync(`sips -z ${s} ${s} ${tmp}/icon.png --out ${iconset}/icon_${s}x${s}.png`, { stdio: "ignore" });
  execSync(`sips -z ${s * 2} ${s * 2} ${tmp}/icon.png --out ${iconset}/icon_${s}x${s}@2x.png`, { stdio: "ignore" });
}
execSync(`iconutil -c icns ${iconset} -o assets/lakshx.icns`);
console.log("assets/lakshx.icns regenerated");
