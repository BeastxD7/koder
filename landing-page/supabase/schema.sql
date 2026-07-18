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

create table if not exists public.user_budget (
  user_id uuid primary key references auth.users(id) on delete cascade,
  credit_limit_usd numeric(10,2) not null default 20.00
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
-- Auto-provisions a user_budget row (default $20) on first use.
create or replace function public.check_budget(p_user_id uuid, p_default_limit numeric default 20.00)
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
  select credit_limit_usd into user_limit from user_budget where user_id = p_user_id;
  if user_limit is null then
    insert into user_budget (user_id, credit_limit_usd) values (p_user_id, p_default_limit)
      on conflict (user_id) do nothing;
    user_limit := p_default_limit;
  end if;

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
create or replace function public.record_usage(p_user_id uuid, p_tokens_in bigint, p_tokens_out bigint, p_cost_usd numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into usage_ledger (user_id, tokens_in, tokens_out, cost_usd)
    values (p_user_id, p_tokens_in, p_tokens_out, p_cost_usd);
  update global_budget set spent_usd = spent_usd + p_cost_usd where id = true;
end;
$$;

-- Lock these down to the service role only — never callable with the
-- anon/authenticated key, or any signed-in user could forge their own cost.
revoke all on function public.check_budget(uuid, numeric) from public, anon, authenticated;
revoke all on function public.record_usage(uuid, bigint, bigint, numeric) from public, anon, authenticated;
grant execute on function public.check_budget(uuid, numeric) to service_role;
grant execute on function public.record_usage(uuid, bigint, bigint, numeric) to service_role;

-- Admin dashboard convenience view — per-user total spend + their cap.
-- Also service-role only (no grants to anon/authenticated); the /admin
-- route reads this with the service-role key from a server-side handler.
create or replace view public.admin_user_usage as
select
  u.id as user_id,
  u.email,
  coalesce(sum(l.cost_usd), 0) as total_cost_usd,
  coalesce(sum(l.tokens_in), 0) as total_tokens_in,
  coalesce(sum(l.tokens_out), 0) as total_tokens_out,
  b.credit_limit_usd,
  max(l.created_at) as last_used_at
from auth.users u
left join usage_ledger l on l.user_id = u.id
left join user_budget b on b.user_id = u.id
group by u.id, u.email, b.credit_limit_usd;

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
-- 3. OAuth login event logging — success/failure of the PKCE code exchange in
-- app/auth/callback/route.ts. user_id is nullable: a FAILED exchange means we
-- don't yet know who the user is (the failure happens before the session —
-- and therefore the user identity — exists), so failures are logged with a
-- null user_id rather than dropped, giving the admin dashboard visibility
-- into failure volume even though it can't attribute a failure to a person.
-- -----------------------------------------------------------------------------
create table if not exists public.auth_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists auth_events_user_id_idx on public.auth_events(user_id);
create index if not exists auth_events_created_at_idx on public.auth_events(created_at);

alter table public.auth_events enable row level security;
-- no policies at all -> default deny for anon/authenticated; only
-- service-role can touch this table. Writes happen exclusively via
-- record_auth_event() below, called from the auth callback route with the
-- service-role key (the SSR client used earlier in that route to exchange
-- the code is authenticated AS the signed-in user post-exchange, and cannot
-- call a service-role-only function).

create or replace function public.record_auth_event(p_user_id uuid, p_success boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into auth_events (user_id, success) values (p_user_id, p_success);
end;
$$;

revoke all on function public.record_auth_event(uuid, boolean) from public, anon, authenticated;
grant execute on function public.record_auth_event(uuid, boolean) to service_role;

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
    coalesce((select b.credit_limit_usd from user_budget b where b.user_id = auth.uid()), 20.00)::numeric,
    coalesce((select sum(l.tokens_in) from usage_ledger l where l.user_id = auth.uid()), 0)::bigint,
    coalesce((select sum(l.tokens_out) from usage_ledger l where l.user_id = auth.uid()), 0)::bigint;
end;
$$;

revoke all on function public.get_my_usage() from public, anon;
grant execute on function public.get_my_usage() to authenticated;
