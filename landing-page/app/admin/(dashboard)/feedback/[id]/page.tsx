import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { supabaseAdmin } from "../../../../../lib/supabase/admin";
import { Badge } from "../../../../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../../components/ui/card";
import type { AdminFeedbackRow } from "../../../../../components/admin/feedback-table";

export const dynamic = "force-dynamic";

// admin_feedback_recent selects f.tool_calls (jsonb) but AdminFeedbackRow
// (defined for the table view) doesn't need it — this detail page does, so
// it extends the row type locally rather than widening the shared type for
// every table consumer.
type AdminFeedbackDetailRow = AdminFeedbackRow & { tool_calls: unknown };

function RatingBadge({ rating }: { rating: AdminFeedbackRow["rating"] }) {
  if (rating === "up") {
    return <Badge className="bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/20">up</Badge>;
  }
  if (rating === "down") return <Badge variant="destructive">down</Badge>;
  return <Badge variant="secondary">retry</Badge>;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      <div className="text-sm text-foreground">{value}</div>
    </div>
  );
}

function TextBlock({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      {value ? (
        <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground">{value}</pre>
      ) : (
        <p className="text-sm text-muted-foreground">—</p>
      )}
    </div>
  );
}

export default async function AdminFeedbackDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from("admin_feedback_recent")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!row) notFound();

  const feedback = row as AdminFeedbackDetailRow;
  const hasFlags = feedback.comment || feedback.expected || feedback.went_wrong;

  let toolCallsPretty: string | null = null;
  if (feedback.tool_calls != null) {
    try {
      toolCallsPretty = JSON.stringify(feedback.tool_calls, null, 2);
    } catch {
      toolCallsPretty = String(feedback.tool_calls);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/admin/feedback"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to Feedback
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="font-heading text-2xl font-bold text-foreground">Feedback detail</h1>
          <RatingBadge rating={feedback.rating} />
        </div>
        <p className="text-sm text-muted-foreground">{new Date(feedback.created_at).toLocaleString()}</p>
      </div>

      {hasFlags && (
        <Card className="border-amber-600/40 bg-amber-600/10">
          <CardHeader>
            <CardTitle className="text-amber-400">Flagged by user</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {feedback.comment && <TextBlock label="Comment" value={feedback.comment} />}
            {feedback.expected && <TextBlock label="Expected" value={feedback.expected} />}
            {feedback.went_wrong && <TextBlock label="What went wrong" value={feedback.went_wrong} />}
          </CardContent>
        </Card>
      )}

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Submission details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="User" value={feedback.email ?? "—"} />
          <Field label="User ID" value={<span className="font-mono text-xs">{feedback.user_id}</span>} />
          <Field label="Model" value={feedback.model ?? "—"} />
          <Field label="Mode" value={feedback.mode ?? "—"} />
          <Field label="Chat ID" value={<span className="font-mono text-xs">{feedback.chat_id ?? "—"}</span>} />
          <Field label="Session ID" value={<span className="font-mono text-xs">{feedback.session_id ?? "—"}</span>} />
        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Conversation</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <TextBlock label="Prompt" value={feedback.prompt_excerpt} />
          <TextBlock label="Response" value={feedback.response_excerpt} />
        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Tool calls</CardTitle>
        </CardHeader>
        <CardContent>
          {toolCallsPretty ? (
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs text-foreground">
              {toolCallsPretty}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">No tool calls recorded for this event.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
