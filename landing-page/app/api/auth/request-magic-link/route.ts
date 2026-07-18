import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// LakshX (the IDE's extension id is `lakshx.lakshx-chat`) receives the
// magic-link redirect via its registered `lakshx://` URI scheme — see
// product/lakshx-chat's URI handler. VS Code's URI-handler convention
// routes `<protocol>://<publisher>.<extension-name>/<path>` to the
// extension whose id matches the authority.
const REDIRECT_TO = "lakshx://lakshx.lakshx-chat/auth-callback";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Deliberately server-side: the browser never talks to Supabase directly for
 * this, so the anon key (and everything else) stays out of any client
 * bundle. Body: { email }. Always returns a generic success message
 * regardless of whether the email exists, to avoid leaking account
 * existence — Supabase's own signInWithOtp already behaves this way.
 */
export async function POST(req: NextRequest) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return Response.json({ error: "server misconfigured" }, { status: 500 });
  }

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!EMAIL_RE.test(email)) {
    return Response.json({ error: "enter a valid email address" }, { status: 400 });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: REDIRECT_TO },
  });

  if (error) {
    console.error("signInWithOtp failed:", error.status, error.name, error.message);
    // Rate limiting (Supabase's own auth rate limits) is the one case worth
    // surfacing distinctly — everything else stays generic.
    const status = error.status === 429 ? 429 : 500;
    return Response.json({ error: error.status === 429 ? "too many requests — try again shortly" : "failed to send" }, { status });
  }

  return Response.json({ ok: true });
}
