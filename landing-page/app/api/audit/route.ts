import { NextRequest } from "next/server";
import { supabaseAdmin } from "../../../lib/supabase/admin";

export const runtime = "nodejs";

// Fire-and-forget telemetry, not a transcript store — generous but bounded.
const MAX_BODY_BYTES = 10_000;

/**
 * Metadata-only cloud mirror of the local Royal-mode audit log (see
 * agent/src/audit.ts's logRoyalAudit() / ~/.lakshx/royal-audit/*.jsonl,
 * called from agent/src/loop.ts's postAuditMetadata()). That local log's
 * "never leaves your machine" promise is unchanged: this endpoint accepts
 * ONLY { toolName, allowed, isError, durationMs } — no scrubbed input, no
 * cwd, no output summary, no reason string. If a future caller starts
 * sending any of that, it is silently dropped here (see the explicit
 * allowlist below), not persisted.
 *
 * Auth follows the exact same pattern as /api/feedback and
 * /api/lakshx-model/*: a Supabase session access token in the Authorization
 * header, validated with auth.getUser(), then written with the service-role
 * client so RLS never has to trust the caller.
 */
export async function POST(req: NextRequest) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ error: "server misconfigured — missing SUPABASE_* env vars" }, { status: 500 });
  }

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "missing bearer token" }, { status: 401 });

  const admin = supabaseAdmin();
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return Response.json({ error: "invalid or expired session" }, { status: 401 });
  }
  const userId = userData.user.id;

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const toolName = typeof body.toolName === "string" ? body.toolName.slice(0, 200) : "";
  if (!toolName) return Response.json({ error: "toolName is required" }, { status: 400 });

  const { error: insertErr } = await admin.rpc("record_audit_event", {
    p_user_id: userId,
    p_tool_name: toolName,
    p_allowed: Boolean(body.allowed),
    p_is_error: Boolean(body.isError),
    p_duration_ms: Number.isFinite(body.durationMs) ? Math.round(body.durationMs) : null,
  });

  if (insertErr) {
    console.error("audit: record_audit_event failed", insertErr);
    return Response.json({ error: "failed to record audit event" }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
}
