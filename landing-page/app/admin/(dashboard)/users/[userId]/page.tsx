import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { supabaseAdmin } from "../../../../../lib/supabase/admin";
import { Badge } from "../../../../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Separator } from "../../../../../components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../../../components/ui/table";
import { SpendChart } from "../../../../../components/admin/spend-chart";
import { FeedbackTable, type AdminFeedbackRow } from "../../../../../components/admin/feedback-table";
import { ErrorReportsTable, type AdminErrorReportRow } from "../../../../../components/admin/error-reports-table";

export const dynamic = "force-dynamic";

type AuditEventRow = {
  id: string;
  tool_name: string;
  allowed: boolean;
  is_error: boolean;
  duration_ms: number | null;
  created_at: string;
};

type BudgetCapHitRow = {
  id: number;
  reason: string | null;
  created_at: string;
};

type AuthEventRow = {
  id: number;
  success: boolean;
  created_at: string;
};

type AdminUserUsageRow = {
  user_id: string;
  email: string | null;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  credit_limit_usd: number;
  last_used_at: string | null;
};

function formatUsd(n: number | null | undefined) {
  return `$${Number(n ?? 0).toFixed(4)}`;
}

function StatCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <Card className="bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold text-foreground">{value}</div>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// Groups raw usage_ledger rows into the {day, cost_usd, requests} shape
// admin_daily_spend/SpendChart expect. admin_daily_spend itself is a
// GLOBAL aggregate view with no user_id column (see supabase/schema.sql) —
// rather than adding a schema-changing per-user variant of that view, this
// aggregates the already-fetched, already-user-scoped usage_ledger rows in
// JS. Same trust boundary as the view: only ever run from the service-role
// admin client.
function toDailySpend(rows: { cost_usd: number; created_at: string }[]) {
  const byDay = new Map<string, { cost_usd: number; requests: number }>();
  for (const row of rows) {
    const day = new Date(row.created_at).toISOString().slice(0, 10);
    const entry = byDay.get(day) ?? { cost_usd: 0, requests: 0 };
    entry.cost_usd += Number(row.cost_usd);
    entry.requests += 1;
    byDay.set(day, entry);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day, ...v }));
}

