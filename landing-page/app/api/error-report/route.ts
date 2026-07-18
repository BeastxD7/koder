import { NextRequest } from "next/server";
import { supabaseAdmin } from "../../../lib/supabase/admin";

export const runtime = "nodejs";

// The diagnostic report is a full session transcript dump (see
// buildDiagnosticReport() in the IDE's chat panel) so it needs far more room
// than /api/feedback's 200_000-byte ceiling, but this is still a bounded
// request body, not an arbitrary upload — reject anything pathological
// before it even reaches JSON.parse/Postgres. DB-side truncation
// (record_error_report()'s left(..., 50000) in supabase/schema.sql) is a
// backstop for what actually gets stored, not the primary size guard —
// this is.
const MAX_BODY_BYTES = 1_000_000;

function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Backend for the IDE chat panel's "Report" button on an error message (see
 * agent/src/providers/types.ts's httpErrorMessage() for why the panel itself
 * only ever shows a clean, generic message — this endpoint is where the full
 * raw detail goes instead, for an admin to inspect later, not for display
 * back to any user).
 *
 * Auth follows the exact same pattern as /api/feedback and
 * /api/lakshx-model/*: a Supabase session access token in the Authorization
 * header, validated with auth.getUser(), then written with the service-role
 * client so RLS never has to trust the caller.
 *
 * Body: { errorMessage: string, diagnosticReport?: string, model?: string,
 * mode?: string }. Kept fast/synchronous (no after()) matching /api/
 * feedback's spirit — this is a small insert, not a stream to meter.
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

  const errorMessage = s(body.errorMessage);
  if (!errorMessage) {
    return Response.json({ error: "errorMessage is required" }, { status: 400 });
  }

  const { error: insertErr } = await admin.rpc("record_error_report", {
    p_user_id: userId,
    p_error_message: errorMessage,
    p_diagnostic_report: s(body.diagnosticReport),
    p_model: s(body.model),
    p_mode: s(body.mode),
  });

  if (insertErr) {
    console.error("error-report: record_error_report failed", insertErr);
    return Response.json({ error: "failed to record error report" }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
}
