import { DollarSign, Users as UsersIcon, Activity, Gauge } from "lucide-react";
import { createClient } from "../../../lib/supabase/server";
import { supabaseAdmin } from "../../../lib/supabase/admin";
import { updateGlobalCeiling } from "../actions";
import { SpendChart } from "../../../components/admin/spend-chart";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Button } from "../../../components/ui/button";

export const dynamic = "force-dynamic";

function formatUsd(n: number | null | undefined) {
  return `$${Number(n ?? 0).toFixed(4)}`;
}

export default async function AdminOverviewPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const admin = supabaseAdmin();
  const [{ data: budget }, { data: users }, { data: dailySpend }] = await Promise.all([
    admin.from("global_budget").select("*").single(),
    admin.from("admin_user_usage").select("*"),
    admin.from("admin_daily_spend").select("*").order("day", { ascending: true }),
  ]);

  const pctUsed = budget ? Math.min(100, (Number(budget.spent_usd) / Number(budget.ceiling_usd)) * 100) : 0;
  // Two distinct, non-interchangeable metrics — named for exactly what they
  // count (a prior version named these "totalRequests"/"activeUsers", which
  // didn't match either what they measured or which card displayed them):
  const usersWithTokenActivity = (users ?? []).reduce((sum, u) => sum + (u.total_tokens_in > 0 || u.total_tokens_out > 0 ? 1 : 0), 0);
  const usersWithBilledCost = (users ?? []).filter((u) => Number(u.total_cost_usd) > 0).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground">Overview</h1>
        <p className="text-sm text-muted-foreground">Signed in as {user?.email}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total spent</CardTitle>
            <DollarSign className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">{formatUsd(budget?.spent_usd)}</div>
            <p className="text-xs text-muted-foreground">of {formatUsd(budget?.ceiling_usd)} ceiling</p>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Budget used</CardTitle>
            <Gauge className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">{pctUsed.toFixed(2)}%</div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${pctUsed > 90 ? "bg-red-500" : pctUsed > 70 ? "bg-amber-400" : "bg-primary"}`}
                style={{ width: `${pctUsed}%` }}
              />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total users</CardTitle>
            <UsersIcon className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">{users?.length ?? 0}</div>
            <p className="text-xs text-muted-foreground">{usersWithBilledCost} with usage</p>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active users</CardTitle>
            <Activity className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">{usersWithTokenActivity}</div>
            <p className="text-xs text-muted-foreground">have sent at least one request</p>
          </CardContent>
        </Card>
      </div>

      <SpendChart
        data={(dailySpend ?? []).map((d) => ({ day: d.day, cost_usd: Number(d.cost_usd), requests: Number(d.requests) }))}
      />

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Global ceiling</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={updateGlobalCeiling} className="flex items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted-foreground">Ceiling ($)</label>
              <Input type="number" step="0.01" name="ceiling" defaultValue={budget?.ceiling_usd ?? 800} className="w-36" />
            </div>
            <Button type="submit" variant="secondary">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
