/**
 * OpenAI-compatible chat/completions adapter — one adapter, many providers:
 * OpenAI, OpenRouter, DeepSeek, Groq, xAI, Mistral, Gemini (compat endpoint),
 * Cerebras, Ollama, LM Studio, any /v1/chat/completions server.
 */
import type { ProviderConfig } from "../config.js";
import { IMAGE_UNSUPPORTED_PLACEHOLDER, isVisionCapableModel } from "../vision.js";
import { fetchWithRetry, httpErrorMessage, sseLines, toolResultText } from "./types.js";
import type { ChatAdapter, ChatMessage, ToolResultPart, TurnRequest, TurnResult } from "./types.js";

// OpenAI's reasoning-model family (o1/o3/o4/gpt-5*) rejects `max_tokens`
// outright ("Unsupported parameter... Use 'max_completion_tokens' instead")
// — confirmed live against Azure's gpt-5-mini. Scoped narrowly to these
// families rather than switching everyone to max_completion_tokens, since
// some third-party OpenAI-compatible servers on this same adapter (Ollama,
// LM Studio, etc.) may not recognize the newer key.
function maxTokensParamName(model: string): "max_tokens" | "max_completion_tokens" {
  const bare = model.replace(/^.*\//, ""); // strip any "provider/" prefix
  return /^(o[1-9]|gpt-5)/i.test(bare) ? "max_completion_tokens" : "max_tokens";
}

export class OpenAICompatAdapter implements ChatAdapter {
  constructor(private cfg: ProviderConfig) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    // Azure OpenAI/AI Foundry uses `api-key: <key>` instead of `Authorization:
    // Bearer <key>` — everything else about the wire shape (chat/completions,
    // SSE deltas, tool_calls) is identical to the rest of this adapter.
    const authHeader: Record<string, string> =
      this.cfg.kind === "azure" ? { "api-key": this.cfg.apiKey ?? "" } : { authorization: `Bearer ${this.cfg.apiKey}` };
    const res = await fetchWithRetry(
      () =>
        fetch(`${this.cfg.baseUrl}/chat/completions`, {
          method: "POST",
          signal: req.signal,
          headers: {
            "content-type": "application/json",
            ...authHeader,
            ...this.cfg.headers,
          },
          body: JSON.stringify({
            model: req.model,
            [maxTokensParamName(req.model)]: req.maxTokens ?? 8192,
            messages: [{ role: "system", content: req.system }, ...toWire(req.messages, isVisionCapableModel(req.model))],
            // Omit entirely when empty, not `tools: []` — confirmed live
            // against Azure's grok-4-1-fast-reasoning deployment: an empty
            // array 400s outright ("request failed"), whereas omitting the
            // field is accepted by every provider on this adapter (a
            // zero-tools turn is rare but real, e.g. a review-mode turn
            // with no tools currently offered).
            ...(req.tools.length > 0
              ? {
                  tools: req.tools.map((t) => ({
                    type: "function",
                    function: { name: t.name, description: t.description, parameters: t.input_schema },
                  })),
                }
              : {}),
            stream: true,
            // without this the usage-bearing final chunk is never sent, and we
            // silently fall back to character-based token estimates
            stream_options: { include_usage: true },
          }),
        }),
      { signal: req.signal },
    );
    if (!res.ok) {
      throw new Error(httpErrorMessage(this.cfg.baseUrl, res.status, await res.text()));
    }

    let text = "";
    let finish: string | undefined;
    let usage: TurnResult["usage"];
    const calls: Record<number, { id: string; name: string; args: string }> = {};

    for await (const data of sseLines(res.body!)) {
      if (data === "[DONE]") break;
      let ev: any;
      try { ev = JSON.parse(data); } catch { continue; }
      // some OpenAI-compatible providers (e.g. OpenRouter) emit a
      // mid-stream `{"error": {...}}` chunk instead of an HTTP error status
      // — without this check it silently falls through the `!choice`
      // branch below and the turn ends as an empty, no-explanation
      // end_turn (spinner clears, no answer, no error surfaced)
      if (ev.error) throw new Error(`${this.cfg.baseUrl} stream error: ${JSON.stringify(ev.error).slice(0, 400)}`);
      // Checked unconditionally, not only when `choices` is empty — most
      // providers send usage on its own no-choice trailer chunk, but
      // Codestral (confirmed live) attaches it to the LAST content-bearing
      // chunk instead, alongside a real `choice`/`finish_reason`.
      if (ev.usage) usage = { inputTokens: ev.usage.prompt_tokens, outputTokens: ev.usage.completion_tokens };
      const choice = ev.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        req.onText?.(delta.content);
      }
      // DeepSeek-style reasoning_content / OpenRouter-style reasoning deltas
      const thinking = delta.reasoning_content ?? delta.reasoning;
      if (typeof thinking === "string" && thinking) req.onThinking?.(thinking);
      for (const tc of delta.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= { id: "", name: "", args: "" });
        if (tc.id) slot.id = tc.id;
        // assign once: some providers resend the full name on every delta
        if (tc.function?.name && !slot.name) slot.name = tc.function.name;
        if (tc.function?.arguments) {
          slot.args += tc.function.arguments;
          // `slot.id` may still be "" here if this provider defers sending the
          // call id past the first chunk — matches the fallback `toolCalls`
          // gets below (`c.id || \`call_${i}\``) so a consumer correlating by
          // id doesn't end up with two different keys for the same call.
          req.onToolInputDelta?.({
            index: tc.index,
            id: slot.id || `call_${tc.index}`,
            name: slot.name,
            delta: tc.function.arguments,
          });
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const toolCalls = Object.values(calls).map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.name,
      input: safeJson(c.args),
    }));

    return {
      text,
      toolCalls,
      stopReason:
        toolCalls.length > 0 || finish === "tool_calls" ? "tool_use"
        : finish === "length" ? "max_tokens"
        : "end_turn",
      usage,
    };
  }
}

