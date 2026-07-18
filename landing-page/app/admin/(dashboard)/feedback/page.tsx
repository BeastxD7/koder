import { ThumbsUp, ThumbsDown, RotateCcw } from "lucide-react";
import { supabaseAdmin } from "../../../../lib/supabase/admin";
import { FeedbackChart } from "../../../../components/admin/feedback-chart";
import { FeedbackTable, type AdminFeedbackRow } from "../../../../components/admin/feedback-table";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";

export const dynamic = "force-dynamic";

export default async function AdminFeedbackPage() {
  const admin = supabaseAdmin();
  const [{ data: summary }, { data: recent }] = await Promise.all([
    admin.from("admin_feedback_summary").select("*").order("day", { ascending: true }),
    admin.from("admin_feedback_recent").select("*").order("created_at", { ascending: false }).limit(200),
  ]);

  const rows = (summary ?? []) as { day: string; up_count: number; down_count: number; retry_count: number; total_count: number }[];
  const totals = rows.reduce(
    (acc, r) => ({
      up: acc.up + Number(r.up_count),
      down: acc.down + Number(r.down_count),
      retry: acc.retry + Number(r.retry_count),
    }),
    { up: 0, down: 0, retry: 0 },
  );
  const totalRated = totals.up + totals.down;
  const satisfaction = totalRated > 0 ? (totals.up / totalRated) * 100 : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-foreground">Feedback</h1>
        <p className="text-sm text-muted-foreground">Thumbs up/down and retries submitted from the IDE&apos;s chat review form.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Thumbs up</CardTitle>
            <ThumbsUp className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">{totals.up}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Thumbs down</CardTitle>
            <ThumbsDown className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">{totals.down}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Retries</CardTitle>
            <RotateCcw className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">{totals.retry}</div>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Satisfaction</CardTitle>
            <ThumbsUp className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">{satisfaction === null ? "—" : `${satisfaction.toFixed(1)}%`}</div>
            <p className="text-xs text-muted-foreground">up / (up + down)</p>
          </CardContent>
        </Card>
      </div>

      <FeedbackChart
        data={rows.map((r) => ({
          day: r.day,
          up_count: Number(r.up_count),
          down_count: Number(r.down_count),
          retry_count: Number(r.retry_count),
        }))}
      />

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Recent feedback</CardTitle>
        </CardHeader>
        <CardContent>
          <FeedbackTable data={(recent ?? []) as AdminFeedbackRow[]} />
        </CardContent>
      </Card>
    </div>
  );
}
