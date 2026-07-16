/**
 * `db_query` tool — AGENT-SIDE half only (docs/research/13-db-query-tool.md).
 *
 * This module is deliberately browser.ts-shaped: it is PURE input
 * validation/normalization with NO database driver imports. The agent runtime
 * must never depend on `pg` / `mysql2` / `node:sqlite` — that would violate
 * the dependency-light single-file esbuild philosophy (the same reason
 * browser.ts uses `playwright-core`, not `playwright`) AND, more importantly,
 * would drag credentials into the least-trusted process. All real DB work —
 * opening a read-only connection, reading the per-extension secret, enforcing
 * the read-only transaction/row-cap/timeout, redacting errors — happens in the
 * `lakshx-db` VS Code extension, reached only across the ACP/cross-extension
 * boundary (see loop.ts's `onDbQuery` callback → server.ts's
 * `lakshx/db_query` request → extension.js → `runReadOnlyQuery`).
 *
 * So the ONLY safety this file provides is friendly, early, deterministic
 * input validation: reject a bad engine id / empty query before a round-trip,
 * and clamp `maxRows` into a sane band so a malformed request can't ask the
 * data owner for an unbounded result. It is NOT a security boundary — the
 * read-only enforcement and the opt-in consent gate both live inside
 * lakshx-db, precisely so royal mode (which skips floor.ts entirely) cannot
 * bypass them. See the design doc §"Consent gate" / §"Safety".
 */

/**
 * The engine ids `runReadOnlyQuery` accepts. connectionRef == engine id in v1.
 * "mongo" completes what design doc §10 originally deferred ("weaker
 * read-only story than SQL — omit in v1"): Mongo has no engine-enforced
 * read-only transaction, so its read-only guarantee is structural instead
 * (find-only, no aggregate/$out/$merge, no update operators in the filter —
 * enforced in lakshx-db's mongo driver + query-guard.js's Mongo guard, NOT
 * here). This file only validates the INPUT SHAPE (see below).
 */
export const DB_ENGINES = ["postgres", "mysql", "sqlite", "mongo"] as const;
export type DbEngine = (typeof DB_ENGINES)[number];

/** Row-cap band mirrored from the design doc (default 50, hard max 1000). */
export const DB_DEFAULT_MAX_ROWS = 50;
export const DB_MIN_MAX_ROWS = 1;
export const DB_MAX_MAX_ROWS = 1000;

/** Raw, model-supplied tool input for `db_query` (pre-validation). */
export interface DbQueryInput {
  connectionRef?: unknown;
  query?: unknown;
  maxRows?: unknown;
}

/**
 * The validated, normalized payload the loop marshals across ACP. Note
 * `maxRows` is ALWAYS a concrete number here (clamped) — the object-property
 * marshalling to `runReadOnlyQuery(engineId, query, { maxRows })` happens in
 * extension.js; this shape is what travels in the ACP request body
 * (`{sessionId, ...validated}`).
 */
export interface ValidatedDbQuery {
  connectionRef: DbEngine;
  query: string;
  maxRows: number;
}

/**
 * Validate + normalize model-supplied `db_query` input. Throws a plain Error
 * whose message is suitable for surfacing straight back to the model as a
 * clean tool-error (the loop's db_query branch catches it — see loop.ts).
 * Exported for direct unit testing without any ACP/extension round-trip.
 *
 *  - `connectionRef` must be one of DB_ENGINES (postgres/mysql/sqlite/mongo);
 *    anything else is rejected here with an actionable message rather than
 *    deferred to lakshx-db.
 *  - `query` must be a non-empty (after trim) string. For the three SQL
 *    engines this is free-form SQL text (unchanged from before). For
 *    `"mongo"` it is instead a JSON-STRINGIFIED query spec —
 *    `{"collection":"users","filter":{"active":true},"limit":20}` — because
 *    Mongo has no SQL text to validate; see `validateMongoQuerySpecShape`
 *    below for the (deliberately shallow) shape check this file performs.
 *  - `maxRows` is optional: absent/NaN → default 50; otherwise floored and
 *    clamped into [1, 1000]. Never throws on a bad maxRows — clamps instead,
 *    so a slightly-off number degrades gracefully rather than failing the call.
 */
export function validateDbQueryInput(input: DbQueryInput): ValidatedDbQuery {
  const ref = input?.connectionRef;
  if (typeof ref !== "string" || !(DB_ENGINES as readonly string[]).includes(ref)) {
    throw new Error(
      `db_query: connectionRef ${JSON.stringify(String(ref ?? ""))} is not a supported database. ` +
        `Use one of: ${DB_ENGINES.join(", ")} (reference a connection by its engine id).`,
    );
  }

  const rawQuery = input?.query;
  if (typeof rawQuery !== "string" || rawQuery.trim() === "") {
    throw new Error(
      ref === "mongo"
        ? `db_query: "query" must be a non-empty JSON query spec string (e.g. {"collection":"users","filter":{}}).`
        : `db_query: "query" must be a non-empty SQL string.`,
    );
  }

  if (ref === "mongo") {
    validateMongoQuerySpecShape(rawQuery);
  }

  return {
    connectionRef: ref as DbEngine,
    query: rawQuery,
    maxRows: clampMaxRows(input?.maxRows),
  };
}

/**
 * Mongo's `query` isn't SQL text — it's a JSON-stringified query spec
 * `{collection, filter?, projection?, sort?, limit?}`. This is intentionally
 * a SHALLOW shape check only: the string must `JSON.parse` into a plain
 * object with a non-empty string `collection` field. That's it. The DEEP
 * read-only enforcement — rejecting update-operator keys inside `filter`
 * ($set/$inc/$unset/…), running find-only (never aggregate/$out/$merge),
 * capping rows/time — lives in lakshx-db's mongo driver + query-guard.js
 * (see product/lakshx-db/lib/query-guard.js's `parseMongoQuerySpec`), same
 * layering as the SQL statement allowlist being a SECONDARY control there.
 * This just turns the obviously-wrong shapes (not JSON, not an object,
 * missing `collection`) into a fast, clean, pre-round-trip error — never a
 * crash — exactly like this file's existing SQL/engine checks.
 */
function validateMongoQuerySpecShape(rawQuery: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawQuery);
  } catch {
    throw new Error(
      `db_query: for connectionRef "mongo", "query" must be a JSON-stringified query spec like ` +
        `{"collection":"users","filter":{"active":true},"limit":20} — the given string is not valid JSON.`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `db_query: for connectionRef "mongo", the JSON "query" must be an object (with a "collection" field), ` +
        `not ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed}.`,
    );
  }

  const collection = (parsed as Record<string, unknown>).collection;
  if (typeof collection !== "string" || collection.trim() === "") {
    throw new Error(
      `db_query: for connectionRef "mongo", the JSON "query" must include a non-empty "collection" field, ` +
        `e.g. {"collection":"users","filter":{}}.`,
    );
  }
}

/**
 * Clamp a model-supplied `maxRows` into [DB_MIN_MAX_ROWS, DB_MAX_MAX_ROWS],
 * defaulting to DB_DEFAULT_MAX_ROWS when absent/non-finite. Floors fractional
 * values. Exported for unit testing the boundary behavior directly.
 */
export function clampMaxRows(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DB_DEFAULT_MAX_ROWS;
  const floored = Math.floor(n);
  if (floored < DB_MIN_MAX_ROWS) return DB_MIN_MAX_ROWS;
  if (floored > DB_MAX_MAX_ROWS) return DB_MAX_MAX_ROWS;
  return floored;
}
