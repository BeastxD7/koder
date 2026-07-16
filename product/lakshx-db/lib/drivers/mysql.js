// MySQL driver for the LakshX Database panel. Same authoritative story as
// the Postgres driver: tables/columns/PKs/FKs come straight from
// information_schema, which MySQL enforces — so solid FK edges, no
// sampling, and no SELECT ever touching a user table.
//
// No vscode import — see lib/drivers/mongo.js header for why.
"use strict";

const mysql = require("mysql2/promise");
const { redactText } = require("../redact.js");
const { buildSqlPayload, markForeignKeyFields } = require("../sql-common.js");
const {
  classifyStatement,
  isWrappable,
  wrapWithRowLimit,
  clampMaxRows,
  DEFAULT_TIMEOUT_MS,
} = require("../query-guard.js");

// MySQL's built-in schemas — filtered out of the database picker, same idea
// as the Mongo driver's SYSTEM_DB_NAMES.
const SYSTEM_SCHEMAS = new Set(["mysql", "information_schema", "performance_schema", "sys"]);

// Lowercase aliases everywhere: MySQL 8 returns information_schema columns
// as uppercase keys (TABLE_NAME) unless aliased, and the mapper below wants
// one stable casing.
const TABLES_SQL = `
  SELECT table_name AS table_name
  FROM information_schema.tables
  WHERE table_schema = ? AND table_type = 'BASE TABLE'`;

const COLUMNS_SQL = `
  SELECT table_name AS table_name, column_name AS column_name, data_type AS data_type,
         is_nullable AS is_nullable, column_key AS column_key
  FROM information_schema.columns
  WHERE table_schema = ?
  ORDER BY table_name, ordinal_position`;

// referenced_table_name IS NOT NULL restricts key_column_usage to foreign
// keys (it also lists PK/unique participation otherwise). The
// referenced_table_schema filter keeps cross-database FKs out — only tables
// of the introspected database are drawn.
const FK_SQL = `
  SELECT table_name AS table_name, column_name AS column_name,
         referenced_table_name AS referenced_table_name,
         referenced_column_name AS referenced_column_name
  FROM information_schema.key_column_usage
  WHERE table_schema = ? AND referenced_table_name IS NOT NULL AND referenced_table_schema = ?`;

/** Pure mapping from information_schema rows to the normalized shape
 * sql-common.js consumes. Exported for unit tests (mock rows, no server). */
