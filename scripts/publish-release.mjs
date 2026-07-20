// Publishes a finished CI build: uploads each platform's installer to the
// koder-downloads Vercel Blob store and writes landing-page/lib/
// release-data.json — the machine-written half of the publish step
// (release-manifest.ts / downloads.ts stay hand-written, they just import
// this file, see release-manifest.ts's own doc comment for why).
//
// Run from the repo root, AFTER actions/download-artifact (merge-multiple:
// true) has dropped every matrix leg's file directly into the repo root —
// see .github/workflows/build.yml's `publish` job. Requires:
//   RELEASE_COMMIT          full 40-char SHA the build was stamped with
//                            (BUILD_SOURCEVERSION — same value, not the
//                            upstream/ pinned code-oss commit)
//   BLOB_READ_WRITE_TOKEN   koder-downloads write access
//
// Aborts without uploading ANYTHING if any expected artifact is missing —
// a partial publish (e.g. Windows updated but Linux still pointing at an
// older build under a commit the manifest now claims is "latest") is worse
// than no publish at all, since every platform shares one `commit` field.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDataPath = join(root, "landing-page", "lib", "release-data.json");

// Same store every manual publish this session used — qflnh9roir6uolgc is
// the koder-downloads store's fixed hostname prefix (Vercel Blob stores
// get one permanent public hostname; it's not a secret, just an id).
const BLOB_HOST = "https://qflnh9roir6uolgc.public.blob.vercel-storage.com";

const commit = process.env.RELEASE_COMMIT;
if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) {
  console.error("RELEASE_COMMIT must be the full 40-char build commit SHA");
  process.exit(1);
}

const rwToken = process.env.BLOB_READ_WRITE_TOKEN;
if (!rwToken) {
  console.error("BLOB_READ_WRITE_TOKEN must be set");
  process.exit(1);
}

// file (as landed by download-artifact at repo root) -> blob pathname/platform id.
// Keys here are exactly what app/api/update/[platform]/[quality]/[commit]/
// route.ts's `platforms` map expects — see that route and updatePlatformId()
// in product/lakshx-chat/extension.js; changing one without the other
// silently breaks the update check for that platform.
const ARTIFACTS = [
  { file: "LakshX-macOS-arm64.dmg", pathname: "koder/LakshX-macOS-arm64.dmg", platform: "darwin-arm64", blobVersionKey: "macArm" },
  { file: "LakshX-Windows-x64.exe", pathname: "koder/LakshX-Windows-x64.exe", platform: "win32-x64", blobVersionKey: "windows" },
  { file: "LakshX-Linux-x64.deb", pathname: "koder/LakshX-Linux-x64.deb", platform: "linux-x64", blobVersionKey: "linux" },
];

const missing = ARTIFACTS.filter((a) => !existsSync(join(root, a.file)));
if (missing.length) {
  console.error(`Missing expected artifact(s), aborting: ${missing.map((a) => a.file).join(", ")}`);
  process.exit(1);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const shortCommit = commit.slice(0, 7);
const productVersion = new Date().toISOString().slice(0, 10);
const platforms = {};
const blobVersion = {};

for (const { file, pathname, platform, blobVersionKey } of ARTIFACTS) {
  const path = join(root, file);
  const hash = sha256(path);
  console.log(`Uploading ${file} (sha256 ${hash})...`);
  execFileSync(
    "npx",
    ["vercel", "blob", "put", path, "--pathname", pathname, "--access", "public", "--allow-overwrite", "true", "--rw-token", rwToken],
    { stdio: "inherit" }
  );
  platforms[platform] = { url: `${BLOB_HOST}/${pathname}`, sha256: hash };
  // Distinct every publish (commit-derived, not just today's date) so a
  // same-day re-publish still forces a fresh fetch past the blob's 30-day
  // browser cache — see downloads.ts's own cache-busting doc comment for
  // the incident this guards against.
  blobVersion[blobVersionKey] = `${productVersion}-${shortCommit}`;
}

const releaseData = { commit, productVersion, timestamp: Date.now(), platforms, blobVersion };
writeFileSync(releaseDataPath, JSON.stringify(releaseData, null, 2) + "\n");
console.log(`Wrote ${releaseDataPath}`);
