/**
 * Cleans a failed Azure OpenAI response's raw body before it is ever wrapped
 * in this proxy's own `Response.json({ error: ... })` shape.
 *
 * Why this exists even though the CLIENT (agent/src/providers/types.ts's
 * httpErrorMessage()) already sanitizes HTML bodies before display: that
 * client-side check only inspects the TOP-LEVEL response body. This route
 * used to do `Response.json({ error: \`azure ${status}: ${text}\` })` —
 * which nests Azure's raw text INSIDE a JSON string. If that raw text is
 * itself an HTML error page (e.g. a gateway/APIM layer in front of Azure
 * returning its own styled error page instead of Azure's JSON error shape),
 * the wrapping object still parses as valid top-level JSON, so the client's
 * `^<!doctype html|^<html` sniff never fires — it happily takes the
 * "structured JSON" branch and extracts the embedded HTML as if it were a
 * clean message. Nesting is exactly what defeats the client-side guard, so
 * sanitizing here is not redundant — it is the only place that can catch it.
 *
 * Azure's error text is third-party output, not something this codebase
 * controls (unlike, say, check_budget()'s reason strings, which are already
 * clean and known-good) — so this stays conservative: extract a clean
 * message ONLY from Azure/OpenAI's documented `{"error": {"message": ...}}`
 * (or a bare `{"error": "..."}`) shape, and fall back to a generic,
 * status-coded message for anything else, including plain text. The full
 * raw body is never shown to the caller, but it is not lost — call sites
 * log it in full server-side before calling this.
 */
export function cleanAzureError(status: number, rawText: string): string {
  const trimmed = rawText.trim();

  if (/^<!doctype html|^<html[\s>]/i.test(trimmed)) {
    return `azure ${status}: upstream returned an unexpected error page`;
  }

  try {
    const parsed = JSON.parse(trimmed);
    const msg =
      typeof parsed?.error === "string"
        ? parsed.error
        : typeof parsed?.error?.message === "string"
          ? parsed.error.message
          : undefined;
    if (msg) return `azure ${status}: ${msg.slice(0, 300)}`;
  } catch {
    // not JSON — fall through to the generic message below.
  }

  // Deliberately generic (not a truncated echo of the raw text, unlike the
  // client's own plain-text fallback): unlike the client, which is sanitizing
  // whatever some arbitrary provider sent for direct human reading, this is
  // the one place with the write path back to the client's transcript — bias
  // toward saying nothing over saying something unvetted.
  return `azure ${status}: request failed`;
}
