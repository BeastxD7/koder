// Shared, pure, vscode-FREE query-safety helpers for the db_query feature
// (see docs/research/13-db-query-tool.md). Everything here is unit-testable
// under `node --test` — no I/O, no driver imports, no vscode.
//
// IMPORTANT — layering (design §"Safety"): the statement allowlist below is
// the SECONDARY control, not the primary one. It is bypassable in principle
// (`SELECT volatile_writing_fn()`, `SELECT ... FOR UPDATE`, and anything the
// keyword scan doesn't know about). The PRIMARY control is the DB-enforced
// read-only transaction each driver opens (Postgres `BEGIN TRANSACTION READ
// ONLY`, MySQL `START TRANSACTION READ ONLY`, SQLite `readOnly:true` open).
// The allowlist exists only to turn the obvious mistakes into a friendly
// early error before a connection is even opened. Never treat it as the
// thing that keeps writes out — that's the transaction's job.
"use strict";

// ---- row / size caps (design §3) -------------------------------------------

const DEFAULT_MAX_ROWS = 50;
const HARD_MAX_ROWS = 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_CELL_LEN = 500; // per-cell character cap before "…"
const MAX_TEXT_LEN = 40_000; // total serialized-result cap (below the model-side clip in agent tools.ts)

/** Coerce a caller-supplied maxRows into an integer in [1, HARD_MAX_ROWS],
 * defaulting to DEFAULT_MAX_ROWS for missing/invalid input. */
function clampMaxRows(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_MAX_ROWS;
  return Math.min(v, HARD_MAX_ROWS);
}

// ---- statement allowlist (design §2, Layer 2 / SECONDARY) ------------------

/** Thrown by classifyStatement when a query is rejected by the allowlist.
 * Callers map it to a clean, user-facing tool error. */
class QueryRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueryRejectedError";
  }
}

// Write/DDL/side-effecting keywords. Scanned as whole words against a
// "skeleton" of the query that has had comments AND string/identifier
// literals removed first (so `WHERE note = 'please DELETE'` and a column
// named "delete" don't trip it — advisor point 3). This is what catches the
// sneaky write-in-a-CTE case: `WITH x AS (DELETE ... RETURNING *) SELECT ...`.
const FORBIDDEN_RE =
  /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|replace|merge|call|copy|attach|detach|vacuum|reindex|pragma|into)\b/i;

const LEADING_RE = /^(select|with|show|explain)\b/i;

/** Remove `-- line` and `/* block *\/` comments (replaced with a space so
 * tokens don't fuse). */
function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Remove '…'/"…"/`…` literals (with doubled-quote escapes) so a keyword or
 * `;` inside a string/identifier can't be misread as SQL structure. */
function stripStringsAndQuotedIdents(s) {
  return s
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, "``");
}

/**
 * Validate that `sql` is a single read-only statement and classify it.
 * Returns `{ kind }` where kind ∈ {"select","with","show","explain"}.
 * Throws QueryRejectedError (friendly message) on anything else.
 */
function classifyStatement(sql) {
  if (typeof sql !== "string" || !sql.trim()) {
    throw new QueryRejectedError("Empty query.");
  }
  const decommented = stripComments(sql).trim();
  const skeleton = stripStringsAndQuotedIdents(decommented);

  // Reject multi-statement input: strip one trailing `;` run, then any `;`
  // left is a second statement (stacked-statement injection).
  const withoutTrailer = skeleton.replace(/;+\s*$/, "");
  if (withoutTrailer.includes(";")) {
    throw new QueryRejectedError("Only a single statement is allowed (no ';'-separated statements).");
  }

  const leadMatch = decommented.match(LEADING_RE);
  if (!leadMatch) {
    throw new QueryRejectedError(
      "Only read-only queries are allowed: the statement must start with SELECT, WITH, SHOW, or EXPLAIN.",
    );
  }
  const kind = leadMatch[1].toLowerCase();

  if (kind === "show") {
    // Every SHOW variant is read-only in the engines we support (SHOW
    // TABLES, SHOW CREATE TABLE, SHOW VARIABLES, ...). Exempt from the
    // keyword scan so `SHOW CREATE TABLE t` isn't rejected for "CREATE".
    return { kind };
  }

  if (kind === "explain") {
    // EXPLAIN can wrap a write (`EXPLAIN DELETE ...`, `EXPLAIN ANALYZE`
    // executes it). Strip the EXPLAIN prefix and require the explained
    // statement to itself be a SELECT/WITH, then keep scanning.
    const inner = decommented
      .replace(/^explain\s*(\([^)]*\)\s*)?(analyze\s+)?(verbose\s+)?/i, "")
      .trim();
    if (!/^(select|with)\b/i.test(inner)) {
      throw new QueryRejectedError("EXPLAIN is only allowed for SELECT/WITH statements.");
    }
  }

  const forbidden = withoutTrailer.match(FORBIDDEN_RE);
  if (forbidden) {
    throw new QueryRejectedError(
      `Write/DDL statements are not allowed (found "${forbidden[1].toUpperCase()}"). Only read-only queries can run.`,
    );
  }

  return { kind };
}

