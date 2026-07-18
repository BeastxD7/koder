import { createClient } from "../../lib/supabase/server";
import { supabaseAdmin } from "../../lib/supabase/admin";
import { updateUserCredit, updateGlobalCeiling } from "./actions";

export const dynamic = "force-dynamic";

function formatUsd(n: number | null | undefined) {
  return `$${Number(n ?? 0).toFixed(4)}`;
}

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const admin = supabaseAdmin();
  const [{ data: budget }, { data: users }] = await Promise.all([
    admin.from("global_budget").select("*").single(),
    admin.from("admin_user_usage").select("*").order("total_cost_usd", { ascending: false }),
  ]);

  const pctUsed = budget ? Math.min(100, (Number(budget.spent_usd) / Number(budget.ceiling_usd)) * 100) : 0;

  return (
    <div className="min-h-dvh bg-[#0a0c12] px-4 py-10 text-white sm:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex items-baseline justify-between">
          <h1 className="font-heading text-2xl font-bold">LakshX Admin</h1>
          <p className="text-sm text-white/50">signed in as {user?.email}</p>
        </div>

        <section className="mb-8 rounded-2xl border border-white/10 bg-white/[0.05] p-6">
          <h2 className="mb-3 font-heading text-lg font-semibold">Global budget</h2>
          <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full ${pctUsed > 90 ? "bg-red-500" : pctUsed > 70 ? "bg-amber-400" : "bg-lakshx-violet"}`}
              style={{ width: `${pctUsed}%` }}
            />
          </div>
          <p className="text-sm text-white/70">
            {formatUsd(budget?.spent_usd)} spent of {formatUsd(budget?.ceiling_usd)} ceiling ({pctUsed.toFixed(2)}%)
          </p>
          <form action={updateGlobalCeiling} className="mt-4 flex items-center gap-2">
            <label className="text-sm text-white/60">Set ceiling ($)</label>
            <input
              type="number"
              step="0.01"
              name="ceiling"
              defaultValue={budget?.ceiling_usd ?? 800}
              className="w-32 rounded-lg border border-white/15 bg-black/30 px-3 py-1.5 text-sm text-white outline-none focus:border-lakshx-violet/50"
            />
            <button type="submit" className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15">
              Save
            </button>
          </form>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[0.05] p-6">
          <h2 className="mb-4 font-heading text-lg font-semibold">Users ({users?.length ?? 0})</h2>
          {!users || users.length === 0 ? (
            <p className="text-sm text-white/50">No users yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-white/50">
                    <th className="py-2 pr-4 font-medium">Email</th>
                    <th className="py-2 pr-4 font-medium">Spent</th>
                    <th className="py-2 pr-4 font-medium">Tokens in/out</th>
                    <th className="py-2 pr-4 font-medium">Last used</th>
                    <th className="py-2 pr-4 font-medium">Cap</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.user_id} className="border-b border-white/5">
                      <td className="py-2 pr-4">{u.email}</td>
                      <td className="py-2 pr-4">{formatUsd(u.total_cost_usd)}</td>
                      <td className="py-2 pr-4 text-white/60">
                        {u.total_tokens_in ?? 0} / {u.total_tokens_out ?? 0}
                      </td>
                      <td className="py-2 pr-4 text-white/60">{u.last_used_at ? new Date(u.last_used_at).toLocaleString() : "—"}</td>
                      <td className="py-2 pr-4">
                        <form action={updateUserCredit} className="flex items-center gap-1.5">
                          <input type="hidden" name="userId" value={u.user_id} />
                          <input
                            type="number"
                            step="0.01"
                            name="creditLimit"
                            defaultValue={u.credit_limit_usd ?? 20}
                            className="w-20 rounded-lg border border-white/15 bg-black/30 px-2 py-1 text-xs text-white outline-none focus:border-lakshx-violet/50"
                          />
                          <button type="submit" className="rounded-lg bg-white/10 px-2 py-1 text-xs hover:bg-white/15">
                            Save
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
