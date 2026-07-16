// The exported `runReadOnlyQuery` orchestrator for the db_query feature
// (design §"Wire path" step 7), factored OUT of extension.js so it stays
// vscode-FREE and unit-testable: every vscode-backed dependency (driver
// lookup, secret read, opt-in flag, redaction) is injected. extension.js's
// activate() wires the real ones and returns the resulting function to the
// cross-extension caller.
//
// Contract (relied on by the wiring agent — lakshx-chat → this):
//   runReadOnlyQuery(engineId, sql, opts) -> Promise<{ text, isError }>
//   - opts is { maxRows?: number }
//   - ALWAYS resolves; NEVER throws across the boundary (the caller is a
//     different extension — a thrown error there would crash the relay).
"use strict";

const { clampMaxRows, formatResultText } = require("./query-guard.js");

// Only these engines have a trustworthy connection-level read-only story in
// v1 (design §10 defers MongoDB — weaker read-only guarantees).
const SUPPORTED_ENGINES = new Set(["postgres", "mysql", "sqlite"]);

/**
 * @param {object} deps
 * @param {(engineId:string)=>object} deps.getDriver          engine registry lookup
 * @param {(secretKey:string)=>Promise<string|undefined>} deps.getSecret
 * @param {(engineId:string)=>boolean|Promise<boolean>} deps.isAiQueriesAllowed
 * @param {(text:string)=>string} deps.redactText
 * @param {number} [deps.timeoutMs]
 * @returns {(engineId:string, sql:string, opts?:{maxRows?:number})=>Promise<{text:string,isError:boolean}>}
 */
function createRunReadOnlyQuery({ getDriver, getSecret, isAiQueriesAllowed, redactText, timeoutMs }) {
  const redact = typeof redactText === "function" ? redactText : (s) => s;

  return async function runReadOnlyQuery(engineId, sql, opts = {}) {
    try {
      if (!SUPPORTED_ENGINES.has(engineId)) {
        if (engineId === "mongo") {
          return { text: "MongoDB is not supported for AI queries in this version.", isError: true };
        }
        return { text: `Unknown or unsupported database engine "${String(engineId)}".`, isError: true };
      }
      if (typeof sql !== "string" || !sql.trim()) {
        return { text: "No SQL query was provided.", isError: true };
      }

      const driver = getDriver(engineId);
      const label = driver.label || engineId;

      // Opt-in gate (design §6) — checked BEFORE the secret is read, so a
      // not-allowed connection never even resolves its credentials.
      const allowed = await isAiQueriesAllowed(engineId);
      if (!allowed) {
        return {
          text:
            `The ${label} connection is not allowed for AI queries. ` +
            "Enable 'Allow AI queries' for this connection in the LakshX Database panel.",
          isError: true,
        };
      }

      const conn = await getSecret(driver.secretKey);
      if (!conn) {
        return {
          text: `No saved ${label} connection. Open the LakshX Database panel and connect first.`,
          isError: true,
        };
      }

      const maxRows = clampMaxRows(opts.maxRows);
      const result = await driver.runReadOnlyQuery(conn, sql, { maxRows, timeoutMs });

      const text = formatResultText({
        engineLabel: label,
        databaseName: result.databaseName,
        columns: result.columns || [],
        rows: result.rows || [],
        rowCount: result.rowCount ?? (result.rows ? result.rows.length : 0),
        truncated: !!result.truncated,
        maxRows,
      });
      return { text, isError: false };
    } catch (err) {
      // Every error (driver errors echo connection URIs) is redacted, and the
      // failure is returned as a clean tool error — never thrown.
      return { text: `Query failed: ${redact(String(err?.message ?? err))}`, isError: true };
    }
  };
}

module.exports = { createRunReadOnlyQuery, SUPPORTED_ENGINES };
