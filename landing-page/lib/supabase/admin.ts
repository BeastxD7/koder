import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client — bypasses RLS entirely. Only ever call this from
 * code that has ALREADY verified the caller is the allowed admin (see
 * proxy.ts / isAdminEmail()). Never expose this client or its responses to
 * an unauthenticated or non-admin request.
 */
export function supabaseAdmin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Single-founder allowlist for the prototype phase — a real multi-admin
// setup would move this to a DB table, not worth the complexity yet.
const ADMIN_EMAILS = ["hello.401labs@gmail.com"];

export function isAdminEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && ADMIN_EMAILS.includes(email.toLowerCase());
}
