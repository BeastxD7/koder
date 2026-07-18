import { NextRequest } from "next/server";
import { after } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cleanAzureError } from "../../../../lib/upstream-error";

export const runtime = "nodejs";
// Agentic turns can run long (multi-tool-call loops) — this is the ceiling
// this stage needs.
export const maxDuration = 300;

// Azure OpenAI, gpt-5-mini, Global Standard, USD per 1M tokens. Update this
// if the deployment's model/SKU ever changes — cost accounting is only as
// correct as this constant. Kept identical to (and duplicated from) the
// sibling chat/completions/route.ts — same model, same deployment, same
// price, just a different Azure API surface.
const PRICE_PER_1M = { input: 0.125, output: 1.0 };

function supabaseAdmin(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * The hosted, no-BYOK "LakshX" model — Responses API surface. Sibling to
 * ../chat/completions/route.ts (kept in place, untouched, so already-installed
 * IDE builds that still speak Chat Completions keep working): the client
 * sends a Supabase login token (not an Azure key — that's the separate
 * `azure` BYOK provider kind in agent/src/config.ts, which stays on Chat
 * Completions), this proxy holds the real Azure credential and enforces the
 * per-user/global budget from supabase/schema.sql before ever calling Azure.
 *
 * Why a second route instead of translating in here: agent/src/providers/
 * azure-responses.ts already speaks this wire shape natively (the neutral →
 * Responses translation happens exactly once, client-side) — this route is a
 * plain auth+budget+forward+meter shim, structurally identical to
 * ../chat/completions/route.ts, just pointed at `/responses` and reading the
 * differently-shaped usage payload.
 *
 * Required env vars (same four as the sibling route):
 *   AZURE_OPENAI_ENDPOINT     e.g. https://lakshx-ide-global-resource.openai.azure.com/openai/v1
 *   AZURE_OPENAI_API_KEY      Foundry/Azure OpenAI resource key
 *   AZURE_OPENAI_DEPLOYMENT   the Foundry deployment name, e.g. "gpt-5-mini"
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 */
export async function POST(req: NextRequest) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  if (!endpoint || !apiKey || !deployment) {
    return Response.json({ error: "proxy misconfigured — missing AZURE_OPENAI_* env vars" }, { status: 500 });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ error: "proxy misconfigured — missing SUPABASE_* env vars" }, { status: 500 });
  }

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "missing bearer token" }, { status: 401 });

  const supabase = supabaseAdmin();
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    return Response.json({ error: "invalid or expired session" }, { status: 401 });
  }
  const userId = userData.user.id;

  // Pre-request gate — reads the running totals straight from the source
  // tables (see check_budget() in supabase/schema.sql), not a cache.
  const { data: budgetRows, error: budgetErr } = await supabase.rpc("check_budget", { p_user_id: userId });
  const decision = budgetRows?.[0] as { allowed: boolean; reason: string | null } | undefined;
  if (budgetErr || !decision?.allowed) {
    const reason = decision?.reason ?? "budget check failed";
    // Fire-and-forget, via `after()` (same reasoning as recordUsageWhenDone
    // below): never let logging the 429 delay or fail the 429 response
    // itself, but don't let the platform kill the write once the response
    // has already gone out either.
    after(async () => {
      const { error } = await supabase.rpc("record_budget_cap_hit", { p_user_id: userId, p_reason: reason });
      if (error) console.error("lakshx-model (responses): record_budget_cap_hit failed", error);
    });
    return Response.json({ error: reason }, { status: 429 });
  }

  const body = await req.json();
  // client sends "model" per the Responses wire shape (see
  // agent/src/providers/azure-responses.ts); Azure's model field must be the
  // deployment name, not whatever the client asked for.
  body.model = deployment;
  // Stateless replay only — the client already sends the full conversation
  // as `input` on every turn (azure-responses.ts's `toWire`); never let a
  // client request server-side state retention or `previous_response_id`
  // chaining through this proxy.
  body.store = false;
  delete body.previous_response_id;

  // Deliberately NOT passing `signal: req.signal` here — see the identical
  // comment in the sibling chat/completions/route.ts for the full reasoning.
  // Short version: this signal fires the same way for an intentional Stop
  // and an accidental disconnect, and wiring it through used to silently
  // drop usage recording on either — Azure had already billed for those
  // tokens regardless. Letting the call run to natural completion costs
  // nothing extra and guarantees an authoritative final usage figure;
  // `maxDuration` above remains the hard ceiling.
  const azureRes = await fetch(`${endpoint}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify(body),
  });

  if (!azureRes.ok || !azureRes.body) {
    const text = await azureRes.text().catch(() => "");
    // Full raw body stays server-side only (see cleanAzureError()'s doc
    // comment for why the client-facing error is sanitized here rather than
    // relying solely on the client's own HTML-body sniffing).
    console.error(`lakshx-model (responses): azure ${azureRes.status}`, text.slice(0, 2000));
    return Response.json({ error: cleanAzureError(azureRes.status, text) }, { status: azureRes.status || 502 });
  }

  // Tee: the client gets the raw bytes untouched (azure-responses.ts parses
  // this exact SSE shape); the second reader scans the same stream for the
  // `response.completed` event's usage so cost can be recorded once it's
  // actually known.
  const [clientStream, meterStream] = azureRes.body.tee();

  // `after()` keeps the function alive for this work even though the
  // response has already been returned — a bare unawaited promise here can
  // get killed by the platform once the response is sent.
  after(() => recordUsageWhenDone(meterStream, supabase, userId));

  return new Response(clientStream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function recordUsageWhenDone(stream: ReadableStream<Uint8Array>, supabase: SupabaseClient, userId: string) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let usage: { input_tokens: number; output_tokens: number } | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const ev = JSON.parse(data);
          // The Responses API's usage payload lives at `response.completed`'s
          // nested `response.usage` — NOT a top-level `ev.usage` like Chat
          // Completions' final SSE chunk (the sibling route's shape).
          if (ev.type === "response.completed" && ev.response?.usage) usage = ev.response.usage;
        } catch {
          // partial/non-JSON chunk — ignore, more data may complete it later
        }
      }
    }
  } catch (err) {
    console.error("lakshx-model (responses): metering stream read failed", err);
    return;
  }

  if (!usage) {
    console.error("lakshx-model (responses): no response.completed usage in stream — nothing recorded");
    return;
  }

  // `output_tokens` already INCLUDES reasoning tokens as a subset (same
  // convention as Chat Completions' `completion_tokens` /
  // `completion_tokens_details.reasoning_tokens` — confirmed against
  // OpenAI/Azure docs and community reports: reasoning tokens are billed AS
  // output tokens, not on top of them). Deliberately do NOT add
  // `usage.output_tokens_details.reasoning_tokens` here — that would
  // double-bill every request, not fix under-billing.
  const costUsd =
    (usage.input_tokens / 1_000_000) * PRICE_PER_1M.input + (usage.output_tokens / 1_000_000) * PRICE_PER_1M.output;

  const { error } = await supabase.rpc("record_usage", {
    p_user_id: userId,
    p_tokens_in: usage.input_tokens,
    p_tokens_out: usage.output_tokens,
    p_cost_usd: costUsd,
  });
  if (error) console.error("lakshx-model (responses): record_usage failed", error);
}
