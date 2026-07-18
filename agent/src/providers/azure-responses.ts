/**
 * Azure OpenAI Responses API adapter — used ONLY by the hosted "lakshx"
 * provider (config.ts's `PRESETS.lakshx`, `kind: "azure-responses"`). This
 * talks to product/lakshx-chat's own proxy
 * (landing-page/app/api/lakshx-model/responses/route.ts), which holds the
 * real Azure credential; this adapter never sees one — `cfg.apiKey` here is
 * the Supabase session bearer token (see `PRESETS.lakshx`'s doc comment in
 * config.ts), sent as `Authorization: Bearer`, exactly like the "openai" kind
 * branch in openai-compat.ts already does for this same proxy today.
 *
 * WHY A SEPARATE ADAPTER: Azure's Chat Completions API (openai-compat.ts)
 * structurally hides gpt-5-mini's reasoning/thinking tokens from the
 * response — confirmed against Microsoft's own docs ("hidden tokens that
 * aren't returned as part of the message response content"). The newer
 * Responses API (`POST {baseUrl}/responses`) DOES stream a live reasoning
 * summary (`response.reasoning_summary_text.delta`), confirmed live. But its
 * wire shape for messages/tools/tool-calls is a different animal from Chat
 * Completions: flatter tool defs (`{type,name,description,parameters}`, not
 * nested under `function`), `input` items instead of `messages`,
 * `function_call`/`function_call_output` items instead of
 * `tool_calls`/`role:"tool"` messages, and `call_id` (not `tool_call_id`) as
 * the correlation key. That's different enough on the one path that matters
 * most here (tool calling, since this is an agentic coding IDE) to warrant
 * its own adapter rather than another branch inside openai-compat.ts.
 *
 * Deliberately scoped to ONLY this hosted path — the BYOK `azure` provider
 * kind stays on Chat Completions via openai-compat.ts unchanged (two Azure
 * code paths is an accepted tradeoff, not a bug — see config.ts's
 * `ProviderConfig.kind` doc comment).
 *
 * The Responses API is REQUEST-SCOPED, not thread-scoped (`store: false`
 * below, no `previous_response_id` chaining) — every turn replays the full
 * conversation as fresh `input` items, translated from the neutral
 * `ChatMessage[]` history on every single call, exactly like the other two
 * adapters already do for their own wire shapes (openai-compat.ts's
 * `toWire`, anthropic.ts's `toWire`).
 */
import type { ProviderConfig } from "../config.js";
import { IMAGE_UNSUPPORTED_PLACEHOLDER, isVisionCapableModel } from "../vision.js";
import { sseLines, toolResultText } from "./types.js";
import type { ChatAdapter, ChatMessage, ToolResultPart, TurnRequest, TurnResult } from "./types.js";

