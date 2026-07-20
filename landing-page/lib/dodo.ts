import DodoPayments from "dodopayments";

/**
 * Dodo Payments client — LIVE mode (LakshX Pro's Merchant-of-Record
 * billing, chosen over Stripe/LemonSqueezy because the founder has an
 * Indian bank account and Dodo's onboarding doesn't exclude India the way
 * Stripe's does). `DODO_API_KEY`/`DODO_PRO_PRODUCT_ID` live only in
 * Vercel's server-side Production env, never shipped to a client bundle.
 *
 * Flipped from `test_mode` on 2026-07-20: a live API key, a live-mode
 * "LakshX Pro" product (created via the Products API, same $15/mo USD
 * monthly config as the test-mode product it replaces), and a live-mode
 * webhook (same URL/filter_types as the test one, new signing secret) were
 * all provisioned first — `environment` is hardcoded rather than read from
 * an env var deliberately, so this stays a reviewed code change, not
 * something togglable by an env var alone.
 */
export function dodoClient(): DodoPayments {
  return new DodoPayments({
    bearerToken: process.env.DODO_API_KEY!,
    environment: "live_mode",
  });
}

/** LakshX Pro: $15/mo, created via the Products API — live-mode product id,
 * provisioned alongside the live API key and webhook on 2026-07-20. */
export const PRO_PRODUCT_ID = process.env.DODO_PRO_PRODUCT_ID!;
