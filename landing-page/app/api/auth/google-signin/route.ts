import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// Routes through our own /auth/ide-redirect page rather than straight to
// lakshx:// — a raw custom-scheme redirectTo leaves the browser tab with
// nothing to render (no page loads, no confirmation, just a stuck-looking
// "loading" state) even though the sign-in itself succeeded and the
// extension's URI handler received the tokens fine. The relay page reads the
// token fragment client-side and forwards it to the same lakshx:// deep link
// itself, but with a real page to show a confirmation on. Already covered by
// this project's Supabase redirect allowlist's `https://lakshx.in/**` entry
// — no Supabase config change needed for this.
const REDIRECT_TO = "https://lakshx.in/auth/ide-redirect";

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
