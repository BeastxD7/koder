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

test("validateDbQueryInput: accepts each supported engine id", () => {
  for (const engine of ["postgres", "mysql", "sqlite"] as const) {
    const out = validateDbQueryInput({ connectionRef: engine, query: "SELECT 1" });
    assert.equal(out.connectionRef, engine);
    assert.equal(out.query, "SELECT 1");
    assert.equal(out.maxRows, DB_DEFAULT_MAX_ROWS);
  }
});

test("validateDbQueryInput: preserves the exact query string (no LIMIT rewriting here)", () => {
  const q = "WITH x AS (SELECT * FROM t) SELECT * FROM x";
  const out = validateDbQueryInput({ connectionRef: "postgres", query: q, maxRows: 10 });
  assert.equal(out.query, q, "db.ts must not mutate the SQL — row capping is lakshx-db's job");
  assert.equal(out.maxRows, 10);
});

test("validateDbQueryInput: rejects an unsupported engine (mongo) with an actionable message", () => {
  assert.throws(
    () => validateDbQueryInput({ connectionRef: "mongo", query: "SELECT 1" }),
    /connectionRef .* not a supported database.*postgres, mysql, sqlite/s,
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
