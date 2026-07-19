import { NextRequest } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabase/admin";
import { dodoClient } from "../../../../lib/dodo";

export const runtime = "nodejs";

/**
 * Dodo Payments webhook receiver — the only writer of `user_subscription`
 * (via upsert_subscription_from_webhook(), service-role key). Verifies the
 * Standard Webhooks signature (webhook-id/webhook-signature/webhook-
 * timestamp headers, HMAC-SHA256) via the official SDK's `webhooks.unwrap()`
 * BEFORE trusting anything in the body — this endpoint is public (Dodo
 * calls it directly, no bearer token, unlike every other route in this
 * app), so signature verification IS the auth here.
 *
 * `event.data.metadata.supabase_user_id` (set at checkout time by
 * /api/checkout/create) is what maps a subscription back to a Supabase
 * user — Dodo's own customer_id/email aren't reliable for this since a
 * customer could check out with an email that doesn't match their Supabase
 * account.
 */
export async function POST(req: NextRequest) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ error: "server misconfigured — missing SUPABASE_* env vars" }, { status: 500 });
  }
  if (!process.env.DODO_API_KEY || !process.env.DODO_WEBHOOK_SECRET) {
    return Response.json({ error: "server misconfigured — missing DODO_* env vars" }, { status: 500 });
  }

  const rawBody = await req.text();
  const webhookId = req.headers.get("webhook-id") ?? "";
  const webhookSignature = req.headers.get("webhook-signature") ?? "";
  const webhookTimestamp = req.headers.get("webhook-timestamp") ?? "";

  let event;
  try {
    event = dodoClient().webhooks.unwrap(rawBody, {
      headers: { "webhook-id": webhookId, "webhook-signature": webhookSignature, "webhook-timestamp": webhookTimestamp },
      key: process.env.DODO_WEBHOOK_SECRET,
    });
  } catch (err) {
    console.error("webhooks/dodo: signature verification failed", err);
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  // Only subscription.* events touch user_subscription — payment.*,
  // refund.*, dispute.*, etc. are Dodo's own record-keeping and don't need
  // a LakshX-side reaction today (Dodo already handles receipts/dunning
  // emails as the merchant of record).
  const SUBSCRIPTION_EVENTS = new Set([
    "subscription.active",
    "subscription.renewed",
    "subscription.on_hold",
    "subscription.cancelled",
    "subscription.failed",
    "subscription.expired",
  ]);
  if (!SUBSCRIPTION_EVENTS.has(event.type)) {
    return Response.json({ ok: true, ignored: event.type }, { status: 200 });
  }

  const sub = event.data as { metadata?: Record<string, unknown>; customer?: { customer_id?: string }; subscription_id?: string; status?: string; previous_billing_date?: string; next_billing_date?: string };
  const supabaseUserId = sub.metadata?.supabase_user_id;
  if (typeof supabaseUserId !== "string" || !supabaseUserId) {
    // Shouldn't happen (every checkout we create sets this), but a
    // subscription created directly in the Dodo dashboard (e.g. a manual
    // test) would hit this — log and ack so Dodo doesn't retry forever.
    console.error("webhooks/dodo: subscription event with no supabase_user_id in metadata", { type: event.type, subscription_id: sub.subscription_id });
    return Response.json({ ok: true, warning: "no supabase_user_id in metadata" }, { status: 200 });
  }

  const admin = supabaseAdmin();
  const { error } = await admin.rpc("upsert_subscription_from_webhook", {
    p_user_id: supabaseUserId,
    p_dodo_customer_id: sub.customer?.customer_id ?? null,
    p_dodo_subscription_id: sub.subscription_id ?? null,
    p_plan: "pro",
    p_status: sub.status ?? "active",
    p_current_period_start: sub.previous_billing_date ?? null,
    p_current_period_end: sub.next_billing_date ?? null,
  });

  if (error) {
    console.error("webhooks/dodo: upsert_subscription_from_webhook failed", error);
    return Response.json({ error: "failed to record subscription" }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
}
