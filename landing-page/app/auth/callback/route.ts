import { NextRequest, NextResponse } from "next/server";
import { createClient } from "../../../lib/supabase/server";

export const runtime = "nodejs";

/** PKCE code-exchange landing point for the admin web login (see app/admin/login/actions.ts). */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const next = req.nextUrl.searchParams.get("next") ?? "/admin";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, req.url));
  }

  return NextResponse.redirect(new URL("/admin/login", req.url));
}
