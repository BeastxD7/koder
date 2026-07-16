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
}) {
  const n = typeof rowCount === "number" ? rowCount : rows.length;
  const header =
    `Connection: ${engineLabel || "database"}` +
    (databaseName ? ` — ${databaseName}` : "") +
    "  (read-only transaction, rolled back)";
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
};