export class AzureResponsesAdapter implements ChatAdapter {
  constructor(private cfg: ProviderConfig) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const res = await fetch(`${this.cfg.baseUrl}/responses`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey}`,
        ...this.cfg.headers,
      },
      body: JSON.stringify({
        model: req.model,
        // Responses API's system-prompt equivalent — a top-level field,
        // never an `input` item (unlike Chat Completions' `role:"system"`
        // message).
        instructions: req.system,
        input: toWire(req.messages, isVisionCapableModel(req.model)),
        // Flat tool shape — NOT nested under a `function` key like Chat
        // Completions (openai-compat.ts's `{type:"function", function:{...}}`).
        tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema })),
        // Responses API's token cap field — verified distinct from Chat
        // Completions' `max_tokens`/`max_completion_tokens`
        // (openai-compat.ts's `maxTokensParamName`).
        max_output_tokens: req.maxTokens ?? 8192,
        // "low": this is the free/hosted, budget-capped path ($800 global
        // ceiling, $20/user cap — landing-page's check_budget/record_usage),
        // and an agentic coding loop pays this cost on EVERY tool-calling
        // round-trip, not once per conversation — favor latency/cost over
        // reasoning depth. Not verified against the (now-deleted) disposable
        // test route that first proved reasoning-summary streaming; revisit
        // if response quality suffers in practice.
        reasoning: { effort: "low", summary: "auto" },
        store: false,
        stream: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`${this.cfg.baseUrl} ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }

    let text = "";
    let finish: TurnResult["stopReason"] = "end_turn";
    let usage: TurnResult["usage"];
    let sawToolCall = false;
    // keyed by the event's own `output_index` — stable within one stream,
    // present on both `response.output_item.added` and
    // `response.function_call_arguments.delta`, mirroring anthropic.ts's use
    // of `content_block` index and openai-compat.ts's `tool_calls[].index`.
    const calls: Record<number, { id: string; name: string; args: string }> = {};

    for await (const data of sseLines(res.body!)) {
      if (data === "[DONE]") break;
      let ev: any;
      try { ev = JSON.parse(data); } catch { continue; }
      switch (ev.type) {
        case "response.output_text.delta":
          if (typeof ev.delta === "string" && ev.delta) {
            text += ev.delta;
            req.onText?.(ev.delta);
          }
          break;
        case "response.reasoning_summary_text.delta":
          if (typeof ev.delta === "string" && ev.delta) req.onThinking?.(ev.delta);
          break;
        case "response.output_item.added":
          // `item.call_id`/`item.name` are both present from this very first
          // event for a function_call item — unlike openai-compat.ts's
          // provider-dependent id timing, no "id may still be empty on an
          // early fragment" case to handle here.
          if (ev.item?.type === "function_call") {
            sawToolCall = true;
            calls[ev.output_index] = { id: ev.item.call_id, name: ev.item.name, args: ev.item.arguments ?? "" };
          }
          break;
        case "response.function_call_arguments.delta": {
          const slot = calls[ev.output_index];
          if (slot && typeof ev.delta === "string" && ev.delta) {
            slot.args += ev.delta;
            req.onToolInputDelta?.({ index: ev.output_index, id: slot.id, name: slot.name, delta: ev.delta });
          }
          break;
        }
        case "response.completed":
          if (ev.response?.usage) {
            const u = ev.response.usage;
            // `output_tokens` already INCLUDES reasoning tokens as a subset
            // — the same convention as Chat Completions'
            // `completion_tokens`/`completion_tokens_details.reasoning_tokens`
            // (confirmed: OpenAI/Azure docs + community reports both state
            // reasoning tokens are billed AS output tokens, not on top of
            // them). Do NOT add `output_tokens_details.reasoning_tokens` on
            // top of `output_tokens` in the budget/cost math downstream —
            // that would double-bill, not fix under-billing.
            usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
          }
          if (ev.response?.incomplete_details?.reason === "max_output_tokens") finish = "max_tokens";
          break;
        case "error":
          throw new Error(`${this.cfg.baseUrl} stream error: ${JSON.stringify(ev.error ?? ev).slice(0, 400)}`);
      }
    }

    const toolCalls = Object.values(calls).map((c) => ({ id: c.id, name: c.name, input: safeJson(c.args) }));
    return {
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 || sawToolCall ? "tool_use" : finish,
      usage,
    };
  }
}

function safeJson(s: string): unknown {
  try { return s ? JSON.parse(s) : {}; } catch { return { _raw: s }; }
}

/**
 * Translate neutral messages to Responses API `input` item shape. Exported
 * for direct unit testing (test/provider-azure-responses-wire.test.ts) —
 * pure, no network. Mirrors openai-compat.ts's `toWire` doc comment for the
 * image-handling rationale: a tool_result's image can't ride inside a
 * `function_call_output` item's plain-text `output` field here (kept
 * text-only for parity with the other adapters' degrade-to-placeholder
 * story), so it rides in a follow-up `role:"user"` input item's
 * `input_image` part instead — one per neutral user turn, vision-capable
 * models only.
 */
export function toWire(messages: ChatMessage[], visionCapable: boolean): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
      const toolUses = m.content.filter((b) => b.type === "tool_use") as any[];
      if (text) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const t of toolUses) {
        out.push({ type: "function_call", call_id: t.id, name: t.name, arguments: JSON.stringify(t.input ?? {}) });
      }
    } else {
      const results = m.content.filter((b) => b.type === "tool_result") as any[];
      // image parts deferred out of function_call_output items — see doc comment above
      const pendingImages: Extract<ToolResultPart, { type: "image" }>[] = [];
      for (const r of results) {
        let text = toolResultText(r.content);
        const images: Extract<ToolResultPart, { type: "image" }>[] =
          typeof r.content === "string" ? [] : r.content.filter((p: ToolResultPart) => p.type === "image" && p.base64);
        if (images.length) {
          if (visionCapable) {
            pendingImages.push(...images);
            text += "\n[the screenshot from this tool call is attached in the next input item]";
          } else {
            text += `\n${IMAGE_UNSUPPORTED_PLACEHOLDER}`;
          }
        }
        // Responses wire has no is_error flag on function_call_output —
        // surface failure in the output text, same as openai-compat.ts.
        const output = r.is_error ? `[tool failed] ${text}` : text;
        out.push({ type: "function_call_output", call_id: r.tool_use_id, output });
      }
      if (pendingImages.length) {
        out.push({
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "[screenshot(s) captured by the tool call(s) above]" },
            ...pendingImages.map((p) => ({ type: "input_image", image_url: `data:${p.mimeType};base64,${p.base64}` })),
          ],
        });
      }
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
      if (text) out.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    }
  }
  return out;
}
