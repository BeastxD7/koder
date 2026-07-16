// Strips credentials out of a database connection string before it's ever
// allowed near an output channel, error message, or thrown Error — see
// extension.js, which routes every log/error/telemetry-ish string through
// this first. Never assume a caller remembered to redact; call this at the
// point of writing to the log, not at the point of receiving the string.
//
// Covers every URI scheme this panel can connect with: mongodb:// and
// mongodb+srv:// (MongoDB), postgres:// and postgresql:// (PostgreSQL),
// mysql:// (MySQL). SQLite has no URI — it's a local file path with no
// credentials — so there's nothing to redact for it.
"use strict";

// Alternation of every scheme we may see in a URI or an error message that
// echoes one back. Kept in ONE place so redactConnectionString and
// redactText can't drift apart (a scheme added to one but not the other
// would leak credentials through the other path).
const SCHEME_ALT = "mongodb(?:\\+srv)?|postgres(?:ql)?|mysql";

// Scheme, then userinfo (anything up to the first unescaped "@"), then the
// rest of the URI (host(s)/db/options).
const CONNECTION_STRING_RE = new RegExp(`^((?:${SCHEME_ALT}):\\/\\/)([^/?#]*)@`, "i");

// Same schemes, embedded anywhere inside a larger string (driver errors
// frequently echo the full URI back).
const EMBEDDED_URI_RE = new RegExp(`(?:${SCHEME_ALT}):\\/\\/[^\\s"']*`, "gi");

/** Redacts the userinfo portion of a database connection string, if present.
 * `postgres://alice:s3cr3t@host/db` -> `postgres://***:***@host/db`.
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
 * string/Error message. */
function redactText(text) {
  if (typeof text !== "string") return text;
  return text.replace(EMBEDDED_URI_RE, (m) => redactConnectionString(m));
}

module.exports = { redactConnectionString, redactText };
