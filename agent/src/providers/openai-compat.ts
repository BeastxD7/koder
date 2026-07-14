/**
 * OpenAI-compatible chat/completions adapter — one adapter, many providers:
 * OpenAI, OpenRouter, DeepSeek, Groq, xAI, Mistral, Gemini (compat endpoint),
 * Cerebras, Ollama, LM Studio, any /v1/chat/completions server.
 */
import type { ProviderConfig } from "../config.js";
import { sseLines } from "./types.js";
import type { ChatAdapter, ChatMessage, TurnRequest, TurnResult } from "./types.js";

export class OpenAICompatAdapter implements ChatAdapter {
  constructor(private cfg: ProviderConfig) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey}`,
        ...this.cfg.headers,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 8192,
        messages: [{ role: "system", content: req.system }, ...toWire(req.messages)],
        tools: req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })),
        stream: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`${this.cfg.baseUrl} ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }

    let text = "";
    let finish: string | undefined;
    let usage: TurnResult["usage"];
    const calls: Record<number, { id: string; name: string; args: string }> = {};

    for await (const data of sseLines(res.body!)) {
      if (data === "[DONE]") break;
      let ev: any;
      try { ev = JSON.parse(data); } catch { continue; }
      const choice = ev.choices?.[0];
      if (!choice) {
        if (ev.usage) usage = { inputTokens: ev.usage.prompt_tokens, outputTokens: ev.usage.completion_tokens };
        continue;
      }
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
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
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

/** Translate neutral messages to OpenAI wire format. */
function toWire(messages: ChatMessage[]) {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
      const toolUses = m.content.filter((b) => b.type === "tool_use") as any[];
      const msg: any = { role: "assistant", content: text || null };
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
      for (const r of results) {
        out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
      }
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}
