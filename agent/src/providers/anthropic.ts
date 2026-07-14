/** Anthropic Messages API adapter — fetch + SSE, no SDK dependency. */
import type { ProviderConfig } from "../config.js";
import { sseLines } from "./types.js";
import type { ChatAdapter, ChatMessage, TurnRequest, TurnResult } from "./types.js";

export class AnthropicAdapter implements ChatAdapter {
  constructor(private cfg: ProviderConfig) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const res = await fetch(`${this.cfg.baseUrl}/v1/messages`, {
      method: "POST",
      signal: req.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey!,
        "anthropic-version": "2023-06-01",
        ...this.cfg.headers,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 8192,
        system: req.system,
        messages: req.messages.map(toWire),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
        stream: true,
      }),
    });
    if (!res.ok) {
      throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);
    }

    let text = "";
    const toolCalls: TurnResult["toolCalls"] = [];
    const partialJson: Record<number, { id: string; name: string; json: string }> = {};
    let stopReason: TurnResult["stopReason"] = "other";
    let usage: TurnResult["usage"];

    for await (const data of sseLines(res.body!)) {
      if (data === "[DONE]") break;
      let ev: any;
      try { ev = JSON.parse(data); } catch { continue; }
      switch (ev.type) {
        case "content_block_start":
          if (ev.content_block?.type === "tool_use") {
            partialJson[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, json: "" };
          }
          break;
        case "content_block_delta":
          if (ev.delta?.type === "text_delta") {
            text += ev.delta.text;
            req.onText?.(ev.delta.text);
          } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
            req.onThinking?.(ev.delta.thinking);
          } else if (ev.delta?.type === "input_json_delta" && partialJson[ev.index]) {
            partialJson[ev.index].json += ev.delta.partial_json;
          }
          break;
        case "content_block_stop":
          if (partialJson[ev.index]) {
            const p = partialJson[ev.index];
            toolCalls.push({ id: p.id, name: p.name, input: p.json ? JSON.parse(p.json) : {} });
            delete partialJson[ev.index];
          }
          break;
        case "message_delta":
          if (ev.delta?.stop_reason) {
            stopReason =
              ev.delta.stop_reason === "tool_use" ? "tool_use"
              : ev.delta.stop_reason === "max_tokens" ? "max_tokens"
              : "end_turn";
          }
          if (ev.usage) usage = { outputTokens: ev.usage.output_tokens };
          break;
        case "message_start":
          if (ev.message?.usage) usage = { inputTokens: ev.message.usage.input_tokens };
          break;
        case "error":
          throw new Error(`anthropic stream error: ${JSON.stringify(ev.error).slice(0, 400)}`);
      }
    }
    return { text, toolCalls, stopReason, usage };
  }
}

function toWire(m: ChatMessage) {
  return {
    role: m.role,
    content: m.content.map((b) => {
      if (b.type === "tool_result") {
        return { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error };
      }
      return b;
    }),
  };
}
