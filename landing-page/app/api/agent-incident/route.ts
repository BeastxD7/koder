import { NextRequest } from "next/server";
import { supabaseAdmin } from "../../../lib/supabase/admin";

export const runtime = "nodejs";

const VALID_INCIDENT_TYPES = new Set(["crash", "timeout"]);
// Fire-and-forget telemetry, not a log dump — a short reason string, not a
// full transcript (that's error_reports/`/api/error-report`'s job). Bounded
// generously above the 500-char DB-side truncation (see
// record_agent_incident()'s left(..., 500) in supabase/schema.sql) since
// that's a backstop on what gets stored, not the primary size guard.
const MAX_BODY_BYTES = 10_000;

function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Cloud mirror of an agent runtime crash or turn timeout — previously these
 * only ever surfaced as a local IDE chat "system" message (see extension.js's
 * ensureAgent() `onError`/`onExit` handlers for "agent failed to start" /
 * "agent exited (code)", and its sendPrompt() catch block for a turn timeout
 * surfaced by acp-client.js's AcpClient.request() watchdog). This endpoint
 * gives the admin dashboard aggregate visibility into how often that's
 * happening, without capturing anything more than a short reason string.
 *
 * Auth follows the exact same pattern as /api/feedback, /api/audit, and
 * /api/error-report: a Supabase session access token in the Authorization
 * header, validated with auth.getUser(), then written with the service-role
 * client so RLS never has to trust the caller.
 *
 * Body: { incidentType: "crash" | "timeout", detail?: string }.
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

  // Validate here rather than relying on the table's `incident_type in
  // (...)` check constraint — a constraint violation would surface as an
  // opaque 500 from the RPC call below instead of a clean 400.
  const incidentType = typeof body.incidentType === "string" ? body.incidentType : "";
  if (!VALID_INCIDENT_TYPES.has(incidentType)) {
    return Response.json({ error: "incidentType must be one of: crash, timeout" }, { status: 400 });
  }

  const { error: insertErr } = await admin.rpc("record_agent_incident", {
    p_user_id: userId,
    p_incident_type: incidentType,
    p_detail: s(body.detail),
  });

  if (insertErr) {
    console.error("agent-incident: record_agent_incident failed", insertErr);
    return Response.json({ error: "failed to record agent incident" }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
}
