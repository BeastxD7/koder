import { NextRequest } from "next/server";
import { after } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
// Agentic turns can run long (multi-tool-call loops) — this is the ceiling
// this stage needs.
export const maxDuration = 300;

// Azure OpenAI, gpt-5-mini, Global Standard, USD per 1M tokens. Update this
// if the deployment's model/SKU ever changes — cost accounting is only as
// correct as this constant.
const PRICE_PER_1M = { input: 0.125, output: 1.0 };

function supabaseAdmin(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * The hosted, no-BYOK "LakshX" model: the client sends a Supabase login
 * token (not an Azure key — that's the separate `azure` BYOK provider kind
 * in agent/src/config.ts), this proxy holds the real Azure credential and
 * enforces the per-user/global budget from supabase/schema.sql before ever
 * calling Azure. Required env vars:
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
    return Response.json({ error: decision?.reason ?? "budget check failed" }, { status: 429 });
  }

  const body = await req.json();
  // client sends "model" per the OpenAI-compat wire shape (see
  // agent/src/providers/openai-compat.ts); Azure's model field must be the
  // deployment name, not whatever the client asked for.
  body.model = deployment;
  // usage-bearing final SSE chunk is required to know what to bill — force
  // it on regardless of what the client sent.
  body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };

  const azureRes = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    signal: req.signal,
    headers: { "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify(body),
  });

  if (!azureRes.ok || !azureRes.body) {
    const text = await azureRes.text().catch(() => "");
    return Response.json({ error: `azure ${azureRes.status}: ${text.slice(0, 500)}` }, { status: azureRes.status || 502 });
  }

  // Tee: the client gets the raw bytes untouched (same SSE shape every
  // other OpenAI-compatible provider already produces, so no client-side
  // parsing changes needed); the second reader scans the same stream for
  // the final usage chunk so cost can be recorded once it's actually known.
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
  let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

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
          if (ev.usage) usage = ev.usage;
        } catch {
          // partial/non-JSON chunk — ignore, more data may complete it later
        }
      }
    }
  } catch (err) {
    console.error("lakshx-model: metering stream read failed", err);
    return;
  }

  if (!usage) {
    console.error("lakshx-model: no usage chunk in stream — nothing recorded");
    return;
  }

  const costUsd =
    (usage.prompt_tokens / 1_000_000) * PRICE_PER_1M.input + (usage.completion_tokens / 1_000_000) * PRICE_PER_1M.output;

  const { error } = await supabase.rpc("record_usage", {
    p_user_id: userId,
    p_tokens_in: usage.prompt_tokens,
    p_tokens_out: usage.completion_tokens,
    p_cost_usd: costUsd,
  });
  if (error) console.error("lakshx-model: record_usage failed", error);
}
