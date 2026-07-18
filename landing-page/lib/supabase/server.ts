import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Cookie-backed Supabase client for Server Components / Route Handlers,
 * using the anon key (RLS-scoped to whichever user's session cookie is
 * present) — this is what confirms "is someone logged in and who are they,"
 * NOT what reads admin-wide data. The /admin page uses a separate
 * service-role client (lib/supabase/admin.ts) for the actual dashboard
 * queries, after this one has confirmed the caller's identity.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll called from a Server Component (not a Route Handler or
          // middleware) — cookies can't be written there. Harmless as long
          // as middleware.ts is also refreshing the session on every
          // request, which it is (see middleware.ts).
        }
      },
    },
  });
}
