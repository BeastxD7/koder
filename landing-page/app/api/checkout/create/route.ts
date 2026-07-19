import { NextRequest } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabase/admin";
import { dodoClient, PRO_PRODUCT_ID } from "../../../../lib/dodo";

export const runtime = "nodejs";

/**
 * Creates a Dodo Checkout Session for LakshX Pro ($15/mo) and returns the
 * hosted checkout URL for the client to redirect to. Auth follows the same
 * bearer-token pattern as /api/auth-event, /api/feedback, etc.
 *
 * `metadata.supabase_user_id` is the ONLY thing that lets
 * /api/webhooks/dodo map a later subscription.* webhook back to a Supabase
 * user — Dodo's `customer_id`/`email` alone aren't enough since a customer
 * could theoretically check out with a different email than their Supabase
 * account. Every subscription.* webhook payload carries this metadata back
 * verbatim (confirmed against the Dodo SDK's Subscription type).
 */
export async function POST(req: NextRequest) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ error: "server misconfigured — missing SUPABASE_* env vars" }, { status: 500 });
  }
  if (!process.env.DODO_API_KEY || !process.env.DODO_PRO_PRODUCT_ID) {
    return Response.json({ error: "server misconfigured — missing DODO_* env vars" }, { status: 500 });
  }

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "missing bearer token" }, { status: 401 });

  const admin = supabaseAdmin();
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return Response.json({ error: "invalid or expired session" }, { status: 401 });
  }
  const user = userData.user;

  const origin = req.headers.get("origin") ?? "https://lakshx.in";

  try {
    const session = await dodoClient().checkoutSessions.create({
      product_cart: [{ product_id: PRO_PRODUCT_ID, quantity: 1 }],
      customer: {
        email: user.email!,
        name: (user.user_metadata?.full_name as string | undefined) ?? (user.user_metadata?.name as string | undefined) ?? user.email!,
      },
      metadata: { supabase_user_id: user.id },
      return_url: `${origin}/checkout/success`,
    });

    return Response.json({ checkoutUrl: session.checkout_url }, { status: 200 });
  } catch (err) {
    console.error("checkout/create: Dodo checkout session creation failed", err);
    return Response.json({ error: "failed to create checkout session" }, { status: 502 });
  }
}
