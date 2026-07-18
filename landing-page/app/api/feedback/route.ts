import { NextRequest } from "next/server";
import { supabaseAdmin } from "../../../lib/supabase/admin";

export const runtime = "nodejs";

const VALID_RATINGS = new Set(["up", "down", "retry"]);
// Hard ceiling on the whole payload — this is fire-and-forget telemetry,
// not a place to accept an unbounded transcript dump. Comfortably above a
// truthful worst-case turn (prompt + response + several tool call
// summaries, each already capped client-side — see extension.js's
// turnContext()) while still rejecting anything pathological before it
// reaches Postgres.
const MAX_BODY_BYTES = 200_000;

function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Cloud mirror of the IDE's local feedback log (see extension.js's
 * logFeedback()/`case "feedback"` handler, and ~/.lakshx/feedback/*.jsonl).
 * Auth follows the exact same pattern as
 * /api/lakshx-model/chat/completions: a Supabase session access token in
 * the Authorization header, validated with auth.getUser(), then written
 * with the service-role client so RLS never has to trust the caller.
 *
 * Body shape mirrors the extension's logFeedback() entry object as closely
 * as possible so the IDE-side caller can send it near-verbatim:
 *   {
 *     rating: "up" | "down" | "retry",
 *     model?: string, mode?: string,
 *     chatId?: string, sessionId?: string,
 *     userPromptText?: string, assistantResponseText?: string,
 *     toolCalls?: Array<{name, kind, input, isError, outputSummary}>,
 *     comment?: string,       // optional note attached to a thumbs-up
 *     expected?: string,      // "what did you expect" on a thumbs-down
 *     wentWrong?: string,     // "what went wrong" on a thumbs-down
 *   }
 * `ts` is accepted but ignored — the row's created_at is server-assigned.
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

  const rating = typeof body.rating === "string" ? body.rating : "";
  if (!VALID_RATINGS.has(rating)) {
    return Response.json({ error: "rating must be one of: up, down, retry" }, { status: 400 });
  }

  // toolCalls arrives as an array of small objects already summarized
  // client-side (see extension.js's turnContext()); still guard against a
  // malformed/oversized payload before it becomes a jsonb column value.
  let toolCalls: unknown = null;
  if (Array.isArray(body.toolCalls)) {
    const json = JSON.stringify(body.toolCalls);
    toolCalls = json.length > MAX_BODY_BYTES ? null : body.toolCalls;
  }

  const { error: insertErr } = await admin.rpc("record_feedback_event", {
    p_user_id: userId,
    p_rating: rating,
    p_model: s(body.model),
    p_mode: s(body.mode),
    p_chat_id: s(body.chatId),
    p_session_id: s(body.sessionId),
    p_prompt_excerpt: s(body.userPromptText),
    p_response_excerpt: s(body.assistantResponseText),
    p_tool_calls: toolCalls,
    p_comment: s(body.comment),
    p_expected: s(body.expected),
    p_went_wrong: s(body.wentWrong),
  });

  if (insertErr) {
    console.error("feedback: record_feedback_event failed", insertErr);
    return Response.json({ error: "failed to record feedback" }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
}
