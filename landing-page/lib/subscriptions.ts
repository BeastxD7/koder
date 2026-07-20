import { supabaseAdmin } from "./supabase/admin";

/**
 * The one non-webhook writer to `user_subscription` (supabase/schema.sql's
 * upsert_subscription_from_webhook is otherwise only called from
 * app/api/webhooks/dodo). Both the admin's manual "set plan" action and the
 * 100%-off promo code bypass (app/pricing/actions.ts) go through this so
 * there's a single place that decides what a non-Dodo-billed grant looks
 * like, instead of two independent RPC call sites drifting apart.
 *
 * Preserves any existing dodo_customer_id/dodo_subscription_id unless
 * explicitly overridden — downgrading a real paying subscriber back to Free
 * from the admin panel shouldn't blank out their Dodo linkage; the next
 * webhook event re-syncs it anyway, but there's no reason to lose it in the
 * meantime.
 */
export async function setUserPlan(
  userId: string,
  plan: "free" | "pro",
  opts: { periodStart?: string | null; periodEnd?: string | null } = {}
) {
  const admin = supabaseAdmin();
  const { data: existing } = await admin
    .from("user_subscription")
    .select("dodo_customer_id, dodo_subscription_id")
    .eq("user_id", userId)
    .maybeSingle();

  const { error } = await admin.rpc("upsert_subscription_from_webhook", {
    p_user_id: userId,
    p_dodo_customer_id: existing?.dodo_customer_id ?? null,
    p_dodo_subscription_id: existing?.dodo_subscription_id ?? null,
    p_plan: plan,
    p_status: "active",
    p_current_period_start: plan === "pro" ? (opts.periodStart ?? new Date().toISOString()) : null,
    p_current_period_end: plan === "pro" ? (opts.periodEnd ?? null) : null,
  });
  if (error) throw new Error(error.message);
}