function safeJson(s: string): unknown {
  try { return s ? JSON.parse(s) : {}; } catch { return { _raw: s }; }
}

/**
 * Translate neutral messages to OpenAI wire format. Exported for direct unit
 * testing (test/provider-image-wire.test.ts) — pure, no network.
 *
 * Image handling: the OpenAI `role: "tool"` message officially takes STRING
 * content only — image parts can't ride inside it. So a tool_result carrying
 * image parts (loop.ts's rich form) emits its text as the tool message
 * (annotated so the model knows a screenshot follows), and the image itself
 * as a data:-URI `image_url` part in ONE follow-up `role: "user"` message
 * per neutral user turn — the shape vision-capable chat/completions models
 * accept. When `visionCapable` is false the tool message instead carries the
 * shared honest placeholder text and no user image message is emitted at all
 * (sending image_url to a non-vision model/endpoint is a hard 4xx).
 */
export function toWire(messages: ChatMessage[], visionCapable: boolean) {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
      const toolUses = m.content.filter((b) => b.type === "tool_use") as any[];
      // strict providers reject content:null without tool_calls — use "" then
      const msg: any = { role: "assistant", content: text || (toolUses.length ? null : "") };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        }));
      }
      out.push(msg);
    } else {
      const results = m.content.filter((b) => b.type === "tool_result") as any[];
      // image parts deferred out of tool messages — see doc comment above
      const pendingImages: Extract<ToolResultPart, { type: "image" }>[] = [];
      for (const r of results) {
        let text = toolResultText(r.content);
        const images: Extract<ToolResultPart, { type: "image" }>[] =
          typeof r.content === "string" ? [] : r.content.filter((p: ToolResultPart) => p.type === "image" && p.base64);
        if (images.length) {
          if (visionCapable) {
            pendingImages.push(...images);
            text += "\n[the screenshot from this tool call is attached in the next user message]";
          } else {
            text += `\n${IMAGE_UNSUPPORTED_PLACEHOLDER}`;
          }
        }
        // OpenAI wire has no is_error flag — surface failure in the content
        const content = r.is_error ? `[tool failed] ${text}` : text;
        out.push({ role: "tool", tool_call_id: r.tool_use_id, content });
      }
      if (pendingImages.length) {
        out.push({
          role: "user",
          content: [
            { type: "text", text: "[screenshot(s) captured by the tool call(s) above]" },
            ...pendingImages.map((p) => ({
              type: "image_url",
              image_url: { url: `data:${p.mimeType};base64,${p.base64}` },
            })),
          ],
        });
      }
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}
