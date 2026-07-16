"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseExtensionId, parseRegistryResponse, checkExtension, checkAll, OPEN_VSX_HOST } = require("../lib/verify.js");
const { CURATED_EXTENSIONS } = require("../lib/curated.js");

// ---------------------------------------------------------------------------
// parseExtensionId
// ---------------------------------------------------------------------------
test("parseExtensionId splits publisher.name on the first dot", () => {
  assert.deepEqual(parseExtensionId("cweijan.vscode-mysql-client2"), { namespace: "cweijan", name: "vscode-mysql-client2" });
});

test("parseExtensionId throws on malformed ids", () => {
  assert.throws(() => parseExtensionId(""));
  assert.throws(() => parseExtensionId("no-dot"));
  assert.throws(() => parseExtensionId(".leadingdot"));
  assert.throws(() => parseExtensionId("trailingdot."));
  assert.throws(() => parseExtensionId(null));
});

// ---------------------------------------------------------------------------
// parseRegistryResponse — pure response-parsing logic, no HTTP involved
// ---------------------------------------------------------------------------
test("parseRegistryResponse: 200 with a well-formed extension record is a pass", () => {
  const body = JSON.stringify({ namespace: "esbenp", name: "prettier-vscode", displayName: "Prettier", version: "12.4.0", downloadCount: 8251814 });
  const result = parseRegistryResponse("esbenp.prettier-vscode", 200, body);
  assert.equal(result.found, true);
  assert.equal(result.displayName, "Prettier");
  assert.equal(result.downloadCount, 8251814);
});

test("parseRegistryResponse: 404 is a confirmed-absent fail, not an error", () => {
  const result = parseRegistryResponse("ms-vscode.cpptools", 404, "");
  assert.equal(result.found, false);
  assert.match(result.reason, /not found/i);
});

test("parseRegistryResponse: 200 with an `error` field body is treated as not-found", () => {
  const body = JSON.stringify({ error: "Extension not found" });
  const result = parseRegistryResponse("nope.nope", 200, body);
  assert.equal(result.found, false);
});

test("parseRegistryResponse: unexpected status code is 'could not check', not a pass or fail", () => {
  const result = parseRegistryResponse("some.ext", 500, "");
  assert.equal(result.found, null);
  assert.match(result.reason, /500/);
});

test("parseRegistryResponse: unparseable body is 'could not check'", () => {
  const result = parseRegistryResponse("some.ext", 200, "not json{{{");
  assert.equal(result.found, null);
});

test("parseRegistryResponse: 200 body missing namespace/name fields is 'could not check'", () => {
  const result = parseRegistryResponse("some.ext", 200, JSON.stringify({ foo: "bar" }));
  assert.equal(result.found, null);
});

// ---------------------------------------------------------------------------
// checkExtension / checkAll with an injected (mocked) transport — no network
// ---------------------------------------------------------------------------
test("checkExtension uses the injected httpGet and reports a pass", async () => {
  const httpGet = async (namespace, name) => {
    assert.equal(namespace, "esbenp");
    assert.equal(name, "prettier-vscode");
    return { statusCode: 200, body: JSON.stringify({ namespace, name, displayName: "Prettier", version: "1.0.0" }) };
  };
  const result = await checkExtension("esbenp.prettier-vscode", { httpGet });
  assert.equal(result.found, true);
});

test("checkExtension reports found:false for a mocked 404 (squatting-risk scenario)", async () => {
  const httpGet = async () => ({ statusCode: 404, body: "" });
  const result = await checkExtension("ms-vscode.cpptools", { httpGet });
  assert.equal(result.found, false);
});

test("checkExtension reports found:null (not a silent pass) when the transport rejects", async () => {
  const httpGet = async () => {
    throw new Error("ECONNREFUSED");
  };
  const result = await checkExtension("some.ext", { httpGet });
  assert.equal(result.found, null);
  assert.match(result.reason, /could not reach Open VSX/);
});

test("checkExtension reports found:null for a malformed id without calling the transport", async () => {
  let called = false;
  const httpGet = async () => {
    called = true;
    return { statusCode: 200, body: "{}" };
  };
  const result = await checkExtension("not-an-id", { httpGet });
  assert.equal(result.found, null);
  assert.equal(called, false);
});

test("checkAll preserves input order and checks every entry with a mocked transport", async () => {
  const ids = ["a.one", "b.two", "c.three"];
  const httpGet = async (namespace, name) => ({ statusCode: 200, body: JSON.stringify({ namespace, name }) });
  const results = await checkAll(ids, { httpGet, concurrency: 2 });
  assert.deepEqual(
    results.map((r) => r.id),
    ids,
  );
  assert.ok(results.every((r) => r.found === true));
});

test("checkAll mixes pass/fail/error results correctly per entry", async () => {
  const ids = ["good.one", "missing.two", "broken.three"];
  const httpGet = async (namespace, name) => {
    if (namespace === "good") return { statusCode: 200, body: JSON.stringify({ namespace, name }) };
    if (namespace === "missing") return { statusCode: 404, body: "" };
    throw new Error("network down");
  };
  const results = await checkAll(ids, { httpGet });
  assert.equal(results[0].found, true);
  assert.equal(results[1].found, false);
  assert.equal(results[2].found, null);
});

// ---------------------------------------------------------------------------
// REAL network integration test — this is the core claim of the feature:
// that curated ids are actually checked against the live registry LakshX's
// gallery points at, not just asserted to be fine. Skips gracefully (does
// not fail the suite) if the sandbox has no network access.
// ---------------------------------------------------------------------------
test("live check: every shipped CURATED_EXTENSIONS entry resolves on the real Open VSX API", async (t) => {
  let reachable = true;
  try {
    const probe = await checkExtension("esbenp.prettier-vscode", { timeoutMs: 5000 });
    reachable = probe.found !== null;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    t.skip(`${OPEN_VSX_HOST} not reachable from this sandbox — curated list is unverified pending network access`);
    return;
  }

  const results = await checkAll(CURATED_EXTENSIONS, { timeoutMs: 8000 });
  const failures = results.filter((r) => r.found !== true);
  assert.deepEqual(
    failures,
    [],
    `one or more shipped curated entries did NOT resolve on live Open VSX: ${JSON.stringify(failures, null, 2)}`,
  );
});

test("live check: a known VS-Code-Marketplace-only id (ms-vscode.cpptools) is confirmed ABSENT from Open VSX", async (t) => {
  let result;
  try {
    result = await checkExtension("ms-vscode.cpptools", { timeoutMs: 5000 });
  } catch {
    result = { found: null };
  }
  if (result.found === null) {
    t.skip(`${OPEN_VSX_HOST} not reachable from this sandbox — cannot demonstrate the squatting-risk fixture live`);
    return;
  }
  // This is the exact scenario the whole feature exists to prevent: an id
  // that exists on the Marketplace but not on Open VSX must never be
  // presented to a user as "verified".
  assert.equal(result.found, false, "expected ms-vscode.cpptools to be absent from Open VSX (real-world squatting-risk example)");
});
