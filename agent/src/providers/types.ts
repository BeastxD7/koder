/** Provider-neutral chat types. Anthropic-flavored: richest superset. */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema
}

export interface StreamEvent {
  type: "text";
  text: string;
}

export interface TurnResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface TurnRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** streamed text deltas for live UI */
  onText?: (text: string) => void;
  /** streamed reasoning/thinking deltas, when the model emits them */
  onThinking?: (text: string) => void;
}

export interface ChatAdapter {
  runTurn(req: TurnRequest): Promise<TurnResult>;
}

/** Minimal SSE line parser shared by both adapters. */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}
