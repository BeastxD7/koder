/**
 * Unit tests for src/db.ts — the AGENT-SIDE half of `db_query`: pure input
 * validation/normalization only, no DB drivers, no ACP/extension round-trip.
 * These run in any environment (no browser, no network, no database).
 *
 * What's covered here is exactly what db.ts is responsible for: reject a bad
 * engine id / empty query early, and clamp maxRows into [1, 1000] with a
 * default of 50. The real safety (read-only enforcement, opt-in consent,
 * redaction) lives in lakshx-db and is NOT exercised by this harness — see
 * db-query-loop.test.ts for the loop-level routing/marshalling test, and the
 * task report for what is deliberately not round-tripped end-to-end here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampMaxRows,
  DB_DEFAULT_MAX_ROWS,
  DB_MAX_MAX_ROWS,
  DB_MIN_MAX_ROWS,
  validateDbQueryInput,
} from "../src/db.js";

test("validateDbQueryInput: accepts each supported SQL engine id", () => {
  for (const engine of ["postgres", "mysql", "sqlite"] as const) {
    const out = validateDbQueryInput({ connectionRef: engine, query: "SELECT 1" });
    assert.equal(out.connectionRef, engine);
    assert.equal(out.query, "SELECT 1");
    assert.equal(out.maxRows, DB_DEFAULT_MAX_ROWS);
  }
});

test("validateDbQueryInput: accepts mongo with a valid JSON query spec", () => {
  const q = JSON.stringify({ collection: "users", filter: { active: true }, limit: 20 });
  const out = validateDbQueryInput({ connectionRef: "mongo", query: q });
  assert.equal(out.connectionRef, "mongo");
  assert.equal(out.query, q, "the JSON string must pass through unmodified");
  assert.equal(out.maxRows, DB_DEFAULT_MAX_ROWS);
});

test("validateDbQueryInput: accepts a minimal mongo spec (collection only, no filter/limit)", () => {
  const out = validateDbQueryInput({ connectionRef: "mongo", query: '{"collection":"orders"}' });
  assert.equal(out.connectionRef, "mongo");
});

test("validateDbQueryInput: rejects a non-JSON mongo query string with a clear error", () => {
  assert.throws(
    () => validateDbQueryInput({ connectionRef: "mongo", query: "db.users.find()" }),
    /mongo.*JSON-stringified query spec.*not valid JSON/s,
  );
});

test("validateDbQueryInput: rejects a mongo query that's valid JSON but not an object", () => {
  assert.throws(
    () => validateDbQueryInput({ connectionRef: "mongo", query: "[1,2,3]" }),
    /mongo.*must be an object.*array/s,
  );
  assert.throws(
    () => validateDbQueryInput({ connectionRef: "mongo", query: '"users"' }),
    /mongo.*must be an object/s,
  );
});

test("validateDbQueryInput: rejects a mongo query object missing a \"collection\" field", () => {
  assert.throws(
    () => validateDbQueryInput({ connectionRef: "mongo", query: '{"filter":{}}' }),
    /mongo.*non-empty "collection" field/s,
  );
  assert.throws(
    () => validateDbQueryInput({ connectionRef: "mongo", query: '{"collection":""}' }),
    /mongo.*non-empty "collection" field/s,
  );
  assert.throws(
    () => validateDbQueryInput({ connectionRef: "mongo", query: '{"collection":42}' }),
    /mongo.*non-empty "collection" field/s,
  );
});

test("validateDbQueryInput: mongo query-spec shape check does NOT itself enforce the filter allowlist", () => {
  // The update-operator/filter guard lives in lakshx-db's query-guard.js
  // (parseMongoQuerySpec), not here — this file only checks the shallow
  // {collection, ...} shape. A spec with a mutating operator in its filter
  // still passes THIS layer; it is rejected one layer deeper.
  const q = JSON.stringify({ collection: "users", filter: { $set: { admin: true } } });
  const out = validateDbQueryInput({ connectionRef: "mongo", query: q });
  assert.equal(out.query, q);
});

test("validateDbQueryInput: preserves the exact query string (no LIMIT rewriting here)", () => {
  const q = "WITH x AS (SELECT * FROM t) SELECT * FROM x";
  const out = validateDbQueryInput({ connectionRef: "postgres", query: q, maxRows: 10 });
  assert.equal(out.query, q, "db.ts must not mutate the SQL — row capping is lakshx-db's job");
  assert.equal(out.maxRows, 10);
});

test("validateDbQueryInput: rejects an unsupported engine (e.g. oracle) with an actionable message", () => {
  assert.throws(
    () => validateDbQueryInput({ connectionRef: "oracle" as any, query: "SELECT 1" }),
    /connectionRef .* not a supported database.*postgres, mysql, sqlite, mongo/s,
  );
});

test("validateDbQueryInput: rejects a missing/blank connectionRef", () => {
  assert.throws(() => validateDbQueryInput({ query: "SELECT 1" }), /connectionRef/);
  assert.throws(() => validateDbQueryInput({ connectionRef: "", query: "SELECT 1" }), /connectionRef/);
  assert.throws(() => validateDbQueryInput({ connectionRef: 42 as any, query: "SELECT 1" }), /connectionRef/);
});

test("validateDbQueryInput: rejects an empty / whitespace-only / non-string query", () => {
  assert.throws(() => validateDbQueryInput({ connectionRef: "postgres", query: "" }), /non-empty SQL string/);
  assert.throws(() => validateDbQueryInput({ connectionRef: "postgres", query: "   \n\t " }), /non-empty SQL string/);
  assert.throws(() => validateDbQueryInput({ connectionRef: "postgres" }), /non-empty SQL string/);
  assert.throws(() => validateDbQueryInput({ connectionRef: "postgres", query: 123 as any }), /non-empty SQL string/);
});

test("validateDbQueryInput: defaults maxRows to 50 when absent or non-finite", () => {
  assert.equal(validateDbQueryInput({ connectionRef: "sqlite", query: "SELECT 1" }).maxRows, 50);
  assert.equal(validateDbQueryInput({ connectionRef: "sqlite", query: "SELECT 1", maxRows: NaN }).maxRows, 50);
  assert.equal(
    validateDbQueryInput({ connectionRef: "sqlite", query: "SELECT 1", maxRows: "not a number" as any }).maxRows,
    50,
  );
});

test("validateDbQueryInput: clamps maxRows into [1, 1000] and floors fractionals", () => {
  assert.equal(validateDbQueryInput({ connectionRef: "mysql", query: "SELECT 1", maxRows: 0 }).maxRows, 1);
  assert.equal(validateDbQueryInput({ connectionRef: "mysql", query: "SELECT 1", maxRows: -5 }).maxRows, 1);
  assert.equal(validateDbQueryInput({ connectionRef: "mysql", query: "SELECT 1", maxRows: 99999 }).maxRows, 1000);
  assert.equal(validateDbQueryInput({ connectionRef: "mysql", query: "SELECT 1", maxRows: 7.9 }).maxRows, 7);
});

test("clampMaxRows: boundary values and the default", () => {
  assert.equal(clampMaxRows(undefined), DB_DEFAULT_MAX_ROWS);
  assert.equal(clampMaxRows(DB_MIN_MAX_ROWS), DB_MIN_MAX_ROWS);
  assert.equal(clampMaxRows(DB_MAX_MAX_ROWS), DB_MAX_MAX_ROWS);
  assert.equal(clampMaxRows(DB_MIN_MAX_ROWS - 1), DB_MIN_MAX_ROWS);
  assert.equal(clampMaxRows(DB_MAX_MAX_ROWS + 1), DB_MAX_MAX_ROWS);
  assert.equal(clampMaxRows(Infinity), DB_DEFAULT_MAX_ROWS);
  assert.equal(clampMaxRows("250"), 250); // numeric strings coerce, then clamp
});
