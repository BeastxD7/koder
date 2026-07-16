// These tests inject a mock `fetchImpl` — no real network/vscode needed.
// (A real live call against OpenRouter WAS made once, by hand, during this
// build to lock the actual response shape these mocks reproduce — see the
// build report / README for that transcript; it's not re-run here so the
// test suite doesn't depend on network access or a live API key.)
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { embedBatch, embedAll } = require("../lib/embeddings.js");

function mockFetch(handler) {
  return async (url, init) => handler(url, init);
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

test("embedBatch: empty input returns [] without calling fetch", async () => {
  let called = false;
  const fetchImpl = mockFetch(() => {
    called = true;
    return okJson({ data: [] });
  });
  const result = await embedBatch({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl }, []);
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("embedBatch: posts to {baseUrl}/embeddings with the right auth header and body shape", async () => {
  let seenUrl, seenBody, seenAuth;
  const fetchImpl = mockFetch((url, init) => {
    seenUrl = url;
    seenAuth = init.headers.authorization;
    seenBody = JSON.parse(init.body);
    return okJson({ data: [{ embedding: [1, 2, 3], index: 0 }] });
  });
  await embedBatch({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "text-embedding-3-small", fetchImpl }, ["hello"]);
  assert.equal(seenUrl, "https://api.example.com/v1/embeddings");
  assert.equal(seenAuth, "Bearer sk-test");
  assert.deepEqual(seenBody, { model: "text-embedding-3-small", input: ["hello"] });
});

test("embedBatch: re-orders results by the response's `index` field rather than trusting array order (matches the real OpenRouter response shape observed live)", async () => {
  const fetchImpl = mockFetch(() =>
    okJson({
      data: [
        { embedding: [0, 2], index: 1 },
        { embedding: [0, 0], index: 0 },
      ],
    }),
  );
  const result = await embedBatch({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl }, ["first", "second"]);
  assert.deepEqual(result[0], [0, 0]);
  assert.deepEqual(result[1], [0, 2]);
});

test("embedBatch: non-ok HTTP status throws with the status code and a body snippet", async () => {
  const fetchImpl = mockFetch(() => ({ ok: false, status: 401, text: async () => '{"error":"invalid api key"}' }));
  await assert.rejects(() => embedBatch({ baseUrl: "https://x", apiKey: "bad", model: "m", fetchImpl }, ["hi"]), /401/);
});

test("embedBatch: a response with the wrong vector count throws instead of silently returning misaligned data", async () => {
  const fetchImpl = mockFetch(() => okJson({ data: [{ embedding: [1], index: 0 }] }));
  await assert.rejects(() => embedBatch({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl }, ["a", "b"]), /mismatch/);
});

test("embedAll: splits into batches of the given size and preserves overall order", async () => {
  const seenBatchSizes = [];
  const fetchImpl = mockFetch((url, init) => {
    const input = JSON.parse(init.body).input;
    seenBatchSizes.push(input.length);
    return okJson({ data: input.map((_, i) => ({ embedding: [input.length, i], index: i })) });
  });
  const texts = ["a", "b", "c", "d", "e"];
  const result = await embedAll({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl }, texts, { batchSize: 2 });
  assert.deepEqual(seenBatchSizes, [2, 2, 1]);
  assert.equal(result.length, 5);
});

test("embedAll: onBatch progress callback fires once per batch with (done, total)", async () => {
  const fetchImpl = mockFetch((url, init) => {
    const input = JSON.parse(init.body).input;
    return okJson({ data: input.map((_, i) => ({ embedding: [1], index: i })) });
  });
  const progress = [];
  await embedAll({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl }, ["a", "b", "c"], {
    batchSize: 1,
    onBatch: (done, total) => progress.push([done, total]),
  });
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
});
