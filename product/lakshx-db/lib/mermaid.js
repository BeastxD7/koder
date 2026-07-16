// Builds a Mermaid `erDiagram` source string from inferred MongoDB
// collection schemas + suggested relationships. This module is pure text
// generation — no rendering happens here (that's media/db.js, in the
// webview, using the vendored mermaid.min.js).
//
// Deliberate visual-confidence rule (per the research plan's Mongo
// carve-out): suggested relationships render as a DASHED, non-identifying
// edge (`|o..o{`) and are NEVER annotated with an "FK" attribute key —
// that annotation is reserved for engines with a real, enforced foreign
// key. A relational engine's panel would use a SOLID identifying edge
// (`||--o{`) with real "FK" keys; Mongo can never earn either, because
// nothing here was verified against a constraint.
"use strict";

// erDiagram entity/attribute tokens are whitespace-delimited and choke on
// quotes/backticks/newlines — strip those defensively since collection and
// field names come from live, untrusted database content, not source code.
function sanitizeToken(name) {
  const cleaned = String(name).replace(/[`"'\n\r]/g, "").replace(/\s+/g, "_").trim();
  return cleaned.length > 0 ? cleaned : "_";
}

function sanitizeComment(text) {
  return String(text).replace(/[`"\n\r]/g, "").slice(0, 200);
}

// Mermaid entity identifiers must be stable, unique, and safe as a bare
// token — collapse anything non [A-Za-z0-9_] to "_" and disambiguate
// collisions (e.g. two collections that only differ by punctuation).
function makeEntityIdFactory() {
  const used = new Map(); // sanitizedBase -> count
  return (rawName) => {
    let base = String(rawName).replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z_]/.test(base)) base = `_${base}`;
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base}_${count}`;
  };
}

// A field can carry several observed types across the sample (e.g. mostly
// "string" but "null" in a few docs). Mermaid's attribute type slot is a
// single bare token, so collapse to the dominant type and fold the rest
// into the trailing comment instead of losing the information.
function attributeTypeToken(field) {
  const [dominant] = field.types;
  return sanitizeToken(dominant || "mixed");
}

function attributeComment(field, sampledCount) {
  const parts = [];
  if (field.types.length > 1) parts.push(`also seen: ${field.types.slice(1).join(", ")}`);
  if (field.optional) {
    const pct = sampledCount > 0 ? Math.round((field.presentIn / sampledCount) * 100) : 0;
    parts.push(`present in ${pct}% of sampled docs`);
  }
  return parts.length > 0 ? sanitizeComment(parts.join("; ")) : null;
}

/**
 * @param {Record<string, {sampledCount:number, fields:Array}>} schemasByCollection
 * @param {Array<{from:string, fromField:string, to:string, kind:string, plural:boolean, note:string}>} relationships
 * @returns {string} a complete `erDiagram ...` Mermaid source
 */
function buildErDiagram(schemasByCollection, relationships) {
  const lines = ["erDiagram"];
  const entityIdOf = makeEntityIdFactory();
  const idByCollection = new Map();
  for (const name of Object.keys(schemasByCollection)) idByCollection.set(name, entityIdOf(name));

  for (const [name, schema] of Object.entries(schemasByCollection)) {
    const entityId = idByCollection.get(name);
    lines.push(`  ${entityId} {`);
    for (const field of schema.fields) {
      const type = attributeTypeToken(field);
      const fieldName = sanitizeToken(field.name);
      const key = field.isPrimaryKey ? " PK" : "";
      const comment = attributeComment(field, schema.sampledCount);
      const commentPart = comment ? ` "${comment}"` : "";
      lines.push(`    ${type} ${fieldName}${key}${commentPart}`);
    }
    lines.push("  }");
  }

  for (const rel of relationships) {
    const fromId = idByCollection.get(rel.from);
    const toId = idByCollection.get(rel.to);
    if (!fromId || !toId) continue;
    // Always zero-or-more-to-zero-or-more, DASHED, non-identifying — the
    // loosest cardinality mermaid's erDiagram offers. We deliberately don't
    // try to claim a tighter one-to-many/one-to-one shape even when
    // `rel.plural` is false: without a real constraint to check, "exactly
    // one" would be a precision this heuristic hasn't earned. Dashed is
    // what makes this read as "unverified" rather than "constrained" —
    // see file header for why this is never solid.
    lines.push(`  ${fromId} }o..o{ ${toId} : "${sanitizeComment(rel.note)}"`);
  }

  return lines.join("\n");
}

/**
 * SQL counterpart of buildErDiagram, for engines with a REAL schema
 * (Postgres/MySQL/SQLite). This is the other half of the visual-confidence
 * rule described in the file header: an information_schema / PRAGMA foreign
 * key is an enforced constraint, so here — and only here — edges are SOLID
 * (`||--o{`) and referencing columns carry the real `FK` attribute key that
 * buildErDiagram deliberately never emits for Mongo's guesses.
 *
 * @param {Array<{name:string, fields:Array<{name:string, type:string, nullable?:boolean, pk?:boolean, fk?:boolean}>}>} tables
 * @param {Array<{from:string, fromField:string, to:string, toField:string, kind:string}>} relationships
 * @returns {string} a complete `erDiagram ...` Mermaid source
 */
function buildSqlErDiagram(tables, relationships) {
  const lines = ["erDiagram"];
  const entityIdOf = makeEntityIdFactory();
  const idByTable = new Map();
  for (const t of tables) idByTable.set(t.name, entityIdOf(t.name));

  for (const table of tables) {
    const entityId = idByTable.get(table.name);
    lines.push(`  ${entityId} {`);
    for (const field of table.fields) {
      const type = sanitizeToken(field.type || "unknown");
      const fieldName = sanitizeToken(field.name);
      const keys = [];
      if (field.pk) keys.push("PK");
      if (field.fk) keys.push("FK");
      const keyPart = keys.length > 0 ? ` ${keys.join(", ")}` : "";
      const commentPart = field.nullable ? ' "nullable"' : "";
      lines.push(`    ${type} ${fieldName}${keyPart}${commentPart}`);
    }
    lines.push("  }");
  }

  for (const rel of relationships) {
    const fromId = idByTable.get(rel.from);
    const toId = idByTable.get(rel.to);
    if (!fromId || !toId) continue;
    // SOLID identifying one-to-zero-or-more edge, referenced side first —
    // the FK column is on `rel.from`, so many `from` rows point at one `to`
    // row. This cardinality is EARNED here (the engine enforces it), unlike
    // the deliberately loose dashed `}o..o{` used for Mongo suggestions.
    lines.push(`  ${toId} ||--o{ ${fromId} : "${sanitizeComment(`${rel.fromField} → ${rel.toField}`)}"`);
  }

  return lines.join("\n");
}

module.exports = { buildErDiagram, buildSqlErDiagram, sanitizeToken, sanitizeComment };
