// One-off uploader for LakshX download artifacts to Vercel Blob.
// Usage: node scripts/upload-blob.mjs <localFilePath> <blobPathname>
// Reads BLOB_READ_WRITE_TOKEN from .env.local (pulled via `vercel env pull`).
import { readFileSync } from "node:fs";
import { put } from "@vercel/blob";

const [, , localPath, blobPathname] = process.argv;
if (!localPath || !blobPathname) {
  console.error("Usage: node scripts/upload-blob.mjs <localFilePath> <blobPathname>");
  process.exit(1);
}

// Minimal .env.local parser (KEY=VALUE per line) — avoids an extra dependency
// for a one-off script.
function readEnvLocal() {
  const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const token = readEnvLocal().BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error("BLOB_READ_WRITE_TOKEN not found in .env.local");
  process.exit(1);
}

const body = readFileSync(localPath);
console.log(`Uploading ${localPath} (${(body.length / 1024 / 1024).toFixed(1)} MB) -> ${blobPathname} ...`);

const result = await put(blobPathname, body, {
  access: "public",
  token,
  addRandomSuffix: false,
  allowOverwrite: true,
});

console.log("Done:", result.url);
