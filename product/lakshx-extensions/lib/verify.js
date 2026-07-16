"use strict";

// The actual trust mechanism for the "Recommended & Verified" panel: queries
// Open VSX's public API (https://open-vsx.org/api/{namespace}/{name}) to
// confirm a curated extension ID genuinely resolves on the registry that
// LakshX's own extensionsGallery.serviceUrl points at (see
// product/product.overrides.json and docs/architecture.md). A static
// hand-curated list is not itself a trust guarantee — this file is what
// turns "we picked these" into "we checked these".
//
// vscode-free and dependency-free on purpose: uses only Node's built-in
// `https` module, so it can run in the extension host (Node context) and be
// unit-tested with `node --test` without pulling in a fetch polyfill.

const https = require("https");

const OPEN_VSX_HOST = "open-vsx.org";
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Split a "publisher.name" extension id into Open VSX's {namespace, name}
 * path segments. Open VSX addresses extensions as /api/{namespace}/{name};
 * namespace is everything before the FIRST dot (extension names themselves
 * can occasionally contain dots, publishers effectively never do).
 */
function parseExtensionId(id) {
  if (typeof id !== "string" || !id) {
    throw new TypeError(`extension id must be a non-empty string, got: ${JSON.stringify(id)}`);
  }
  const dot = id.indexOf(".");
  if (dot <= 0 || dot === id.length - 1) {
    throw new TypeError(`extension id "${id}" is not in "publisher.name" form`);
  }
  return { namespace: id.slice(0, dot), name: id.slice(dot + 1) };
}

/**
 * Pure parsing of an Open VSX API response into a verification result.
 * Takes the already-fetched (statusCode, body) so it's testable without any
 * HTTP mocking — this is the logic that decides pass/fail/error, not the
 * transport.
 */
function parseRegistryResponse(id, statusCode, body) {
  if (statusCode === 404) {
    return { id, found: false, reason: "not found on Open VSX (404)" };
  }
  if (statusCode !== 200) {
    return { id, found: null, reason: `unexpected HTTP ${statusCode} from Open VSX` };
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { id, found: null, reason: `could not parse Open VSX response as JSON: ${err.message}` };
  }

  // Open VSX returns HTTP 200 with an error-shaped body for some "not
  // findable" cases (as opposed to a clean 404) — treat an `error` field as
  // not-found rather than a pass.
  if (parsed && typeof parsed.error === "string" && parsed.error) {
    return { id, found: false, reason: `Open VSX reported an error: ${parsed.error}` };
  }
  if (!parsed || typeof parsed.namespace !== "string" || typeof parsed.name !== "string") {
    return { id, found: null, reason: "Open VSX response did not look like an extension record" };
  }

  return {
    id,
    found: true,
    reason: "resolved on Open VSX",
    namespace: parsed.namespace,
    name: parsed.name,
    displayName: parsed.displayName || null,
    version: parsed.version || null,
    downloadCount: typeof parsed.downloadCount === "number" ? parsed.downloadCount : null,
  };
}

/**
 * Default (real) HTTP transport: GET https://open-vsx.org/api/{namespace}/{name}
 * and resolve with { statusCode, body }. Never rejects on a non-2xx status —
 * only rejects on a genuine network/timeout failure, so callers can tell
 * "confirmed absent" (404) apart from "couldn't check" (network error).
 */
function defaultHttpGet(namespace, name, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const path = `/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
    const req = https.get(
      { host: OPEN_VSX_HOST, path, headers: { Accept: "application/json", "User-Agent": "lakshx-extensions-verify/0.0.1" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms querying Open VSX for ${namespace}.${name}`));
    });
    req.on("error", reject);
  });
}

/**
 * Check a single curated-extension id against the real Open VSX registry.
 * `httpGet` is injectable for tests; production callers should just omit it.
 * Never throws for a confirmed-absent extension (found: false) — only
 * resolves with found: null + a reason when the check itself couldn't
 * complete (network unreachable, timeout, unexpected response shape).
 */
async function checkExtension(id, { httpGet = defaultHttpGet, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let namespace, name;
  try {
    ({ namespace, name } = parseExtensionId(id));
  } catch (err) {
    return { id, found: null, reason: err.message };
  }

  try {
    const { statusCode, body } = await httpGet(namespace, name, { timeoutMs });
    return parseRegistryResponse(id, statusCode, body);
  } catch (err) {
    return { id, found: null, reason: `could not reach Open VSX: ${err.message || err}` };
  }
}

/**
 * Check every entry in a curated list. Runs with bounded concurrency so a
 * long list doesn't fire dozens of simultaneous sockets. Returns an array of
 * results in the SAME order as the input list.
 */
async function checkAll(entries, { concurrency = 4, httpGet = defaultHttpGet, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ids = entries.map((e) => (typeof e === "string" ? e : e.id));
  const results = new Array(ids.length);
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const i = cursor++;
      results[i] = await checkExtension(ids[i], { httpGet, timeoutMs });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = {
  OPEN_VSX_HOST,
  parseExtensionId,
  parseRegistryResponse,
  defaultHttpGet,
  checkExtension,
  checkAll,
};