/** Only SELECT/WITH can be safely wrapped in a subquery for the row cap.
 * SHOW/EXPLAIN aren't valid as `(<q>)` subqueries — those get a client-side
 * cursor cap instead. */
function isWrappable(kind) {
  return kind === "select" || kind === "with";
}

/**
 * Row cap (design §3): wrap rather than string-append LIMIT, so it survives
 * UNION / CTE / an existing inner LIMIT. Callers pass `limit = maxRows + 1`
 * so that getting limit rows back means "there were more" (truncation).
 */
function wrapWithRowLimit(sql, limit) {
  const inner = sql.replace(/;\s*$/, "");
  const n = Math.max(1, Math.floor(Number(limit)) || 1);
  return `SELECT * FROM (\n${inner}\n) AS _q LIMIT ${n}`;
}

// ---- Mongo query-spec guard (design §10, SECONDARY control) ---------------
//
// Mongo's query isn't SQL text — it's a {collection, filter, projection?,
// sort?, limit?} SPEC (see agent/src/tools.ts's db_query input_schema and
// agent/src/db.ts's shallow shape check, which runs first, agent-side).
// The PRIMARY read-only control for Mongo is STRUCTURAL, not transactional
// (Mongo has no engine-enforced read-only transaction the way Postgres/MySQL
// do — this is exactly the "weaker read-only story" design §10 originally
// deferred on): lib/drivers/mongo.js's runReadOnlyQuery only ever calls
// `.find()` — never `.aggregate()` (which could carry $out/$merge stages),
// never updateOne/deleteOne/insertOne/bulkWrite/anything else. What THIS
// guard adds is a SECONDARY, defense-in-depth check, exactly mirroring the
// SQL allowlist's role above: reject a filter containing any update-operator
// key ($set/$inc/$unset/…) or an aggregation side-effect stage name
// ($out/$merge), plus $where (arbitrary server-side JS execution — not a
// "write", but not a bounded read either). None of these keys do anything
// meaningful inside a find() filter — Mongo would error on most of them
// anyway — but rejecting them here with a friendly message, before a
// connection is even opened, is strictly better than letting a
// confused/malicious spec reach the server and surface a raw driver error.

const MONGO_MUTATING_KEYS = new Set([
  "$currentDate",
  "$inc",
  "$min",
  "$max",
  "$mul",
  "$rename",
  "$set",
  "$setOnInsert",
  "$unset",
  "$addToSet",
  "$pop",
  "$pull",
  "$pullAll",
  "$push",
  "$bit",
  "$out",
  "$merge",
  "$where",
]);

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Recursively scan a filter/sub-document (including inside $and/$or/$nor
 * arrays) for forbidden operator keys. Throws QueryRejectedError on the
 * first match found. */
function assertNoMutatingMongoOperators(value) {
  if (Array.isArray(value)) {
    for (const v of value) assertNoMutatingMongoOperators(v);
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (MONGO_MUTATING_KEYS.has(key)) {
        throw new QueryRejectedError(
          `Mongo query rejected: "${key}" is a write/update operator (or executes arbitrary code) and is not allowed in a read-only find filter.`,
        );
      }
      assertNoMutatingMongoOperators(value[key]);
    }
  }
}

/**
 * Parse + validate a Mongo query spec for db_query (design §10). Accepts
 * either the JSON string as it travels across the tool-call/ACP boundary, or
 * an already-parsed plain object (direct unit tests / same-process callers).
 * Returns a normalized `{ collection, filter, projection, sort, limit }`
 * (`filter` always an object; `projection`/`sort`/`limit` are `undefined`
 * when absent from the input). Throws QueryRejectedError with a friendly,
 * actionable message on anything invalid — never crashes on a malformed
 * model-supplied spec.
 */
