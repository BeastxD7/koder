"use server";

import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import { dodoClient, PRO_PRODUCT_ID } from "../../lib/dodo";
import { supabaseAdmin } from "../../lib/supabase/admin";
import { setUserPlan } from "../../lib/subscriptions";

// Dodo discount.amount is in basis points (540 => 5.4%); 10000 => 100% off.
const FULLY_OFF_BASIS_POINTS = 10000;

/**
 * The real, public "Upgrade to Pro" action — the pricing page's CTA buttons
 * were hardcoded disabled "Coming soon" placeholders (see components/pricing
 * /UpgradeButton.tsx's doc comment for how this was found: the IDE's own
 * budget-cap upgrade link pointed here and hit a dead end). This is the
 * general-purpose twin of app/admin/actions.ts's createTestCheckoutSession —
 * same Dodo product/metadata convention, but sourced from ANY signed-in
 * visitor's cookie session rather than gated to the admin's own account, and
 * self-service sign-in (not "already logged in via the admin login page").
 *
 * `promoCode` is optional. A 100%-off code never reaches Dodo at all — see
 * tryRedeemFullyOffCode below — so "100% off" really does mean no payment
 * step, not just a $0 line item on Dodo's hosted checkout. Any other
 * (partial) code is passed through to Dodo so it's pre-applied on its
 * checkout page instead of the visitor having to type it twice.
 *
 * `redirect()` calls are deliberately OUTSIDE any try/catch below — Next.js
 * implements redirect() by throwing a special internal error that must
 * propagate uncaught, or the navigation never happens (a real footgun this
 * file's own admin precedent didn't have to worry about, since it never
 * combined a redirect with a call that can genuinely fail).
 */
export async function startProCheckout(promoCode?: string): Promise<{ ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const code = promoCode?.trim().toUpperCase() || undefined;

  if (!user) {
    // Round-trips through Google OAuth, landing back on /auth/callback,
    // which (now cookie-authenticated) redirects to `next` — back to this
    // same page with `?checkout=pro` (and `?promo=` if a code was entered
    // before sign-in), so UpgradeButton's effect re-invokes this action once
    // mounted, this time with a real user.
    const nextPath = code ? `/pricing?checkout=pro&promo=${encodeURIComponent(code)}` : "/pricing?checkout=pro";
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `https://lakshx.in/auth/callback?next=${encodeURIComponent(nextPath)}`,
        skipBrowserRedirect: true,
      },
    });
    if (error || !data?.url) return { ok: false, error: "failed to start sign-in" };
    redirect(data.url);
  }

  if (code) {
    const result = await tryRedeemFullyOffCode(code, user.id);
    if (result === "redeemed") redirect("/pricing?upgraded=1");
    if (result !== "not_fully_off") return { ok: false, error: result };
    // else: a real but partial discount — fall through, pre-apply it below.
  }

  let checkoutUrl: string;
  try {
    const session = await dodoClient().checkoutSessions.create({
      product_cart: [{ product_id: PRO_PRODUCT_ID, quantity: 1 }],
      customer: {
        email: user.email!,
        name: (user.user_metadata?.full_name as string | undefined) ?? (user.user_metadata?.name as string | undefined) ?? user.email!,
      },
      metadata: { supabase_user_id: user.id },
      return_url: "https://lakshx.in/checkout/success",
      ...(code ? { discount_codes: [code] } : {}),
    });
    if (!session.checkout_url) return { ok: false, error: "Dodo did not return a checkout URL" };
    checkoutUrl = session.checkout_url;
  } catch (err) {
    console.error("pricing/actions: Dodo checkout session creation failed", err);
    return { ok: false, error: "failed to create checkout session" };
  }

  redirect(checkoutUrl);
}

/**
 * Validates `code` against Dodo and, if it's 100% off, grants Pro directly
 * — no Dodo checkout session, no payment method prompt. Dodo's own
 * discount.times_used only increments on a completed Dodo checkout, which a
 * fully-off redemption deliberately never goes through, so usage_limit is
 * enforced here instead via promo_code_redemptions (supabase/schema.sql) —
 * without that, an unlimited-use free-Pro code would be exactly that:
 * unlimited, since Dodo would never see it used.
 *
 * Returns "redeemed" (caller should redirect to a success state),
 * "not_fully_off" (a real, valid, merely-partial code — caller should fall
 * through to normal Dodo checkout with it pre-applied), or an error string
 * to show the visitor.
 */
async function tryRedeemFullyOffCode(code: string, userId: string): Promise<"redeemed" | "not_fully_off" | string> {
  let discount;
  try {
    discount = await dodoClient().discounts.retrieveByCode(code);
  } catch {
    return "invalid promo code";
  }

  if (discount.type !== "percentage" || discount.amount < FULLY_OFF_BASIS_POINTS) return "not_fully_off";
  if (discount.expires_at && new Date(discount.expires_at) < new Date()) return "this promo code has expired";
  if (discount.restricted_to.length > 0 && !discount.restricted_to.includes(PRO_PRODUCT_ID)) {
    return "this promo code doesn't apply to Pro";
  }

  const admin = supabaseAdmin();
  const { data: already } = await admin
    .from("promo_code_redemptions")
    .select("user_id")
    .eq("code", code)
    .eq("user_id", userId)
    .maybeSingle();

  if (!already) {
    if (discount.usage_limit != null) {
      const { count } = await admin
        .from("promo_code_redemptions")
        .select("user_id", { count: "exact", head: true })
        .eq("code", code);
      if ((count ?? 0) >= discount.usage_limit) return "this promo code has reached its usage limit";
    }
    const { error: insertError } = await admin.from("promo_code_redemptions").insert({ code, user_id: userId });
    if (insertError) return "failed to redeem promo code";
  }

  // Indefinite, not "until period_end" — same as an admin's manual grant
  // (setUserPlan's other caller, app/admin/actions.ts). Nothing in this
  // codebase actually enforces current_period_end: getEffectivePlan() and
  // check_budget() (supabase/schema.sql) key off plan+status only. A real
  // Dodo subscription's access ends because the WEBHOOK flips status on
  // cancellation/expiry, not because anything compares period_end — and a
  // promo-bypass grant has no webhook behind it at all, so setting a
  // period_end here would be pure decoration that implies an auto-expiry
  // that would never actually happen. The admin's manual "set plan" control
  // is the real off-switch for a promo grant, exactly like it is for this
  // one's non-promo sibling.
  await setUserPlan(userId, "pro");
  return "redeemed";
}
