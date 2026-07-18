// LakshX hosted-model login: parses the lakshx:// deep-link callback from
// Supabase's magic-link redirect, and refreshes the session token. Plain
// CJS, zero deps — matches the rest of this extension.
//
// The anon key below is meant to be public (same key already shipped to the
// browser for /login) — it authorizes calls to Supabase's auth API on
// behalf of a specific user, it does not grant any privileged access.
const SUPABASE_URL = "https://kgukzkyihtifnleosvma.supabase.co";

/**
 * Supabase's anon key — public by design (Row Level Security, not key
 * secrecy, is what protects data), same key already used by the /login page
 * server-side. Safe to ship in the packaged app. Update if the Supabase
 * project is ever recreated.
 */
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtndWt6a3lpaHRpZm5sZW9zdm1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzODAzMjcsImV4cCI6MjA5OTk1NjMyN30.CIxFtjrZxycmlC-in9aSLngcYe7ePBiTBiWl5dNuUwM";

/**
 * uri is a vscode.Uri for `lakshx://lakshx.lakshx-chat/auth-callback#access_token=...`.
 * Supabase's magic-link redirect uses the implicit flow — tokens land
 * directly in the fragment, no code-exchange round trip needed.
 */
function parseAuthCallback(uri) {
  const fragment = uri.fragment || "";
  const params = new URLSearchParams(fragment);
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  const expires_in = Number(params.get("expires_in") ?? "3600");
  const error = params.get("error_description") || params.get("error");
  if (error) return { error };
  if (!access_token || !refresh_token) return { error: "callback missing tokens" };
  return { access_token, refresh_token, expires_in };
}

/**
 * Refresh tokens are single-use with rotation + reuse detection (Supabase
 * docs) — the caller MUST persist the new refresh_token this returns, not
 * just the new access_token, or the NEXT refresh will fail as a replayed
 * token and silently log the user out.
 */
async function refreshSession(refreshToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in ?? 3600 };
}

module.exports = { parseAuthCallback, refreshSession };
