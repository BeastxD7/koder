-- LakshX hosted-model backend: usage tracking + budget enforcement.
-- Run this once against a fresh Supabase project (SQL Editor -> New query -> paste -> Run).
--
-- Security model: RLS lets a signed-in user read ONLY their own usage/budget
-- rows via the anon/authenticated key (which ships inside the IDE and is not
-- a secret). All WRITES, and the budget check itself, go through
-- SECURITY DEFINER functions callable only by the service-role key, which
-- lives solely in the Vercel proxy's server-side env — never in the client.
-- Without this split, a user could forge a favorable "cost" for their own
-- usage row, or read every other user's spend.

create table if not exists public.usage_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  tokens_in bigint not null,
  tokens_out bigint not null,
  cost_usd numeric(10,4) not null,
  created_at timestamptz not null default now()
);
create index if not exists usage_ledger_user_id_idx on public.usage_ledger(user_id);
-- `model`: which hosted deployment served this request (e.g. "gpt-5-mini").
-- Nullable + added after the fact via ALTER (not baked into the CREATE TABLE
-- above) so this stays safely re-runnable against the already-live table.
-- Existing rows predate this column and are simply null — that's fine, they
-- were all gpt-5-mini anyway (there was only ever one hosted model until
-- now). Added specifically so record_usage() can price correctly once a
-- second Foundry model is deployed (see PRICE_PER_1M_BY_MODEL in both
-- lakshx-model proxy routes) and so admin can see spend broken down by
-- model once there's more than one to compare.
alter table public.usage_ledger add column if not exists model text;

create table if not exists public.user_budget (
  user_id uuid primary key references auth.users(id) on delete cascade,
  credit_limit_usd numeric(10,2) not null default 5.00
);

