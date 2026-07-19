import { supabaseAdmin } from "../../../../lib/supabase/admin";
import { SubscriptionsTable, type AdminSubscriptionRow } from "../../../../components/admin/subscriptions-table";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";

export const dynamic = "force-dynamic";

export default async function AdminSubscriptionsPage() {
  const admin = supabaseAdmin();
  const { data: subscriptions } = await admin
    .from("admin_subscriptions_recent")
    .select("*")
    .order("updated_at", { ascending: false });

  const activeCount = (subscriptions ?? []).filter((s) => s.plan === "pro" && s.status === "active").length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground">Subscriptions</h1>
        <p className="text-sm text-muted-foreground">
          {activeCount} active Pro subscriber{activeCount === 1 ? "" : "s"} — Dodo Payments (test mode).
        </p>
      </div>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>All subscriptions</CardTitle>
        </CardHeader>
        <CardContent>
          <SubscriptionsTable data={(subscriptions ?? []) as AdminSubscriptionRow[]} />
        </CardContent>
      </Card>
    </div>
  );
}
