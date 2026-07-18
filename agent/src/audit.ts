/**
 * Append-only audit log for Royal mode.
 *
 * Royal mode bypasses `floorCheck()` and `onPermission` entirely (see
 * `loop.ts`) — this is the other half of the passive safety net that makes
 * that acceptable: a record of every tool call Royal made, written outside
 * the workspace so Royal's own file tools can't reach it (and, belt-and-
 * suspenders, `royalTamperCheck()` in `floor.ts` blocks writes/deletes aimed
 * at this directory even though nothing else is blocked in royal mode).
 *
 * Format: one JSON object per line (JSONL), one file per calendar month —
 * `~/.lakshx/royal-audit/<yyyy-mm>.jsonl` — mirroring the exact convention
 * `product/lakshx-chat/extension.js`'s local feedback log already uses for
 * `~/.lakshx/feedback/<yyyy-mm>.jsonl`, so this isn't a new pattern in the
 * product. Append-only: opened in append mode only, never truncated or
 * rewritten by the harness.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scrubSecrets } from "./context.js";

export interface RoyalAuditEntry {
  ts: string;
  tool: string;
  /** Scrubbed, size-capped JSON of the tool's input — never the raw object, so a stray secret in a command string doesn't land in a plaintext file outside the workspace. */
  input: string;
  cwd: string;
  decision: "allowed" | "blocked";
  reason?: string;
  checkpointSha?: string | null;
  outputSummary?: string;
  isError?: boolean;
  durationMs?: number;
}

function auditDir(): string {
  const dir = join(homedir(), ".lakshx", "royal-audit");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function auditFile(date = new Date()): string {
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  return join(auditDir(), `${ym}.jsonl`);
}

/** Scrub secrets and cap length — shared by the `input` and `outputSummary` fields. */
export function summarizeText(text: string, max = 500): string {
  const scrubbed = scrubSecrets(text);
  return scrubbed.length > max ? scrubbed.slice(0, max) + "…" : scrubbed;
}

/** Build the scrubbed, size-capped `input` field from a raw tool input object. */
export function summarizeInput(input: unknown): string {
  try {
    return summarizeText(JSON.stringify(input ?? {}));
  } catch {
    return "(unserializable input)";
  }
}

/**
 * Append one entry. Best-effort: an audit-write failure must never block a
 * Royal-mode action (Royal's whole premise is that nothing blocks) — errors
 * are swallowed, not thrown.
 */
export function logRoyalAudit(entry: Omit<RoyalAuditEntry, "ts">): RoyalAuditEntry {
  const full: RoyalAuditEntry = { ts: new Date().toISOString(), ...entry };
  try {
    appendFileSync(auditFile(), JSON.stringify(full) + "\n");
  } catch {
    // best-effort — never throw
  }
  return full;
}

/**
 * Metadata-only mirror of a `logRoyalAudit()` entry, sent to the hosted
 * `lakshx` provider's `/api/audit` endpoint (landing-page/app/api/audit/
 * route.ts) — separate from, and never in place of, the local JSONL write
 * above. Deliberately narrow: ONLY tool name, allowed/error/duration. Never
 * the scrubbed `input`, `cwd`, `reason`, `outputSummary`, or `checkpointSha`
 * — none of that leaves the machine. This function has no access to those
 * fields even if a caller wanted it to; it takes its own separate, smaller
 * parameter shape.
 *
 * Fire-and-forget and best-effort by design: called (unawaited) right next
 * to `logRoyalAudit()` at each call site, never blocking or slowing the tool
 * call it's reporting on, and never throwing into the caller.
 */
export function postAuditMetadata(
  hostedToken: string,
  auditBaseUrl: string,
  meta: { toolName: string; allowed: boolean; isError: boolean; durationMs?: number },
): void {
  const url = auditBaseUrl.replace(/\/api\/lakshx-model\/?$/, "/api/audit");
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hostedToken}` },
    body: JSON.stringify({
      toolName: meta.toolName,
      allowed: meta.allowed,
      isError: meta.isError,
      durationMs: meta.durationMs,
    }),
  }).catch(() => {
    // best-effort — never throw, never surface to the tool-call path
  });
}
