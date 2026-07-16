// Direct HTTPS calls to an embeddings endpoint — no SDK, no routing through
// agent/src or lakshx-chat (this extension is fully standalone per the build
// brief). Uses the runtime's built-in global `fetch` (Node 24 / Electron's
// bundled Node both ship it natively), the same pattern agent/src/providers/
// openai-compat.ts and validate.ts use for their own direct HTTPS calls —
// there is no vscode dependency here, this module is usable from `node --test`
// directly (though the tests mock fetch rather than hitting real network).
"use strict";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * POST {baseUrl}/embeddings with an array of input strings, in ONE HTTP call
 * per batch (an OpenAI-compatible embeddings endpoint accepts `input` as a
 * string OR an array — batching cuts the request count by `batchSize`,
 * important both for latency and because embeddings endpoints bill and
 * rate-limit per request as well as per token). Verified live against
 * OpenRouter's real endpoint during this build (see the build report) —
 * response shape is `{data: [{embedding:number[], index:number}, ...]}`,
 * order-correlated via `index` rather than assumed to match input order (a
 * documented OpenAI-compatible behavior, and cheap insurance if a provider
 * doesn't preserve order).
 *
 * @param {{baseUrl:string, apiKey:string, model:string, fetchImpl?:typeof fetch, timeoutMs?:number}} cfg
 * @param {string[]} texts
 * @returns {Promise<number[][]>} embeddings in the SAME order as `texts`.
 */
async function embedBatch(cfg, texts) {
  const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("No fetch implementation available (expected a global fetch or an injected fetchImpl).");
  if (texts.length === 0) return [];

  const res = await fetchImpl(`${cfg.baseUrl}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, input: texts }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`${cfg.baseUrl}/embeddings ${res.status}: ${bodyText.slice(0, 400)}`);
  }

  const json = await res.json();
  const data = json.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error(`Embeddings response shape mismatch: expected ${texts.length} vectors, got ${Array.isArray(data) ? data.length : typeof data}.`);
  }

  const ordered = new Array(texts.length);
  data.forEach((item, i) => {
    const idx = typeof item.index === "number" ? item.index : i;
    ordered[idx] = item.embedding;
  });
  return ordered;
}

/**
 * Embed a full list of texts in fixed-size batches, sequentially (not
 * concurrent — deliberately simple and rate-limit-friendly; this is a
 * background indexing job, not a latency-sensitive path). `onBatch` is an
 * optional progress callback (batchIndex, totalBatches) for a progress UI.
 *
 * @param {{baseUrl:string, apiKey:string, model:string, fetchImpl?:typeof fetch, timeoutMs?:number}} cfg
 * @param {string[]} texts
 * @param {{batchSize?:number, onBatch?:(done:number, total:number)=>void}} [opts]
 * @returns {Promise<number[][]>}
 */
async function embedAll(cfg, texts, opts = {}) {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 32));
  const out = [];
  const totalBatches = Math.ceil(texts.length / batchSize);
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await embedBatch(cfg, batch);
    out.push(...embeddings);
    opts.onBatch?.(Math.floor(i / batchSize) + 1, totalBatches);
  }
  return out;
}

module.exports = { embedBatch, embedAll, DEFAULT_TIMEOUT_MS };
