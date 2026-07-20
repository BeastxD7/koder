// Publishes a finished CI build: uploads each platform's installer to the
// koder-downloads Vercel Blob store and writes landing-page/lib/
// release-data.json — the machine-written half of the publish step
// (release-manifest.ts / downloads.ts stay hand-written, they just import
// this file, see release-manifest.ts's own doc comment for why).
//
// Lives under landing-page/ (not the repo-root scripts/, where every other
// build-pipeline script lives) specifically so plain Node module
// resolution finds @vercel/blob in landing-page/node_modules without a
// separate install step — the SDK, not the `vercel` CLI: `vercel blob put`
// needs a full CLI login session even when a --rw-token is passed (found
// live in CI — an --rw-token-only invocation that worked from a machine
// with an existing `vercel login` session failed outright in a clean
// runner with "No existing credentials found"). The SDK's put() only ever
// needs the token, no CLI session, which is exactly what an unattended CI
// job has to work with.
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
import { put } from "@vercel/blob";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const landingRoot = join(scriptDir, ".."); // landing-page/
const repoRoot = join(landingRoot, ".."); // repo root — where download-artifact drops files
const releaseDataPath = join(landingRoot, "lib", "release-data.json");

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

const missing = ARTIFACTS.filter((a) => !existsSync(join(repoRoot, a.file)));
if (missing.length) {
  console.error(`Missing expected artifact(s), aborting: ${missing.map((a) => a.file).join(", ")}`);
  process.exit(1);
}

// Streams the file through the hash instead of reading it whole into
// memory first — these are 150-250MB installers, and this script's only
// job here is producing a digest, not holding the file in RAM twice.
function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

const shortCommit = commit.slice(0, 7);
const productVersion = new Date().toISOString().slice(0, 10);
const platforms = {};
const blobVersion = {};

for (const { file, pathname, platform, blobVersionKey } of ARTIFACTS) {
  const path = join(repoRoot, file);
  const hash = await sha256(path);
  console.log(`Uploading ${file} (sha256 ${hash})...`);
  const { url } = await put(pathname, createReadStream(path), {
    access: "public",
    allowOverwrite: true,
    addRandomSuffix: false, // stable pathname required — downloads.ts hardcodes these URLs, they can't shift on every publish
    multipart: true, // required past ~5MB per-part limits — every one of these files is well over that
    token: rwToken,
  });
  platforms[platform] = { url, sha256: hash };
  // Distinct every publish (commit-derived, not just today's date) so a
  // same-day re-publish still forces a fresh fetch past the blob's 30-day
  // browser cache — see downloads.ts's own cache-busting doc comment for
  // the incident this guards against.
  blobVersion[blobVersionKey] = `${productVersion}-${shortCommit}`;
}

const releaseData = { commit, productVersion, timestamp: Date.now(), platforms, blobVersion };
writeFileSync(releaseDataPath, JSON.stringify(releaseData, null, 2) + "\n");
console.log(`Wrote ${releaseDataPath}`);
