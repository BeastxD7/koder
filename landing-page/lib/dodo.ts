import DodoPayments from "dodopayments";

/**
 * Dodo Payments client — test mode only for now (LakshX Pro's Merchant-of-
 * Record billing, chosen over Stripe/LemonSqueezy because the founder has
 * an Indian bank account and Dodo's onboarding doesn't exclude India the
 * way Stripe's does). `DODO_API_KEY`/`DODO_PRO_PRODUCT_ID` live only in
 * Vercel's server-side env, never shipped to a client bundle.
 *
 * `environment: "test_mode"` is hardcoded rather than read from an env var
 * — flipping to live mode is a deliberate, reviewed code change (a new key
 * + a real product id in live mode too), not something that should be
 * togglable by an env var alone.
 */
export function dodoClient(): DodoPayments {
  return new DodoPayments({
    bearerToken: process.env.DODO_API_KEY!,
    environment: "test_mode",
  });
}

/** LakshX Pro: $15/mo, created via the Products API — see the founder's
 * shell history / Dodo test dashboard for provenance. */
export const PRO_PRODUCT_ID = process.env.DODO_PRO_PRODUCT_ID!;
