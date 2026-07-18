import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Same lakshx:// deep-link target the magic-link flow used — the
// extension's URI handler is provider-agnostic (see product/lakshx-chat's
// registerUriHandler), so nothing there needs to change for this.
const REDIRECT_TO = "lakshx://lakshx.lakshx-chat/auth-callback";

/**
 * Returns the Google consent URL for the client to navigate to — kept
 * server-side (not calling supabase-js from the browser) for the same
 * reason as request-magic-link: consistency with "the browser never talks
 * to Supabase directly" for the IDE's login path.
 */
export async function GET() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return Response.json({ error: "server misconfigured" }, { status: 500 });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: REDIRECT_TO, skipBrowserRedirect: true },
  });

  if (error || !data?.url) {
    return Response.json({ error: "failed to start Google sign-in" }, { status: 500 });
  }
  return Response.json({ url: data.url });
}
