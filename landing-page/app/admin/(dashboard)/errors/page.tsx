import { supabaseAdmin } from "../../../../lib/supabase/admin";
import { ErrorReportsTable, type AdminErrorReportRow } from "../../../../components/admin/error-reports-table";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";

export const dynamic = "force-dynamic";

// Rows can carry up to a 50000-char diagnostic_report each (see
// record_error_report() in supabase/schema.sql) — capped well below
// admin_feedback_recent's 200 to keep this page's payload reasonable.
const ROW_LIMIT = 100;

export default async function AdminErrorsPage() {
  const admin = supabaseAdmin();
  const { data: reports } = await admin
    .from("admin_error_reports_recent")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(ROW_LIMIT);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground">Errors</h1>
        <p className="text-sm text-muted-foreground">Reports submitted from the IDE chat panel&apos;s Report button, with full session diagnostics.</p>
      </div>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Recent error reports</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorReportsTable data={(reports ?? []) as AdminErrorReportRow[]} />
        </CardContent>
      </Card>
    </div>
  );
}
