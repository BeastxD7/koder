// Engine registry for the LakshX Database panel — the one place that knows
// which database engines exist and how to load their drivers.
//
// Every driver implements the same interface (all connection/introspection
// I/O behind it, zero vscode imports so `node --test` can load them):
//   id, label            — stable id + human name for the QuickPick
//   connectionKind       — "uri" (masked input box) | "file" (open dialog)
//   secretKey            — per-engine SecretStorage key, so switching
//                          engines never clobbers another engine's saved
//                          connection
//   prompt               — input-box copy + scheme validation (uri engines)
//                          or file-dialog filters (file engines)
//   testConnection(conn) — null on success | redacted error string
//   connect(conn)        — connection handle (driver-specific)
//   close(handle)
//   resolveDatabase(handle, { pick, log }) — which database to introspect;
//                          `pick(candidates)` is the caller's chooser UI
//   introspect(handle, dbName) — the webview payload (see lib/sql-common.js
//                          for the SQL shape; drivers/mongo.js for Mongo's)
//
// Drivers are loaded LAZILY: requiring this registry must not drag in the
// mongodb/pg/mysql2 packages for engines the user never picks.
"use strict";

const ENGINES = [
  { id: "mongo", label: "MongoDB", description: "Schema inferred from sampled documents; relationships are suggestions" },
  { id: "postgres", label: "PostgreSQL", description: "Schema and foreign keys read from information_schema / pg_catalog" },
  { id: "mysql", label: "MySQL", description: "Schema and foreign keys read from information_schema" },
  { id: "sqlite", label: "SQLite", description: "Local .db/.sqlite file, opened read-only" },
];

function listEngines() {
  return ENGINES;
}

function getDriver(engineId) {
  switch (engineId) {
    case "mongo":
      return require("./drivers/mongo.js");
    case "postgres":
      return require("./drivers/postgres.js");
    case "mysql":
      return require("./drivers/mysql.js");
    case "sqlite":
      return require("./drivers/sqlite.js");
    default:
      throw new Error(`Unknown database engine: ${engineId}`);
  }
}

module.exports = { listEngines, getDriver };
