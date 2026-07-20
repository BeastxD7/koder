"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../../lib/supabase/server";
import { isAdminEmail, supabaseAdmin } from "../../lib/supabase/admin";
import { dodoClient, PRO_PRODUCT_ID } from "../../lib/dodo";
import { setUserPlan } from "../../lib/subscriptions";

/**
 * Defense in depth: proxy.ts already gates /admin/*, but this re-checks the
 * caller's own identity independently before touching the service-role
 * client (or, for the promo-code actions below, the Dodo API key) — a
 * Server Action can in principle be invoked directly, not only via the page
 * that renders its form, so it must not assume proxy.ts ran.
 */
async function assertAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdminEmail(user?.email)) throw new Error("not authorized");
}

export async function updateUserCredit(formData: FormData) {
  await assertAdmin();
  const userId = String(formData.get("userId") ?? "");
  const limit = Number(formData.get("creditLimit"));
  if (!userId || !Number.isFinite(limit) || limit < 0) throw new Error("invalid input");

  const admin = supabaseAdmin();
  const { error } = await admin.from("user_budget").upsert({ user_id: userId, credit_limit_usd: limit });
  if (error) throw new Error(error.message);

  revalidatePath("/admin", "layout");
}

/**
 * Which plan a hosted model requires (hosted_model_plans, supabase/
 * schema.sql) — was a hardcoded FREE_TIER_MODELS constant in lib/hosted-
 * models.ts until this was added; moving a model between tiers is now this
 * action, not a code change + redeploy. `requiredPlan` is constrained to the
 * exact same values `user_subscription.plan`'s check constraint allows.
 */
export async function updateModelPlan(formData: FormData) {
  await assertAdmin();
  const model = String(formData.get("model") ?? "").trim();
  const requiredPlan = String(formData.get("requiredPlan") ?? "");
  if (!model) throw new Error("missing model");
  if (requiredPlan !== "free" && requiredPlan !== "pro") throw new Error("invalid plan");

  const admin = supabaseAdmin();
  const { error } = await admin.from("hosted_model_plans").upsert({ model, required_plan: requiredPlan, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);

  revalidatePath("/admin/models");
}

/**
 * Manual override for user_subscription.plan — for comping a user, honoring
 * a support request, or unblocking someone while Dodo/the webhook is
 * misbehaving, without needing a real Dodo subscription behind it. Goes
 * through setUserPlan() (lib/subscriptions.ts) so it writes the exact same
 * shape the webhook does; getEffectivePlan()/check_budget() can't tell a
 * manual grant apart from a paid one. No expiry — stays Pro until an admin
 * changes it back, since there's no billing cycle driving a renewal here.
 */
export async function updateUserPlan(formData: FormData) {
  await assertAdmin();
  const userId = String(formData.get("userId") ?? "");
  const plan = String(formData.get("plan") ?? "");
  if (!userId) throw new Error("missing user id");
  if (plan !== "free" && plan !== "pro") throw new Error("invalid plan");

  await setUserPlan(userId, plan);

  revalidatePath("/admin", "layout");
}

export async function updateGlobalCeiling(formData: FormData) {
  await assertAdmin();
  const ceiling = Number(formData.get("ceiling"));
  if (!Number.isFinite(ceiling) || ceiling < 0) throw new Error("invalid input");

  const admin = supabaseAdmin();
  const { error } = await admin.from("global_budget").update({ ceiling_usd: ceiling }).eq("id", true);
  if (error) throw new Error(error.message);

  revalidatePath("/admin", "layout");
}

/**
 * Promo codes live entirely in Dodo (its Discounts API — percentage-only,
 * basis points), not in our own Supabase schema — there's nothing to
 * duplicate/keep in sync here, this just calls through with an admin check
 * in front. `restricted_to: [PRO_PRODUCT_ID]` scopes every code created
 * here to the one real product that exists (LakshX Pro) so a code can
 * never accidentally apply somewhere else if more products are added later.
 */
export async function createPromoCode(formData: FormData) {
  await assertAdmin();

  const code = String(formData.get("code") ?? "").trim().toUpperCase() || undefined;
  const percentOff = Number(formData.get("percentOff"));
  if (!Number.isFinite(percentOff) || percentOff <= 0 || percentOff > 100) {
    throw new Error("percent off must be between 1 and 100");
  }
  const expiresAtRaw = String(formData.get("expiresAt") ?? "").trim();
  const usageLimitRaw = String(formData.get("usageLimit") ?? "").trim();

  await dodoClient().discounts.create({
    type: "percentage",
    amount: Math.round(percentOff * 100), // basis points: 20% -> 2000
    code,
    expires_at: expiresAtRaw ? new Date(expiresAtRaw).toISOString() : null,
    usage_limit: usageLimitRaw ? Number(usageLimitRaw) : null,
    restricted_to: [PRO_PRODUCT_ID],
  });

  revalidatePath("/admin/promo-codes");
}

export async function deletePromoCode(formData: FormData) {
  await assertAdmin();
  const discountId = String(formData.get("discountId") ?? "");
  if (!discountId) throw new Error("missing discount id");

  await dodoClient().discounts.delete(discountId);

  revalidatePath("/admin/promo-codes");
}