function mapMysqlIntrospection({ tableRows, columnRows, fkRows }) {
  const tablesByName = new Map();
  for (const row of tableRows) {
    tablesByName.set(row.table_name, { name: row.table_name, fields: [] });
  }

  for (const row of columnRows) {
    const table = tablesByName.get(row.table_name);
    if (!table) continue; // a view's column
    table.fields.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
      pk: row.column_key === "PRI",
      fk: false, // filled in by markForeignKeyFields below
    });
  }

  const relationships = [];
  const seen = new Set();
  for (const row of fkRows) {
    const from = row.table_name;
    const to = row.referenced_table_name;
    if (!tablesByName.has(from) || !tablesByName.has(to)) continue;
    const key = `${from} ${row.column_name} ${to} ${row.referenced_column_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relationships.push({ from, fromField: row.column_name, to, toField: row.referenced_column_name, kind: "fk" });
  }

  const tables = markForeignKeyFields([...tablesByName.values()], relationships);
  return { tables, relationships };
}

/** Returns null on success, or a redacted error message on failure. */
async function testConnection(uri) {
  let conn = null;
  try {
    conn = await mysql.createConnection({ uri, connectTimeout: 8000 });
    await conn.query("SELECT 1");
    return null;
  } catch (err) {
    return redactText(String(err?.message ?? err));
  } finally {
    await conn?.end().catch(() => {});
  }
}

async function connect(uri) {
  return mysql.createConnection({ uri, connectTimeout: 8000 });
}

async function close(conn) {
  await conn?.end().catch(() => {});
}

/** The database named in the URI wins; otherwise list non-system schemas and
 * let the caller's picker choose — same shape as the Mongo driver's
 * resolveDatabase. */
async function resolveDatabase(conn, { pick } = {}) {
  if (conn.config?.database) return conn.config.database;

  const [rows] = await conn.query(
    "SELECT schema_name AS schema_name FROM information_schema.schemata ORDER BY schema_name",
  );
  const candidates = rows.map((r) => r.schema_name).filter((n) => !SYSTEM_SCHEMAS.has(n));
  if (candidates.length === 0) {
    throw new Error("No user databases are visible on this connection. Add /yourDbName to the connection string.");
  }
  if (candidates.length === 1) return candidates[0];

  const picked = await pick(candidates);
  if (!picked) throw new Error("No database selected.");
  return picked;
}

async function introspect(conn, dbName) {
  const [tableRows] = await conn.query(TABLES_SQL, [dbName]);
  const [columnRows] = await conn.query(COLUMNS_SQL, [dbName]);
  const [fkRows] = await conn.query(FK_SQL, [dbName, dbName]);

  const { tables, relationships } = mapMysqlIntrospection({ tableRows, columnRows, fkRows });
  return buildSqlPayload({
    engine: "mysql",
    engineLabel: "MySQL",
    databaseName: dbName,
    tables,
    relationships,
  });
}

// ---- read-only ad-hoc query (db_query feature; design §3/§4) --------------
//
// Layer 1 (PRIMARY): `START TRANSACTION READ ONLY` — MySQL/InnoDB rejects
// writes inside a read-only transaction (ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION,
// 1792). Rests on the MySQL docs; NOT verified against a live server here (no
// local MySQL was reachable during development). Layer 3: subquery wrap with
// LIMIT maxRows+1. Layer 4: session `max_execution_time` (applies to SELECT).
// Fresh connection per call; always rolled back in `finally`.

/** Runs the read-only transaction against an already-connected connection.
 * Exported so it can be unit-tested with a fake connection that records the
 * command sequence, without a live MySQL. */
async function runReadOnlyWithConnection(conn, sql, { maxRows, timeoutMs, kind }) {
  let inTxn = false;
  try {
    await conn.query("START TRANSACTION READ ONLY");
    inTxn = true;
    await conn.query(`SET SESSION max_execution_time = ${Math.floor(timeoutMs)}`);

    const [dbRows] = await conn.query("SELECT DATABASE() AS db");
    const databaseName = dbRows?.[0]?.db;

    const finalSql = isWrappable(kind) ? wrapWithRowLimit(sql, maxRows + 1) : sql;
    // rowsAsArray so duplicate column names don't collapse; `fields` carries names.
    const [rawRows, fields] = await conn.query({ sql: finalSql, rowsAsArray: true });

    const columns = (fields || []).map((f) => f.name);
    let rows = Array.isArray(rawRows) ? rawRows : [];
    let truncated = false;
    if (rows.length > maxRows) {
      truncated = true;
      rows = rows.slice(0, maxRows);
    }
    return { columns, rows, rowCount: rows.length, truncated, databaseName };
  } finally {
    if (inTxn) await conn.query("ROLLBACK").catch(() => {});
  }
}

/** Opens a fresh connection and runs `sql` read-only. `conn` is the
 * connection URI (the stored secret), NOT a live handle. */
async function runReadOnlyQuery(connString, sql, opts = {}) {
  const maxRows = clampMaxRows(opts.maxRows);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { kind } = classifyStatement(sql); // throws QueryRejectedError (allowlist) before opening anything

  const conn = await mysql.createConnection({ uri: connString, connectTimeout: 8000 });
  try {
    return await runReadOnlyWithConnection(conn, sql, { maxRows, timeoutMs, kind });
  } finally {
    await conn.end().catch(() => {});
  }
}

module.exports = {
  id: "mysql",
  label: "MySQL",
  connectionKind: "uri",
  secretKey: "lakshx.db.mysql.connectionString",
  prompt: {
    title: "LakshX Database: MySQL Connection String",
    example: "mysql://user:password@host:3306/mydb",
    placeHolder: "mysql://localhost:3306/mydb",
    schemeError: "Must start with mysql://",
    schemeRe: /^mysql:\/\//i,
  },
  testConnection,
  connect,
  close,
  resolveDatabase,
  introspect,
  runReadOnlyQuery,
  // exported for unit tests
  mapMysqlIntrospection,
  runReadOnlyWithConnection,
};
