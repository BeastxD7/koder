"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../../lib/supabase/server";
import { isAdminEmail, supabaseAdmin } from "../../lib/supabase/admin";

/**
 * Defense in depth: middleware.ts already gates /admin/*, but this re-checks
 * the caller's own identity independently before touching the service-role
 * client — a Server Action can in principle be invoked directly, not only
 * via the page that renders its form, so it must not assume middleware ran.
 */
async function assertAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdminEmail(user?.email)) throw new Error("not authorized");
}

export async function updateUserCredit(formData: FormData) {
  await assertAdmin();
  const userId = String(formData.get("userId") ?? "");
  const limit = Number(formData.get("creditLimit"));
  if (!userId || !Number.isFinite(limit) || limit < 0) throw new Error("invalid input");

  const admin = supabaseAdmin();
  const { error } = await admin.from("user_budget").upsert({ user_id: userId, credit_limit_usd: limit });
  if (error) throw new Error(error.message);

  revalidatePath("/admin");
}

export async function updateGlobalCeiling(formData: FormData) {
  await assertAdmin();
  const ceiling = Number(formData.get("ceiling"));
  if (!Number.isFinite(ceiling) || ceiling < 0) throw new Error("invalid input");

  const admin = supabaseAdmin();
  const { error } = await admin.from("global_budget").update({ ceiling_usd: ceiling }).eq("id", true);
  if (error) throw new Error(error.message);

  revalidatePath("/admin");
}
