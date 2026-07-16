// SQLite driver for the LakshX Database panel. Connection is a LOCAL FILE
// PATH (picked via a file-open dialog in extension.js — connectionKind:
// "file"), not a URI, and the database is opened READ-ONLY: this panel only
// ever inspects schema, never data.
//
// Uses Node's built-in `node:sqlite` (DatabaseSync) — no npm dependency at
// all. Verified against the actual packaged runtime this fork ships
// (Electron 42.5.0 / Node 24.17.0, where require("node:sqlite") resolves
// and DatabaseSync works): no native module (better-sqlite3 et al. would
// break cross-platform packaging) and no WASM fallback needed. The require
// stays lazy inside getSqlite() so merely loading this module (e.g. from
// the engine registry or the test runner) can't throw on an exotic runtime.
//
// Introspection is pure catalog reads: sqlite_master for the table list,
// plus the pragma table-valued functions pragma_table_info(?) and
// pragma_foreign_key_list(?) — used in SELECT form (not `PRAGMA x(name)`
// statements) so the table name can be bound as a real parameter instead of
// spliced into the SQL. FKs here are authoritative schema facts: solid
// edges, same as Postgres/MySQL.
//
// No vscode import — see lib/drivers/mongo.js header for why.
"use strict";

const path = require("path");
const { buildSqlPayload, markForeignKeyFields } = require("../sql-common.js");

function getSqlite() {
  try {
    return require("node:sqlite");
  } catch {
    throw new Error(
      "This runtime doesn't provide the built-in node:sqlite module (needs Node.js >= 22.13 in the extension host).",
    );
  }
}

const TABLES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";

/**
 * Pure mapping from raw PRAGMA-shaped rows to the normalized shape
 * sql-common.js consumes. Exported for unit tests (fixture rows, no file).
 *
 * @param {Array<{name:string, columns:Array, foreignKeys:Array}>} rawTables
 *   one entry per table: `columns` are pragma_table_info rows
 *   ({ name, type, notnull, pk, ... }), `foreignKeys` are
 *   pragma_foreign_key_list rows ({ table, from, to, ... }).
 */
function mapSqliteIntrospection(rawTables) {
  const tablesByName = new Map();
  for (const raw of rawTables) {
    tablesByName.set(raw.name, {
      name: raw.name,
      fields: raw.columns.map((col) => ({
        name: col.name,
        // A column can be declared with no type at all in SQLite ("CREATE
        // TABLE t (x)") — fall back to its BLOB affinity name.
        type: col.type && String(col.type).trim() ? String(col.type) : "blob",
        nullable: !col.notnull && !col.pk, // pk implies NOT NULL in practice (except legacy edge cases — close enough for a diagram)
        pk: col.pk > 0, // pragma reports the column's 1-based position within the PK, 0 = not part of it
        fk: false, // filled in by markForeignKeyFields below
      })),
    });
  }

  const relationships = [];
  const seen = new Set();
  for (const raw of rawTables) {
    for (const fk of raw.foreignKeys) {
      const to = fk.table;
      const target = tablesByName.get(to);
      if (!target) continue; // FK to a missing table — SQLite tolerates dangling FKs unless enforcement is on
      // pragma_foreign_key_list's `to` is NULL when the FK references the
      // target's implicit primary key — resolve it to that PK column.
      const toField = fk.to ?? target.fields.find((f) => f.pk)?.name ?? "rowid";
      const key = `${raw.name} ${fk.from} ${to} ${toField}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relationships.push({ from: raw.name, fromField: fk.from, to, toField, kind: "fk" });
    }
  }

  const tables = markForeignKeyFields([...tablesByName.values()], relationships);
  return { tables, relationships };
}

/** Opens read-only and runs a trivial catalog query — this is what actually
 * detects "that file isn't a SQLite database" (opening alone doesn't).
 * Returns null on success, or an error message on failure. (No redaction
 * needed: a file path carries no credentials.) */
async function testConnection(filePath) {
  const { DatabaseSync } = getSqlite();
  let db = null;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return null;
  } catch (err) {
    return String(err?.message ?? err);
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

async function connect(filePath) {
  const { DatabaseSync } = getSqlite();
  const db = new DatabaseSync(filePath, { readOnly: true });
  db.filePathForDisplay = filePath; // stashed for resolveDatabase below
  return db;
}

async function close(db) {
  try {
    db?.close();
  } catch {}
}

/** A SQLite "database" IS the file — display its basename. */
async function resolveDatabase(db) {
  return path.basename(db.filePathForDisplay || "database.sqlite");
}

async function introspect(db, dbName) {
  const names = db
    .prepare(TABLES_SQL)
    .all()
    .map((r) => r.name);

  const rawTables = names.map((name) => ({
    name,
    columns: db.prepare("SELECT * FROM pragma_table_info(?)").all(name),
    foreignKeys: db.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(name),
  }));

  const { tables, relationships } = mapSqliteIntrospection(rawTables);
  return buildSqlPayload({
    engine: "sqlite",
    engineLabel: "SQLite",
    databaseName: dbName,
    tables,
    relationships,
  });
}

module.exports = {
  id: "sqlite",
  label: "SQLite",
  connectionKind: "file", // extension.js opens a file dialog, not an input box
  secretKey: "lakshx.db.sqlite.path",
  prompt: {
    title: "LakshX Database: choose a SQLite file",
    // showOpenDialog filter — not a scheme regex like the URI engines
    fileFilters: { "SQLite database": ["db", "sqlite", "sqlite3", "db3"], "All files": ["*"] },
  },
  testConnection,
  connect,
  close,
  resolveDatabase,
  introspect,
  // exported for unit tests
  mapSqliteIntrospection,
};
