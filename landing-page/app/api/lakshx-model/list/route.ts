import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CHAT_COMPLETIONS_MODELS, getEffectivePlan, isPlanSufficient } from "../../../../lib/hosted-models";

export const runtime = "nodejs";

function supabaseAdmin(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Lets the IDE's model picker (upstream/extensions/lakshx-chat) show only
 * the hosted models the signed-in user's plan actually allows — sourced
 * from the same hosted_model_plans table /admin/models edits, instead of a
 * hand-maintained list baked into the extension that had no way to stay in
 * sync with it. This is a UX convenience, NOT the enforcement boundary: the
 * chat/completions and responses routes independently re-check plan vs.
 * model on every request regardless of what this list said, so a stale or
 * bypassed client can never get further than a clean 403.
 */
export async function GET(req: NextRequest) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ error: "proxy misconfigured — missing SUPABASE_* env vars" }, { status: 500 });
  }

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "missing bearer token" }, { status: 401 });

  const supabase = supabaseAdmin();
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    return Response.json({ error: "invalid or expired session" }, { status: 401 });
  }

  const [plan, { data: planRows }] = await Promise.all([
    getEffectivePlan(supabase, userData.user.id),
    supabase.from("hosted_model_plans").select("model, required_plan"),
  ]);

  const requiredPlanByModel = new Map((planRows ?? []).map((r) => [r.model as string, r.required_plan as "free" | "pro"]));

  // Fails closed to 'pro' for any model with no hosted_model_plans row, same
  // as getRequiredPlan() (lib/hosted-models.ts) — a newly-deployed model
  // never shows up as Free-selectable by omission.
  const models = [...CHAT_COMPLETIONS_MODELS].map((id) => {
    const requiredPlan = requiredPlanByModel.get(id) ?? "pro";
    return { id, requiredPlan, available: isPlanSufficient(plan, requiredPlan) };
  });

  return Response.json({ plan, models });
}
