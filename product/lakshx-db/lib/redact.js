// Strips credentials out of a MongoDB connection string before it's ever
// allowed near an output channel, error message, or thrown Error — see
// extension.js, which routes every log/error/telemetry-ish string through
// this first. Never assume a caller remembered to redact; call this at the
// point of writing to the log, not at the point of receiving the string.
"use strict";

// mongodb:// or mongodb+srv://, then userinfo (anything up to the first
// unescaped "@"), then the rest of the URI (host(s)/db/options).
const CONNECTION_STRING_RE = /^(mongodb(?:\+srv)?:\/\/)([^/?#]*)@/i;

/** Redacts the userinfo portion of a MongoDB connection string, if present.
 * `mongodb://alice:s3cr3t@host/db` -> `mongodb://***:***@host/db`.
 * A URI with no embedded credentials (e.g. relying on an external auth
 * mechanism) is returned unchanged. Non-connection-string input is passed
 * through as-is (nothing to redact). */
function redactConnectionString(input) {
  if (typeof input !== "string") return input;
  return input.replace(CONNECTION_STRING_RE, (_match, scheme, userinfo) => {
    return userinfo.includes(":") ? `${scheme}***:***@` : `${scheme}***@`;
  });
}

/** Redacts any connection strings found embedded inside an arbitrary
 * string/Error message (driver errors frequently echo the full URI back). */
function redactText(text) {
  if (typeof text !== "string") return text;
  return text.replace(/mongodb(?:\+srv)?:\/\/[^\s"']*/gi, (m) => redactConnectionString(m));
}

module.exports = { redactConnectionString, redactText };