function parseMongoQuerySpec(raw) {
  let spec = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) throw new QueryRejectedError("Empty Mongo query.");
    try {
      spec = JSON.parse(raw);
    } catch {
      throw new QueryRejectedError(
        'Mongo query must be JSON like {"collection":"users","filter":{"active":true},"limit":20} — the given string is not valid JSON.',
      );
    }
  }
  if (!isPlainObject(spec)) {
    throw new QueryRejectedError('Mongo query must be a JSON object with at least a "collection" field.');
  }
  if (typeof spec.collection !== "string" || !spec.collection.trim()) {
    throw new QueryRejectedError('Mongo query is missing a valid "collection" field (a non-empty string).');
  }
  if (spec.collection.startsWith("system.")) {
    throw new QueryRejectedError(`Refusing to query system collection "${spec.collection}".`);
  }

  const filter = spec.filter === undefined ? {} : spec.filter;
  if (!isPlainObject(filter)) {
    throw new QueryRejectedError('Mongo query\'s "filter" must be a JSON object.');
  }
  assertNoMutatingMongoOperators(filter);

  let projection;
  if (spec.projection !== undefined) {
    if (!isPlainObject(spec.projection)) {
      throw new QueryRejectedError('Mongo query\'s "projection" must be a JSON object.');
    }
    projection = spec.projection;
  }

  let sort;
  if (spec.sort !== undefined) {
    if (!isPlainObject(spec.sort)) {
      throw new QueryRejectedError('Mongo query\'s "sort" must be a JSON object, e.g. {"createdAt":-1}.');
    }
    sort = spec.sort;
  }

  let limit;
  if (spec.limit !== undefined) {
    const n = Number(spec.limit);
    if (!Number.isFinite(n) || n <= 0) {
      throw new QueryRejectedError('Mongo query\'s "limit" must be a positive number.');
    }
    limit = Math.floor(n);
  }

  return { collection: spec.collection.trim(), filter, projection, sort, limit };
}

// ---- result formatting (design §5) -----------------------------------------

/** Stringify a single DB cell value with a length cap. Returns
 * `{ text, clipped }`. */
function formatCell(value, maxLen = MAX_CELL_LEN) {
  let s;
  if (value === null || value === undefined) {
    return { text: "NULL", clipped: false };
  }
  if (typeof value === "bigint") {
    s = value.toString();
  } else if (value instanceof Date) {
    s = value.toISOString();
  } else if (Buffer.isBuffer(value)) {
    s = `0x${value.toString("hex")}`;
  } else if (typeof value === "object") {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  } else {
    s = String(value);
  }
  if (s.length > maxLen) {
    return { text: s.slice(0, maxLen) + "…", clipped: true };
  }
  return { text: s, clipped: false };
}

/**
 * Build the model-facing result text block (design §5): connection label +
 * db name, the "read-only, rolled back" marker, column list, the rows, and
 * explicit truncation lines. Three truncation conditions are surfaced
 * separately (row cap, per-cell clip, total-size clip) so the model is never
 * told "N of N rows" while a value was silently chopped.
 *
 * `readOnlyNote` overrides the parenthetical read-only-guarantee phrase in
 * the header — defaults to the SQL engines' phrasing ("read-only
 * transaction, rolled back"), which is inaccurate for Mongo (no engine-level
 * transaction backs its read-only guarantee); query-api.js passes a
 * Mongo-specific note instead. Every existing caller that doesn't pass this
 * gets byte-identical output to before.
 */
function formatResultText({
  engineLabel,
  databaseName,
  columns = [],
  rows = [],
  rowCount,
  truncated = false,
  maxRows = DEFAULT_MAX_ROWS,
  maxCellLen = MAX_CELL_LEN,
  maxTextLen = MAX_TEXT_LEN,
  readOnlyNote = "(read-only transaction, rolled back)",
}) {
  const n = typeof rowCount === "number" ? rowCount : rows.length;
  const header =
    `Connection: ${engineLabel || "database"}` +
    (databaseName ? ` — ${databaseName}` : "") +
    `  ${readOnlyNote}`;
  const colLine = `Columns: ${columns.length ? columns.join(", ") : "(none)"}`;
  const rowsHeader = truncated
    ? `Rows (showing first ${n}; more rows exist and were not fetched — capped at ${maxRows}):`
    : `Rows (${n} row${n === 1 ? "" : "s"}):`;

  let cellClipped = false;
  const rowLines = rows.map((row) => {
    const cells = (Array.isArray(row) ? row : [row]).map((v) => {
      const { text, clipped } = formatCell(v, maxCellLen);
      if (clipped) cellClipped = true;
      return text;
    });
    return "  " + cells.join(" | ");
  });

  const parts = [header, colLine, rowsHeader, ...rowLines];
  if (rows.length === 0) parts.push("  (no rows)");
  if (cellClipped) parts.push(`(Some cell values were truncated to ${maxCellLen} characters.)`);
  if (truncated) parts.push("(Row limit reached — narrow your query with a WHERE/LIMIT for more.)");

  let out = parts.join("\n");
  if (out.length > maxTextLen) {
    out = out.slice(0, maxTextLen) + "\n…(result text truncated to fit the size cap)…";
  }
  return out;
}

module.exports = {
  DEFAULT_MAX_ROWS,
  HARD_MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
  MAX_CELL_LEN,
  MAX_TEXT_LEN,
  clampMaxRows,
  classifyStatement,
  isWrappable,
  wrapWithRowLimit,
  formatCell,
  formatResultText,
  QueryRejectedError,
  parseMongoQuerySpec,
  assertNoMutatingMongoOperators,
  MONGO_MUTATING_KEYS,
};
