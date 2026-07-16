// PostgreSQL driver for the LakshX Database panel. Unlike the Mongo driver,
// nothing here is inferred: tables/columns come from information_schema and
// foreign keys from pg_catalog's pg_constraint — the engine ENFORCES these,
// so the payload is marked authoritative and the diagram uses solid FK
// edges (see lib/sql-common.js and lib/mermaid.js's buildSqlErDiagram).
//
// Privacy note: only catalog tables are queried. No SELECT ever touches a
// user table — the schema is authoritative, so no data sampling is needed
// (or wanted).
//
// No vscode import — see lib/drivers/mongo.js header for why.
"use strict";

const { Client } = require("pg");
const { redactText } = require("../redact.js");
const { buildSqlPayload, markForeignKeyFields } = require("../sql-common.js");
const {
  classifyStatement,
  isWrappable,
  wrapWithRowLimit,
  clampMaxRows,
  DEFAULT_TIMEOUT_MS,
} = require("../query-guard.js");

// The database is fixed by the connection (Postgres can't switch databases
// on a live connection), so introspection covers every schema on the
// current search path's visibility EXCEPT the system ones. Tables in the
// default "public" schema display bare; anything else displays
// schema-qualified ("audit.events").
const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema')";

const TABLES_SQL = `
  SELECT table_schema, table_name
  FROM information_schema.tables
  WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ${SYSTEM_SCHEMAS}`;

const COLUMNS_SQL = `
  SELECT table_schema, table_name, column_name, data_type, is_nullable, ordinal_position
  FROM information_schema.columns
  WHERE table_schema NOT IN ${SYSTEM_SCHEMAS}
  ORDER BY table_schema, table_name, ordinal_position`;

const PK_SQL = `
  SELECT tc.table_schema, tc.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name
   AND kcu.constraint_schema = tc.constraint_schema
  WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema NOT IN ${SYSTEM_SCHEMAS}`;

// pg_catalog rather than information_schema for FKs: constraint_column_usage
// loses the column PAIRING for multi-column foreign keys, while
// unnest(conkey, confkey) WITH ORDINALITY preserves it exactly.
const FK_SQL = `
  SELECT ns1.nspname AS from_schema, c1.relname AS from_table, a1.attname AS from_column,
         ns2.nspname AS to_schema,   c2.relname AS to_table,   a2.attname AS to_column
  FROM pg_constraint ct
  JOIN pg_class c1      ON c1.oid  = ct.conrelid
  JOIN pg_namespace ns1 ON ns1.oid = c1.relnamespace
  JOIN pg_class c2      ON c2.oid  = ct.confrelid
  JOIN pg_namespace ns2 ON ns2.oid = c2.relnamespace
  CROSS JOIN LATERAL unnest(ct.conkey, ct.confkey) WITH ORDINALITY AS cols(from_attnum, to_attnum, ord)
  JOIN pg_attribute a1  ON a1.attrelid = ct.conrelid  AND a1.attnum = cols.from_attnum
  JOIN pg_attribute a2  ON a2.attrelid = ct.confrelid AND a2.attnum = cols.to_attnum
  WHERE ct.contype = 'f' AND ns1.nspname NOT IN ${SYSTEM_SCHEMAS}`;

function displayName(schema, table) {
  return schema === "public" ? table : `${schema}.${table}`;
}

/** Pure mapping from raw catalog query rows to the normalized shape
 * sql-common.js consumes. Exported for unit tests (mock rows, no server). */