export default async function AdminUserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const admin = supabaseAdmin();

  const [
    userRes,
    { data: usageRow },
    { data: ledgerRows },
    { data: feedbackRows },
    { data: auditRecent },
    { count: auditTotalCount },
    { count: auditBlockedCount },
    { count: auditErroredCount },
    { data: capHitsRecent },
    { count: capHitsCount },
    { data: authEventsRecent },
    { count: authSuccessCount },
    { count: authFailureCount },
    { data: errorReports },
  ] = await Promise.all([
    admin.auth.admin.getUserById(userId),
    admin.from("admin_user_usage").select("*").eq("user_id", userId).maybeSingle(),
    admin.from("usage_ledger").select("cost_usd, created_at").eq("user_id", userId).order("created_at", { ascending: true }),
    admin.from("admin_feedback_recent").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200),
    admin
      .from("audit_events")
      .select("id, tool_name, allowed, is_error, duration_ms, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),
    admin.from("audit_events").select("*", { count: "exact", head: true }).eq("user_id", userId),
    admin.from("audit_events").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("allowed", false),
    admin.from("audit_events").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("is_error", true),
    admin.from("budget_cap_hits").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
    admin.from("budget_cap_hits").select("*", { count: "exact", head: true }).eq("user_id", userId),
    admin.from("auth_events").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
    admin.from("auth_events").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("success", true),
    admin.from("auth_events").select("*", { count: "exact", head: true }).eq("user_id", userId).eq("success", false),
    admin.from("admin_error_reports_recent").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(100),
  ]);

  const authUser = userRes.data?.user;
  if (!authUser?.email) notFound();

  const usage = usageRow as AdminUserUsageRow | null;
  const dailySpend = toDailySpend((ledgerRows ?? []) as { cost_usd: number; created_at: string }[]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/admin/users" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Back to Users
        </Link>
        <h1 className="font-heading text-2xl font-bold text-foreground">{authUser.email}</h1>
        <p className="text-sm text-muted-foreground">
          Joined {authUser.created_at ? new Date(authUser.created_at).toLocaleString() : "—"} ·{" "}
          <span className="font-mono text-xs">{userId}</span>
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total spent" value={formatUsd(usage?.total_cost_usd)} sub={`cap ${formatUsd(usage?.credit_limit_usd ?? 20)}`} />
        <StatCard label="Tokens in / out" value={`${usage?.total_tokens_in ?? 0} / ${usage?.total_tokens_out ?? 0}`} />
        <StatCard
          label="Last used"
          value={usage?.last_used_at ? new Date(usage.last_used_at).toLocaleDateString() : "—"}
          sub={usage?.last_used_at ? new Date(usage.last_used_at).toLocaleTimeString() : undefined}
        />
        <StatCard label="Budget cap hits" value={capHitsCount ?? 0} sub="times allowed=false was returned" />
      </div>

      {dailySpend.length > 0 && (
        <SpendChart data={dailySpend} />
      )}

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Audit activity</CardTitle>
          <CardDescription>Coarse tool-call metadata mirrored from the local Royal-mode audit log (see audit_events in schema.sql).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{auditTotalCount ?? 0} tool calls</Badge>
            <Badge variant={auditBlockedCount ? "destructive" : "secondary"}>{auditBlockedCount ?? 0} blocked</Badge>
            <Badge variant={auditErroredCount ? "destructive" : "secondary"}>{auditErroredCount ?? 0} errored</Badge>
          </div>
          {(auditRecent ?? []).length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Tool</TableHead>
                    <TableHead>Allowed</TableHead>
                    <TableHead>Error</TableHead>
                    <TableHead>Duration</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(auditRecent as AuditEventRow[]).map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{new Date(row.created_at).toLocaleString()}</TableCell>
                      <TableCell className="font-medium">{row.tool_name}</TableCell>
                      <TableCell>
                        {row.allowed ? <Badge variant="secondary">yes</Badge> : <Badge variant="destructive">no</Badge>}
                      </TableCell>
                      <TableCell>{row.is_error ? <Badge variant="destructive">yes</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-muted-foreground">{row.duration_ms != null ? `${row.duration_ms}ms` : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No audit events recorded for this user.</p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="bg-card">
          <CardHeader>
            <CardTitle>Budget-cap hits</CardTitle>
            <CardDescription>{capHitsCount ?? 0} total — recent reasons check_budget() returned allowed:false.</CardDescription>
          </CardHeader>
          <CardContent>
            {(capHitsRecent ?? []).length > 0 ? (
              <ul className="flex flex-col gap-2">
                {(capHitsRecent as BudgetCapHitRow[]).map((hit) => (
                  <li key={hit.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                    <span className="text-foreground">{hit.reason ?? "—"}</span>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">{new Date(hit.created_at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">This user has never hit a budget cap.</p>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardHeader>
            <CardTitle>Auth events</CardTitle>
            <CardDescription>
              {authSuccessCount ?? 0} successful login{(authSuccessCount ?? 0) === 1 ? "" : "s"}, {authFailureCount ?? 0} failed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {(authEventsRecent ?? []).length > 0 ? (
              <ul className="flex flex-col gap-2">
                {(authEventsRecent as AuthEventRow[]).map((ev) => (
                  <li key={ev.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                    {ev.success ? (
                      <Badge className="bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/20">success</Badge>
                    ) : (
                      <Badge variant="destructive">failed</Badge>
                    )}
                    <span className="whitespace-nowrap text-xs text-muted-foreground">{new Date(ev.created_at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No auth events recorded for this user.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Separator />

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Feedback history</CardTitle>
          <CardDescription>{(feedbackRows ?? []).length} submissions from this user.</CardDescription>
        </CardHeader>
        <CardContent>
          <FeedbackTable data={(feedbackRows ?? []) as AdminFeedbackRow[]} />
        </CardContent>
      </Card>

      <Card className="bg-card">
        <CardHeader>
          <CardTitle>Error reports</CardTitle>
          <CardDescription>{(errorReports ?? []).length} reports submitted by this user.</CardDescription>
        </CardHeader>
        <CardContent>
          <ErrorReportsTable data={(errorReports ?? []) as AdminErrorReportRow[]} />
        </CardContent>
      </Card>
    </div>
  );
}