-- Singleton row (id is always `true`) tracking total spend against the
-- $1000 Azure credit. Ceiling defaults to $800 (80% of credit, 20% buffer
-- for the last in-flight request's overshoot + Azure billing lag).
create table if not exists public.global_budget (
  id boolean primary key default true check (id),
  ceiling_usd numeric(10,2) not null default 800.00,
  -- numeric(12,4), not (10,2): individual request costs are fractions of a
  -- cent (e.g. $0.0001), and this column accumulates thousands of them —
  -- cent precision silently rounds every increment away to nothing.
  spent_usd numeric(12,4) not null default 0.00
);
insert into public.global_budget (id) values (true) on conflict (id) do nothing;

alter table public.usage_ledger enable row level security;
create policy "users read own usage" on public.usage_ledger
  for select using (auth.uid() = user_id);
-- no insert/update/delete policy for anon/authenticated -> default deny.
-- writes happen exclusively via record_usage() below, using the service-role key.

alter table public.user_budget enable row level security;
create policy "users read own budget" on public.user_budget
  for select using (auth.uid() = user_id);

alter table public.global_budget enable row level security;
-- no policies at all -> default deny for anon/authenticated; only
-- service-role (which bypasses RLS entirely) can touch this table.

-- Pre-request gate: called by the proxy BEFORE forwarding to Azure. Reads
-- the running totals directly from source-of-truth tables (no cache, no
-- eventually-consistent counter) so the check is as fresh as the DB allows.
-- Auto-provisions a user_budget row (default $5) on first use.
--
-- TOCTOU note (row lock below), stated honestly: the proxy calls this
-- function and record_usage() as two SEPARATE `supabase.rpc()` calls (see
-- app/api/lakshx-model/{chat/completions,responses}/route.ts) — each its own
-- implicit transaction, with no connection/transaction shared between them.
-- The `select ... for update` below takes an exclusive lock on this user's
-- user_budget row and genuinely serializes concurrent check_budget() calls
-- for the SAME user against EACH OTHER (a second call's lock acquisition
-- blocks until the first call's transaction ends). But — and this is the
-- part worth being precise about — that alone does NOT prevent two
-- concurrent requests from both overshooting the cap under the CURRENT
-- architecture: record_usage() never touches user_budget at all (its body
-- below only writes usage_ledger and updates global_budget), so it never
-- contends for this lock, at any request spacing, back-to-back or
-- simultaneous. Trace it through: A.check_budget() runs, commits (releasing
-- the lock), having read a spend total that doesn't yet include A's own
-- request; B.check_budget() then acquires the lock, but reads that SAME
-- pre-A-write total (nothing has changed it) and also passes; only later do
-- A.record_usage() and B.record_usage() both post, and by then both checks
-- already said yes. So today, this lock closes NO real-world instance of the
-- race by itself — real overshoot protection continues to come entirely
-- from the deliberate buffer already built into the ceilings themselves
-- (global_budget's ceiling_usd defaults to $800, 80% of the true $1000
-- credit, specifically to absorb exactly this kind of overshoot — see its
-- comment above).
--
-- What this lock DOES do is put the serialization point in the right place
-- for the future: user_budget is the correct row to hold locked across BOTH
-- the check and the eventual write, so if a later change ever wraps
-- check_budget() + record_usage() in one explicit transaction for the same
-- request (the fully-correct fix), this lock is exactly the primitive that
-- makes that refactor race-free — no further schema change would be needed,
-- only a caller-side transaction wrapper. That caller re-architecture (a
-- single atomic check+reserve+finalize call) was judged a bigger change
-- than this pass warrants for a low-concurrency, pre-revenue product; this
-- lock is added now so it's already in place, correctly scoped, whenever
-- that caller-side work happens.
create or replace function public.check_budget(p_user_id uuid, p_default_limit numeric default 5.00)
returns table(allowed boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  user_spent numeric;
  user_limit numeric;
  global_spent numeric;
  global_ceiling numeric;
begin
  -- Provision the row BEFORE locking it: `for update` locks rows that
  -- already exist, so a lock attempt against a not-yet-created row locks
  -- nothing and two concurrent first-time callers for a brand-new user
  -- would both sail through unserialized. `insert ... on conflict do
  -- nothing` itself blocks a concurrent inserter of the same user_id until
  -- the first inserter's transaction commits, so this ordering is safe even
  -- when two first-ever requests for the same user land at the same time.
  insert into user_budget (user_id, credit_limit_usd) values (p_user_id, p_default_limit)
    on conflict (user_id) do nothing;

  -- Row-level lock: takes an exclusive lock on this user's user_budget row
  -- for the rest of THIS function's transaction. A second concurrent
  -- check_budget() call for the same user_id blocks right here until the
  -- first call's transaction ends, then reads whatever the first call left
  -- behind. See the TOCTOU note above this function for exactly what this
  -- does and does not guarantee.
  select credit_limit_usd into user_limit from user_budget where user_id = p_user_id for update;

  select coalesce(sum(cost_usd), 0) into user_spent from usage_ledger where user_id = p_user_id;
  select spent_usd, ceiling_usd into global_spent, global_ceiling from global_budget where id = true;

  if global_spent >= global_ceiling then
    return query select false, 'global_ceiling_reached';
  elsif user_spent >= user_limit then
    return query select false, 'user_cap_reached';
  else
    return query select true, null::text;
  end if;
end;
$$;

-- Post-request record: called by the proxy AFTER the stream ends, once
-- actual token usage is known. Appends the ledger row and atomically bumps
-- the global running total in the same statement set.
-- Adding p_model as a genuinely new parameter changes this function's
-- signature — `create or replace` only replaces a function with the EXACT
-- SAME argument list, otherwise Postgres just adds a second overload
-- alongside the old one. Drop the old 4-arg version explicitly first so
-- there's never a stale duplicate overload silently sitting alongside this.
drop function if exists public.record_usage(uuid, bigint, bigint, numeric);

create or replace function public.record_usage(p_user_id uuid, p_tokens_in bigint, p_tokens_out bigint, p_cost_usd numeric, p_model text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into usage_ledger (user_id, tokens_in, tokens_out, cost_usd, model)
    values (p_user_id, p_tokens_in, p_tokens_out, p_cost_usd, p_model);
  update global_budget set spent_usd = spent_usd + p_cost_usd where id = true;
end;
$$;

-- Lock these down to the service role only — never callable with the
-- anon/authenticated key, or any signed-in user could forge their own cost.
revoke all on function public.check_budget(uuid, numeric) from public, anon, authenticated;
revoke all on function public.record_usage(uuid, bigint, bigint, numeric, text) from public, anon, authenticated;
grant execute on function public.check_budget(uuid, numeric) to service_role;
grant execute on function public.record_usage(uuid, bigint, bigint, numeric, text) to service_role;

-- Admin dashboard convenience view — per-user total spend + their cap.
-- Also service-role only (no grants to anon/authenticated); the /admin
-- route reads this with the service-role key from a server-side handler.
--
-- plan/subscription_status added so the users list can show + edit plan
-- directly (updateUserPlan(), app/admin/actions.ts) without a second query
-- per row — left join because most rows won't have a user_subscription row
-- yet (Free by omission, same fallback getEffectivePlan() uses).
create or replace view public.admin_user_usage as
select
  u.id as user_id,
  u.email,
  coalesce(sum(l.cost_usd), 0) as total_cost_usd,
  coalesce(sum(l.tokens_in), 0) as total_tokens_in,
  coalesce(sum(l.tokens_out), 0) as total_tokens_out,
  b.credit_limit_usd,
  max(l.created_at) as last_used_at,
  coalesce(s.plan, 'free') as plan,
  s.status as subscription_status
from auth.users u
left join usage_ledger l on l.user_id = u.id
left join user_budget b on b.user_id = u.id
left join user_subscription s on s.user_id = u.id
group by u.id, u.email, b.credit_limit_usd, s.plan, s.status;

revoke all on public.admin_user_usage from public, anon, authenticated;
grant select on public.admin_user_usage to service_role;

-- Admin dashboard convenience view — daily spend/request-count, for the
-- spend-over-time chart. Aggregated in Postgres rather than pulling raw
-- usage_ledger rows to the client, same service-role-only access pattern.
create or replace view public.admin_daily_spend as
select
  date_trunc('day', created_at) as day,
  sum(cost_usd) as cost_usd,
  count(*) as requests
from usage_ledger
group by 1
order by 1;

revoke all on public.admin_daily_spend from public, anon, authenticated;
grant select on public.admin_daily_spend to service_role;

-- IDE feedback telemetry: thumbs up/down/retry submitted from the chat
-- panel's review form (see product/lakshx-chat/extension.js's
-- logFeedback()/`case "feedback"` — this table is the cloud mirror of the
-- local ~/.lakshx/feedback/<yyyy-mm>.jsonl file that already existed).
-- Prompt/response text is truncated at insert time (see
-- record_feedback_event() below) — this is telemetry for aggregate rating
-- analytics, not a full transcript store.
create table if not exists public.feedback_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  rating text not null check (rating in ('up', 'down', 'retry')),
  model text,
  mode text,
  chat_id text,
  session_id text,
  prompt_excerpt text,
  response_excerpt text,
  tool_calls jsonb,
  -- free-text from the review form: "comment" accompanies a thumbs-up,
  -- "expected"/"went_wrong" accompany a thumbs-down (see panel.js's
  -- .fb-comment/.fb-expected/.fb-wrong fields). Same 2000-char truncation
  -- as the prompt/response excerpts.
  comment text,
  expected text,
  went_wrong text,
  created_at timestamptz not null default now()
);
create index if not exists feedback_events_user_id_idx on public.feedback_events(user_id);
create index if not exists feedback_events_created_at_idx on public.feedback_events(created_at);

alter table public.feedback_events enable row level security;
-- no policies at all -> default deny for anon/authenticated; only
-- service-role (which bypasses RLS entirely) can touch this table, same as
-- global_budget above. Writes happen exclusively via
-- record_feedback_event() below, called from the /api/feedback route with
-- the service-role key, after that route has independently verified the
-- caller's Supabase session token.

-- Insert path for the /api/feedback route. A SECURITY DEFINER function
-- (rather than a plain service-role insert) so the 2000-char excerpt
-- truncation is enforced in one place regardless of caller, matching
-- record_usage()'s "server decides the shape of what lands in the ledger"
-- pattern above.
create or replace function public.record_feedback_event(
  p_user_id uuid,
  p_rating text,
  p_model text,
  p_mode text,
  p_chat_id text,
  p_session_id text,
  p_prompt_excerpt text,
  p_response_excerpt text,
  p_tool_calls jsonb,
  p_comment text default null,
  p_expected text default null,
  p_went_wrong text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  insert into feedback_events (
    user_id, rating, model, mode, chat_id, session_id,
    prompt_excerpt, response_excerpt, tool_calls, comment, expected, went_wrong
  ) values (
    p_user_id, p_rating, p_model, p_mode, p_chat_id, p_session_id,
    left(p_prompt_excerpt, 2000), left(p_response_excerpt, 2000), p_tool_calls,
    left(p_comment, 2000), left(p_expected, 2000), left(p_went_wrong, 2000)
  )
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.record_feedback_event(uuid, text, text, text, text, text, text, text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.record_feedback_event(uuid, text, text, text, text, text, text, text, jsonb, text, text, text) to service_role;

-- Admin dashboard convenience view — per-day rating counts, for the
-- ratings-over-time chart. Same aggregate-in-Postgres, service-role-only
-- pattern as admin_daily_spend above.
create or replace view public.admin_feedback_summary as
select
  date_trunc('day', created_at) as day,
  count(*) filter (where rating = 'up') as up_count,
  count(*) filter (where rating = 'down') as down_count,
  count(*) filter (where rating = 'retry') as retry_count,
  count(*) as total_count
from feedback_events
group by 1
order by 1;

revoke all on public.admin_feedback_summary from public, anon, authenticated;
grant select on public.admin_feedback_summary to service_role;

-- Admin dashboard convenience view — latest feedback events with the
-- submitting user's email joined in, for the recent-feedback table view.
create or replace view public.admin_feedback_recent as
select
  f.id,
  f.user_id,
  u.email,
  f.rating,
  f.model,
  f.mode,
  f.chat_id,
  f.session_id,
  f.prompt_excerpt,
  f.response_excerpt,
  f.tool_calls,
  f.comment,
  f.expected,
  f.went_wrong,
  f.created_at
from feedback_events f
left join auth.users u on u.id = f.user_id
order by f.created_at desc;

revoke all on public.admin_feedback_recent from public, anon, authenticated;
grant select on public.admin_feedback_recent to service_role;

-- =============================================================================
-- Migration: cloud audit metadata, budget-cap-hit logging, auth events, and a
-- self-service usage RPC. Four independent additions, appended together as one
-- paste (see this file's header comment for the SQL-Editor workflow).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Metadata-only cloud audit log.
--
-- The REAL audit trail for Royal mode is, and remains, purely local:
-- ~/.lakshx/royal-audit/<yyyy-mm>.jsonl (see agent/src/audit.ts's
-- logRoyalAudit()) — full scrubbed tool input, cwd, output summaries. That
-- file's whole trust story is "this never leaves your machine," and this
-- table does NOT change that: it mirrors ONLY coarse metadata (which tool,
-- was it allowed, did it error, how long it took) for the hosted-model users'
-- admin dashboard, never the scrubbed input/cwd/output content itself. See
-- agent/src/loop.ts's postAuditMetadata() for the (opt-in-by-provider,
-- fire-and-forget, best-effort) caller.
-- -----------------------------------------------------------------------------
create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tool_name text not null,
  allowed boolean not null,
  is_error boolean not null default false,
  duration_ms integer,
  created_at timestamptz not null default now()
);
create index if not exists audit_events_user_id_idx on public.audit_events(user_id);
create index if not exists audit_events_created_at_idx on public.audit_events(created_at);

alter table public.audit_events enable row level security;
-- no policies at all -> default deny for anon/authenticated; only
-- service-role (which bypasses RLS entirely) can touch this table, same as
-- global_budget/feedback_events above. Writes happen exclusively via
-- record_audit_event() below, called from the /api/audit route with the
-- service-role key, after that route has independently verified the
-- caller's Supabase session token.

create or replace function public.record_audit_event(
  p_user_id uuid,
  p_tool_name text,
  p_allowed boolean,
  p_is_error boolean,
  p_duration_ms integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  insert into audit_events (user_id, tool_name, allowed, is_error, duration_ms)
    -- left(): defense in depth, matching record_feedback_event()'s truncation
    -- pattern above — tool_name is always a short literal tool id in
    -- practice, but never trust the caller's shape unbounded.
    values (p_user_id, left(p_tool_name, 200), p_allowed, p_is_error, p_duration_ms)
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.record_audit_event(uuid, text, boolean, boolean, integer) from public, anon, authenticated;
grant execute on function public.record_audit_event(uuid, text, boolean, boolean, integer) to service_role;

-- Admin dashboard convenience view — per-day counts by tool_name/allowed,
-- same aggregate-in-Postgres, service-role-only pattern as
-- admin_feedback_summary above.
create or replace view public.admin_audit_summary as
select
  date_trunc('day', created_at) as day,
  tool_name,
  allowed,
  count(*) as total_count,
  count(*) filter (where is_error) as error_count
from audit_events
group by 1, 2, 3
order by 1, 2;

revoke all on public.admin_audit_summary from public, anon, authenticated;
grant select on public.admin_audit_summary to service_role;

-- -----------------------------------------------------------------------------
-- 2. Budget-cap (429) hit logging — persists the fact that check_budget()
-- returned allowed:false, so the admin dashboard can see how often/why users
-- are hitting their cap or the global ceiling (reason mirrors check_budget()'s
-- 'user_cap_reached' / 'global_ceiling_reached' / RPC-failure strings).
-- -----------------------------------------------------------------------------
create table if not exists public.budget_cap_hits (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists budget_cap_hits_user_id_idx on public.budget_cap_hits(user_id);
create index if not exists budget_cap_hits_created_at_idx on public.budget_cap_hits(created_at);

alter table public.budget_cap_hits enable row level security;
-- no policies at all -> default deny for anon/authenticated; only
-- service-role can touch this table. Writes happen exclusively via
-- record_budget_cap_hit() below, called from both lakshx-model routes right
-- where they already return the 429.

create or replace function public.record_budget_cap_hit(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into budget_cap_hits (user_id, reason) values (p_user_id, left(p_reason, 200));
end;
$$;

revoke all on function public.record_budget_cap_hit(uuid, text) from public, anon, authenticated;
grant execute on function public.record_budget_cap_hit(uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- 3. Auth event logging — success/failure of every session-establishing or
-- session-renewing event, not just the admin web login this table originally
-- covered. user_id is nullable: a FAILED exchange/refresh sometimes means we
-- don't yet know who the user is (or the refresh token was already dead, so
-- there's no reliable identity to attach), so failures are logged with a
-- null user_id rather than dropped, giving the admin dashboard visibility
-- into failure volume even though it can't attribute every failure to a
-- person.
--
-- `event_type` distinguishes WHERE a login/refresh happened, which matters
-- for actually diagnosing session problems (e.g. "the IDE's background
-- refresh keeps failing" vs "the admin web login is fine") — see
-- product/lakshx-chat/extension.js's scheduleLakshxRefresh() and the
-- lakshx:// URI handler for the ide_refresh / ide_login call sites, and
-- app/auth/callback/route.ts for admin_web_login.
-- -----------------------------------------------------------------------------
create table if not exists public.auth_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  success boolean not null,
  event_type text not null default 'admin_web_login',
  created_at timestamptz not null default now()
);
create index if not exists auth_events_user_id_idx on public.auth_events(user_id);
create index if not exists auth_events_created_at_idx on public.auth_events(created_at);
create index if not exists auth_events_event_type_idx on public.auth_events(event_type);

alter table public.auth_events enable row level security;
-- no policies at all -> default deny for anon/authenticated; only
-- service-role can touch this table. Writes happen exclusively via
-- record_auth_event() below, called either from the admin auth callback
-- route (service-role key directly — the SSR client used to exchange the
-- code there is authenticated AS the signed-in user post-exchange, and
-- cannot call a service-role-only function) or from the new /api/auth-event
-- route on the IDE's behalf (same bearer-token pattern as /api/feedback,
-- /api/agent-incident).

-- `p_event_type` default matches the table's own default so the existing
-- admin-callback call site (which never passed this argument) keeps working
-- unchanged.
create or replace function public.record_auth_event(p_user_id uuid, p_success boolean, p_event_type text default 'admin_web_login')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into auth_events (user_id, success, event_type) values (p_user_id, p_success, left(p_event_type, 50));
end;
$$;

revoke all on function public.record_auth_event(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.record_auth_event(uuid, boolean, text) to service_role;

-- -----------------------------------------------------------------------------
-- 4. Self-service usage RPC — backs an IDE-side "your usage" display. Unlike
-- every other function in this file, this one is deliberately callable by
-- ANY signed-in user with their own session (grant to `authenticated`, not
-- service_role-only): it takes no parameters and derives everything from
-- auth.uid(), so a user can only ever see their OWN usage, never another
-- user's, and never global_budget's company-wide ceiling/spend (that stays
-- admin-only, surfaced solely via the admin_* views above).
-- -----------------------------------------------------------------------------
create or replace function public.get_my_usage()
returns table(spent_usd numeric, credit_limit_usd numeric, tokens_in bigint, tokens_out bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    coalesce((select sum(l.cost_usd) from usage_ledger l where l.user_id = auth.uid()), 0)::numeric,
    -- same default as check_budget()'s p_default_limit when no user_budget
    -- row exists yet for this user (e.g. they've never made a hosted-model
    -- request, so check_budget() has never had a chance to provision one).
    coalesce((select b.credit_limit_usd from user_budget b where b.user_id = auth.uid()), 5.00)::numeric,
    coalesce((select sum(l.tokens_in) from usage_ledger l where l.user_id = auth.uid()), 0)::bigint,
    coalesce((select sum(l.tokens_out) from usage_ledger l where l.user_id = auth.uid()), 0)::bigint;
end;
$$;

revoke all on function public.get_my_usage() from public, anon;
grant execute on function public.get_my_usage() to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Error reports: the IDE chat panel's "Report" button on an error message
-- (see product/lakshx-chat's buildDiagnosticReport()) POSTs here via
-- /api/error-report so an admin can see the FULL session context behind a
-- user-visible error, not just the sanitized one-line message the panel
-- itself shows (see agent/src/providers/types.ts's httpErrorMessage() for
-- why the panel never displays a raw error body in the first place — this
-- table is the escape hatch for when an admin needs the raw detail anyway).
--
-- diagnostic_report is a full text dump of the session (transcript,
-- workspace name, chat title/id, session id, model, mode) — genuinely larger
-- than every other free-text field in this file, hence the wider 50000-char
-- truncation ceiling below (vs. 2000 elsewhere). Same default-deny RLS +
-- SECURITY DEFINER + service-role-only pattern as feedback_events/
-- audit_events above: writes happen exclusively via record_error_report(),
-- called from /api/error-report after that route independently verifies the
-- caller's Supabase session token.
-- -----------------------------------------------------------------------------
create table if not exists public.error_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  error_message text not null,
  diagnostic_report text,
  model text,
  mode text,
  created_at timestamptz not null default now()
);
create index if not exists error_reports_user_id_idx on public.error_reports(user_id);
create index if not exists error_reports_created_at_idx on public.error_reports(created_at);

alter table public.error_reports enable row level security;
-- no policies at all -> default deny for anon/authenticated; only
-- service-role can touch this table. Writes happen exclusively via
-- record_error_report() below, called from the /api/error-report route with
-- the service-role key.

create or replace function public.record_error_report(
  p_user_id uuid,
  p_error_message text,
  p_diagnostic_report text,
  p_model text,
  p_mode text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  insert into error_reports (
    user_id, error_message, diagnostic_report, model, mode
  ) values (
    p_user_id, left(p_error_message, 2000), left(p_diagnostic_report, 50000), p_model, p_mode
  )
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.record_error_report(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_error_report(uuid, text, text, text, text) to service_role;

-- Admin dashboard convenience view — latest error reports with the
-- submitting user's email joined in, same shape/pattern as
-- admin_feedback_recent above (no LIMIT here — the admin page applies its
-- own `.limit()` when querying this view).
create or replace view public.admin_error_reports_recent as
select
  r.id,
  r.user_id,
  u.email,
  r.error_message,
  r.diagnostic_report,
  r.model,
  r.mode,
  r.created_at
from error_reports r
left join auth.users u on u.id = r.user_id
order by r.created_at desc;

revoke all on public.admin_error_reports_recent from public, anon, authenticated;
grant select on public.admin_error_reports_recent to service_role;

-- -----------------------------------------------------------------------------
-- 6. Agent runtime incidents: the agent child process crashing/failing to
-- spawn (extension.js's ensureAgent() — `onError` "agent failed to start"
-- and `onExit` "agent exited (code)" handlers), or a turn timing out
-- (acp-client.js's AcpClient.request() watchdog — PROMPT_REQUEST_TIMEOUT_MS,
-- 30 min, surfaced to extension.js's sendPrompt() catch block as "request
-- ... timed out after ...ms ... may be wedged"). Previously this only ever
-- showed up as a local IDE chat "system" message — nothing reached any
-- admin-visible table. This is the aggregate-visibility fix for that gap.
--
-- Deliberately a short reason string, not a log dump: `detail` is truncated
-- to 500 chars (see record_agent_incident() below) — error_reports already
-- exists for the "full session transcript" case via the panel's Report
-- button. Same default-deny RLS + SECURITY DEFINER + service-role-only
-- pattern as every other telemetry table in this file: writes happen
-- exclusively via record_agent_incident(), called from the
-- /api/agent-incident route with the service-role key, after that route
-- independently verifies the caller's Supabase session token.
-- -----------------------------------------------------------------------------
create table if not exists public.agent_incidents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  incident_type text not null check (incident_type in ('crash', 'timeout')),
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists agent_incidents_user_id_idx on public.agent_incidents(user_id);
create index if not exists agent_incidents_created_at_idx on public.agent_incidents(created_at);

alter table public.agent_incidents enable row level security;
-- no policies at all -> default deny for anon/authenticated; only
-- service-role can touch this table, same as audit_events/error_reports
-- above.

create or replace function public.record_agent_incident(
  p_user_id uuid,
  p_incident_type text,
  p_detail text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  insert into agent_incidents (user_id, incident_type, detail)
    -- left(): same defense-in-depth truncation pattern as
    -- record_feedback_event()/record_error_report() above. incident_type's
    -- check constraint already restricts it to 'crash'/'timeout', but the
    -- route-level validation (returning a clean 400) is what actually
    -- prevents a caller from ever hitting that constraint and getting a 500.
    values (p_user_id, p_incident_type, left(p_detail, 500))
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.record_agent_incident(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_agent_incident(uuid, text, text) to service_role;

-- Admin dashboard convenience view — latest agent incidents with the
-- affected user's email joined in, same shape/pattern as
-- admin_error_reports_recent above. No admin UI reads this yet (schema +
-- logging call site only, per this migration's scope) — an admin page for
-- this can follow later using the same pattern as the existing admin_*
-- pages.
create or replace view public.admin_agent_incidents_recent as
select
  i.id,
  i.user_id,
  u.email,
  i.incident_type,
  i.detail,
  i.created_at
from agent_incidents i
left join auth.users u on u.id = i.user_id
order by i.created_at desc;

revoke all on public.admin_agent_incidents_recent from public, anon, authenticated;
grant select on public.admin_agent_incidents_recent to service_role;

-- -----------------------------------------------------------------------------
-- 7. Dodo Payments subscriptions: LakshX Pro ($15/mo, product pdt_0NjVgn2Le
-- GJ7YL6KvcG2T in test mode) is the first paid tier. This table is the
-- durable link between a Supabase user and their Dodo subscription state —
-- populated ONLY by the /api/webhooks/dodo route (via
-- upsert_subscription_from_webhook() below, service-role key), never
-- writable by anon/authenticated (a user forging their own row would grant
-- themselves Pro for free). `plan`/`status` drive check_budget()'s cap
-- logic below: Free gets a LIFETIME $5 cap; Pro gets
-- a separate, resetting MONTHLY cap tied to current_period_start/end (the
-- subscription's actual billing cycle, from Dodo's previous_billing_date/
-- next_billing_date — not a calendar-month approximation).
-- -----------------------------------------------------------------------------
create table if not exists public.user_subscription (
  user_id uuid primary key references auth.users(id) on delete cascade,
  dodo_customer_id text,
  dodo_subscription_id text,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  -- Mirrors Dodo's SubscriptionStatus enum exactly (pending/active/on_hold/
  -- cancelled/failed/expired) so webhook payloads map straight across
  -- without translation.
  status text not null default 'active' check (status in ('pending', 'active', 'on_hold', 'cancelled', 'failed', 'expired')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists user_subscription_dodo_subscription_id_idx on public.user_subscription(dodo_subscription_id);

alter table public.user_subscription enable row level security;
create policy "users read own subscription" on public.user_subscription
  for select using (auth.uid() = user_id);
-- no insert/update/delete policy for anon/authenticated -> default deny.
-- writes happen exclusively via upsert_subscription_from_webhook() below.

-- Called by /api/webhooks/dodo on subscription.active/renewed/on_hold/
-- cancelled/failed/expired events, after that route independently verifies
-- the Standard Webhooks signature. Upsert (not insert-only) because the
-- SAME user_id gets repeated events over the subscription's lifetime
-- (renewed every billing cycle, on_hold on a failed charge, etc).
create or replace function public.upsert_subscription_from_webhook(
  p_user_id uuid,
  p_dodo_customer_id text,
  p_dodo_subscription_id text,
  p_plan text,
  p_status text,
  p_current_period_start timestamptz,
  p_current_period_end timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into user_subscription (
    user_id, dodo_customer_id, dodo_subscription_id, plan, status,
    current_period_start, current_period_end, updated_at
  ) values (
    p_user_id, p_dodo_customer_id, p_dodo_subscription_id, p_plan, p_status,
    p_current_period_start, p_current_period_end, now()
  )
  on conflict (user_id) do update set
    dodo_customer_id = excluded.dodo_customer_id,
    dodo_subscription_id = excluded.dodo_subscription_id,
    plan = excluded.plan,
    status = excluded.status,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    updated_at = now();
end;
$$;

revoke all on function public.upsert_subscription_from_webhook(uuid, text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.upsert_subscription_from_webhook(uuid, text, text, text, text, timestamptz, timestamptz) to service_role;

-- Admin dashboard convenience view — every subscriber with their email
-- joined in, same shape/pattern as admin_error_reports_recent above.
create or replace view public.admin_subscriptions_recent as
select
  s.user_id,
  u.email,
  s.dodo_customer_id,
  s.dodo_subscription_id,
  s.plan,
  s.status,
  s.current_period_start,
  s.current_period_end,
  s.updated_at
from user_subscription s
left join auth.users u on u.id = s.user_id
order by s.updated_at desc;

revoke all on public.admin_subscriptions_recent from public, anon, authenticated;
grant select on public.admin_subscriptions_recent to service_role;

-- Replaces the Free-only check_budget() from section 1 above with a
-- plan-aware version. SAME signature (p_user_id uuid, p_default_limit
-- numeric) as before, so `create or replace` is safe here — no `drop
-- function` needed (only a changed ARGUMENT LIST requires that, per the
-- record_usage()/record_auth_event() precedents earlier in this file).
--
-- Free-tier behavior is BYTE-FOR-BYTE unchanged (lifetime cap against
-- user_budget.credit_limit_usd) for anyone with no user_subscription row,
-- or a non-('pro','active') row (on_hold/cancelled/failed/expired all fall
-- back to Free behavior — fail closed, not open, on any billing hiccup).
create or replace function public.check_budget(p_user_id uuid, p_default_limit numeric default 5.00)
returns table(allowed boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  user_limit numeric;
  user_spent numeric;
  global_spent numeric;
  global_ceiling numeric;
  sub_plan text;
  sub_status text;
  period_start timestamptz;
  -- $10/mo internal cost cap on the $15/mo Pro plan — see the business-model
  -- note this was derived from: ~$1.30 Dodo fee leaves ~$13.70 net, a $10
  -- cap leaves a ~$3.70/user/mo margin floor even at full utilization.
  pro_monthly_cap_usd constant numeric := 10.00;
begin
  insert into user_budget (user_id, credit_limit_usd) values (p_user_id, p_default_limit)
    on conflict (user_id) do nothing;

  select credit_limit_usd into user_limit from user_budget where user_id = p_user_id for update;

  select spent_usd, ceiling_usd into global_spent, global_ceiling from global_budget where id = true;
  if global_spent >= global_ceiling then
    return query select false, 'global_ceiling_reached';
    return;
  end if;

  select plan, status, current_period_start into sub_plan, sub_status, period_start
    from user_subscription where user_id = p_user_id;

  if sub_plan = 'pro' and sub_status = 'active' then
    select coalesce(sum(cost_usd), 0) into user_spent
      from usage_ledger
      where user_id = p_user_id
        -- period_start should always be set for an active Pro row (the
        -- webhook always supplies it), but fall back to a 30-day lookback
        -- rather than an unbounded sum if it's ever null, so a data gap
        -- degrades to "roughly monthly" instead of "lifetime" for a Pro user.
        and created_at >= coalesce(period_start, now() - interval '30 days');
    if user_spent >= pro_monthly_cap_usd then
      return query select false, 'pro_monthly_cap_reached';
    else
      return query select true, null::text;
    end if;
  else
    select coalesce(sum(cost_usd), 0) into user_spent from usage_ledger where user_id = p_user_id;
    if user_spent >= user_limit then
      return query select false, 'user_cap_reached';
    else
      return query select true, null::text;
    end if;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Admin-configurable per-model plan gate (docs/research: "which model goes to
-- pro and which goes to free... it might be dynamic based on admin's choice").
-- Replaces the hosted-model proxy routes' old hardcoded FREE_TIER_MODELS
-- constant (found live: a Free user could select and bill against ANY
-- deployed model, not just gpt-5-mini) with an admin-editable table, so
-- moving a model between tiers is an admin-panel action, not a code+redeploy
-- cycle. `required_plan` intentionally matches user_subscription.plan's
-- check constraint values exactly (only 'free'/'pro' exist today) — adding a
-- third tier later means widening BOTH check constraints together, not
-- introducing a new comparison scheme.
--
-- No row for a given model = fail CLOSED to 'pro' (see landing-page/lib/
-- hosted-models.ts's getRequiredPlan) — a newly-deployed-but-not-yet-
-- configured model is never accidentally Free-accessible by omission.
create table if not exists public.hosted_model_plans (
  model text primary key,
  required_plan text not null default 'pro' check (required_plan in ('free', 'pro')),
  updated_at timestamptz not null default now()
);

-- Seed with today's known-good policy (gpt-5-mini free, everything else
-- pro) so applying this migration is a pure no-op for actual runtime
-- behavior — the whole point is an admin can now change it going forward,
-- not that behavior changes the moment this table is created.
insert into public.hosted_model_plans (model, required_plan) values
  ('gpt-5-mini', 'free'),
  ('gpt-5-4-mini', 'pro'),
  ('gpt-oss-120b', 'pro'),
  ('grok-4-1-fast-reasoning', 'pro'),
  ('deepseek-v4-pro', 'pro'),
  ('codestral-2501', 'pro'),
  ('llama-4-maverick', 'pro'),
  ('kimi-k2-7-code', 'pro'),
  ('kimi-k2-6', 'pro')
on conflict (model) do nothing;

alter table public.hosted_model_plans enable row level security;
-- no policies at all -> default deny for anon/authenticated; only
-- service-role (which bypasses RLS entirely) can touch this table — same
-- pattern as global_budget/user_subscription above. Both the hosted-model
-- proxy routes (read) and the admin models page/action (read+write) already
-- hold a service-role client.
revoke all on public.hosted_model_plans from public, anon, authenticated;
grant select, insert, update on public.hosted_model_plans to service_role;

-- -----------------------------------------------------------------------------
-- 100%-off promo code redemptions (app/pricing/actions.ts's startProCheckout).
-- Dodo's own discount.times_used only increments on a completed Dodo
-- checkout — a 100%-off code is intentionally never sent to Dodo at all (it
-- grants Pro directly via setUserPlan(), lib/subscriptions.ts, skipping
-- payment entirely), so without this table Dodo's usage_limit would be
-- silently unenforceable for exactly the codes that need it most. One row
-- per (code, user) redemption; the primary key doubles as "has this user
-- already redeemed this code" so re-submitting the same code is a no-op
-- rather than double-counting toward the limit.
create table if not exists public.promo_code_redemptions (
  code text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  primary key (code, user_id)
);

alter table public.promo_code_redemptions enable row level security;
-- no policies -> default deny for anon/authenticated; only service-role
-- (which the promo-redemption path in app/pricing/actions.ts holds) can
-- read or write this table.
revoke all on public.promo_code_redemptions from public, anon, authenticated;
grant select, insert on public.promo_code_redemptions to service_role;
