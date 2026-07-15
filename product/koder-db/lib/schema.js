// Pure, dependency-free schema INFERENCE for a bounded sample of MongoDB
// documents. There is nothing authoritative here — Mongo has no schema
// enforcement, so this is a best-effort shape merged across a sample, not a
// real schema. Every caller (extension.js, the webview) must keep saying so
// out loud in the UI; see mermaid.js's banner text and extension.js's
// "N sampled documents" copy.
//
// Deliberately duck-types BSON values via `_bsontype` (the property every
// bson class — ObjectId, Decimal128, Long, Binary, DBRef, ... — carries)
// instead of `instanceof`-checking against the `mongodb`/`bson` packages.
// That keeps this module runnable and unit-testable with plain object
// fixtures, no live driver or network required.
"use strict";

const BSON_TYPE_LABELS = {
  ObjectId: "ObjectId",
  ObjectID: "ObjectId", // older bson releases spelled it this way
  Decimal128: "Decimal128",
  Long: "Long",
  Double: "Double",
  Int32: "Int32",
  Binary: "Binary",
  Timestamp: "Timestamp",
  MinKey: "MinKey",
  MaxKey: "MaxKey",
  BSONRegExp: "RegExp",
  BSONSymbol: "Symbol",
  Code: "Code",
  DBRef: "DBRef",
};

/** Best-effort type label for a single sampled value. Never throws. */
function bsonTypeLabel(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  const t = typeof value;
  if (t === "object") {
    const tag = value._bsontype && BSON_TYPE_LABELS[value._bsontype];
    if (tag) return tag;
    return "object";
  }
  return t; // string | number | boolean | bigint | function (functions won't occur in real docs)
}

/** True if `value` looks like a DBRef — either a real bson DBRef instance or
 * a hand-rolled manual reference of the classic `{ $ref, $id }` shape that
 * predates/parallels DBRef. Both count as a "manual reference," per the
 * research plan's carve-out for Mongo relationships. */
function isManualRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value._bsontype === "DBRef") return true;
  return typeof value.$ref === "string" && "$id" in value;
}

/** Normalizes a DBRef-shaped value to { collection, id }. */
function readManualRef(value) {
  if (value._bsontype === "DBRef") return { collection: value.collection, id: value.oid };
  return { collection: value.$ref, id: value.$id };
}

function newFieldEntry() {
  return { types: new Map(), count: 0, refs: new Set() };
}

/** Merges one document's top-level fields into `fieldMap` (name -> entry). */
function mergeDocument(fieldMap, doc) {
  if (!doc || typeof doc !== "object") return;
  for (const [key, value] of Object.entries(doc)) {
    let entry = fieldMap.get(key);
    if (!entry) {
      entry = newFieldEntry();
      fieldMap.set(key, entry);
    }
    entry.count++;
    const label = bsonTypeLabel(value);
    entry.types.set(label, (entry.types.get(label) || 0) + 1);
    if (isManualRef(value)) {
      const ref = readManualRef(value);
      if (ref.collection) entry.refs.add(ref.collection);
    } else if (label === "array" && value.length > 0) {
      // Array of manual refs (e.g. `attendees: [{ $ref: "users", $id }]`)
      for (const el of value) {
        if (isManualRef(el)) {
          const ref = readManualRef(el);
          if (ref.collection) entry.refs.add(ref.collection);
        }
      }
    }
  }
}

/**
 * Infers a best-effort shape for one collection from a bounded sample of
 * documents. Caps at `limit` (default 100) regardless of how many docs are
 * passed in, so a caller can hand this the full cursor batch without
 * re-implementing the cap.
 *
 * Returns { sampledCount, totalTypesSeen, fields: [{ name, types, presentIn,
 * optional, isPrimaryKey, refCollections }] }, fields sorted by descending
 * presence (most-common fields first) then name.
 */
function inferCollectionSchema(sampleDocs, { limit = 100 } = {}) {
  const docs = Array.isArray(sampleDocs) ? sampleDocs.slice(0, limit) : [];
  const fieldMap = new Map();
  for (const doc of docs) mergeDocument(fieldMap, doc);

  const fields = [...fieldMap.entries()]
    .map(([name, entry]) => {
      const types = [...entry.types.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
      return {
        name,
        types,
        presentIn: entry.count,
        optional: docs.length > 0 && entry.count < docs.length,
        isPrimaryKey: name === "_id",
        refCollections: [...entry.refs],
      };
    })
    .sort((a, b) => (b.presentIn - a.presentIn) || a.name.localeCompare(b.name));

  return { sampledCount: docs.length, fields };
}

module.exports = { bsonTypeLabel, isManualRef, readManualRef, inferCollectionSchema };
