"use server";

import { createClient } from "../../../lib/supabase/server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type MagicLinkState = { status: "idle" } | { status: "error"; message: string } | { status: "sent"; email: string };

/**
 * Distinct from /api/auth/request-magic-link (which is for the IDE's
 * implicit-flow, no-cookie, lakshx:// deep-link login). This one runs
 * through the cookie-aware SSR client so Supabase's PKCE code_verifier gets
 * stored in a cookie THIS browser can present again at /auth/callback —
 * that round trip only works if the same client that requested the OTP
 * also holds the verifier, which is exactly what the SSR client's
 * cookie plumbing is for.
 */
export async function requestAdminMagicLink(_prevState: MagicLinkState, formData: FormData): Promise<MagicLinkState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!EMAIL_RE.test(email)) return { status: "error", message: "enter a valid email address" };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: "https://lakshx.in/auth/callback?next=/admin" },
  });

  if (error) {
    if (error.status === 429) return { status: "error", message: "too many requests — try again shortly" };
    return { status: "error", message: "failed to send" };
  }
  return { status: "sent", email };
}