function mapPostgresIntrospection({ tableRows, columnRows, pkRows, fkRows }) {
  const tablesByName = new Map();
  for (const row of tableRows) {
    const name = displayName(row.table_schema, row.table_name);
    tablesByName.set(name, { name, fields: [] });
  }

  const pkSet = new Set(pkRows.map((r) => `${displayName(r.table_schema, r.table_name)} ${r.column_name}`));

  for (const row of columnRows) {
    const table = tablesByName.get(displayName(row.table_schema, row.table_name));
    if (!table) continue; // column of a view or of a table filtered out above
    table.fields.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
      pk: pkSet.has(`${table.name} ${row.column_name}`),
      fk: false, // filled in by markForeignKeyFields below
    });
  }

  const relationships = [];
  const seen = new Set();
  for (const row of fkRows) {
    const from = displayName(row.from_schema, row.from_table);
    const to = displayName(row.to_schema, row.to_table);
    if (!tablesByName.has(from) || !tablesByName.has(to)) continue;
    const key = `${from} ${row.from_column} ${to} ${row.to_column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relationships.push({ from, fromField: row.from_column, to, toField: row.to_column, kind: "fk" });
  }

  const tables = markForeignKeyFields([...tablesByName.values()], relationships);
  return { tables, relationships };
}

/** Returns null on success, or a redacted error message on failure. */
async function testConnection(uri) {
  const client = new Client({ connectionString: uri, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return null;
  } catch (err) {
    return redactText(String(err?.message ?? err));
  } finally {
    await client.end().catch(() => {});
  }
}

async function connect(uri) {
  const client = new Client({ connectionString: uri, connectionTimeoutMillis: 8000 });
  await client.connect();
  return client;
}

async function close(client) {
  await client?.end().catch(() => {});
}

/** Postgres connections are pinned to one database — no picker needed. */
async function resolveDatabase(client) {
  const { rows } = await client.query("SELECT current_database() AS db");
  return rows[0].db;
}

async function introspect(client, dbName) {
  const [tables, columns, pks, fks] = [
    await client.query(TABLES_SQL),
    await client.query(COLUMNS_SQL),
    await client.query(PK_SQL),
    await client.query(FK_SQL),
  ];
  const { tables: mapped, relationships } = mapPostgresIntrospection({
    tableRows: tables.rows,
    columnRows: columns.rows,
    pkRows: pks.rows,
    fkRows: fks.rows,
  });
  return buildSqlPayload({
    engine: "postgres",
    engineLabel: "PostgreSQL",
    databaseName: dbName,
    tables: mapped,
    relationships,
  });
}

// ---- read-only ad-hoc query (db_query feature; design §3/§4) --------------
//
// Layer 1 (PRIMARY): `BEGIN TRANSACTION READ ONLY` — Postgres rejects any
// write inside a read-only transaction with 25006 (read_only_sql_transaction),
// including writes reached through a CTE or a volatile function. This rests on
// the Postgres docs / SET TRANSACTION semantics; it is NOT verified against a
// live server here (no local Postgres was reachable during development).
// Layer 3 (row cap): wrap the query in a subquery with LIMIT maxRows+1.
// Layer 4 (timeout): SET LOCAL statement_timeout, scoped to this transaction.
// A FRESH connection is opened per call — the introspection handle is never
// reused — and the transaction is ALWAYS rolled back in `finally`.

/** Runs the read-only transaction against an already-connected client.
 * Split out (and exported) so it can be unit-tested with a fake client that
 * records the exact command sequence, without a live Postgres. */
async function runReadOnlyWithClient(client, sql, { maxRows, timeoutMs, kind }) {
  let inTxn = false;
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    inTxn = true;
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);

    const dbRes = await client.query("SELECT current_database() AS db");
    const databaseName = dbRes?.rows?.[0]?.db;

    const finalSql = isWrappable(kind) ? wrapWithRowLimit(sql, maxRows + 1) : sql;
    // rowMode:"array" so we return positional rows[][] regardless of duplicate
    // column names; `fields` still carries the (aliased) column names.
    const res = await client.query({ text: finalSql, rowMode: "array" });

    const columns = (res.fields || []).map((f) => f.name);
    let rows = res.rows || [];
    let truncated = false;
    if (rows.length > maxRows) {
      truncated = true;
      rows = rows.slice(0, maxRows);
    }
    return { columns, rows, rowCount: rows.length, truncated, databaseName };
  } finally {
    if (inTxn) await client.query("ROLLBACK").catch(() => {});
  }
}

/** Opens a fresh connection and runs `sql` read-only. `conn` is the
 * connection URI (the stored secret), NOT a live handle. */
async function runReadOnlyQuery(conn, sql, opts = {}) {
  const maxRows = clampMaxRows(opts.maxRows);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { kind } = classifyStatement(sql); // throws QueryRejectedError (allowlist) before opening anything

  const client = new Client({ connectionString: conn, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    return await runReadOnlyWithClient(client, sql, { maxRows, timeoutMs, kind });
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = {
  id: "postgres",
  label: "PostgreSQL",
  connectionKind: "uri",
  secretKey: "lakshx.db.postgres.connectionString",
  prompt: {
    title: "LakshX Database: PostgreSQL Connection String",
    example: "postgres://user:password@host:5432/mydb (postgresql:// also works)",
    placeHolder: "postgres://localhost:5432/mydb",
    schemeError: "Must start with postgres:// or postgresql://",
    schemeRe: /^postgres(ql)?:\/\//i,
  },
  testConnection,
  connect,
  close,
  resolveDatabase,
  introspect,
  runReadOnlyQuery,
  // exported for unit tests
  mapPostgresIntrospection,
  runReadOnlyWithClient,
};
