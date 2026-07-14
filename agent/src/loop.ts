/**
 * The Koder agent loop: gather context → act → verify.
 * Deliberately thin (the mini-SWE-agent lesson): the intelligence is the
 * model + tools + verification, not harness complexity. Behavior, strategy,
 * and system prompt are 100% ours.
 */
import { loadConfig, resolveModel } from "./config.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { OpenAICompatAdapter } from "./providers/openai-compat.js";
import type { ChatAdapter, ChatMessage, ContentBlock } from "./providers/types.js";
import { TOOLS, toolByName, type ToolSpec } from "./tools.js";

export type AgentMode = "review" | "approve" | "auto";

export interface LoopCallbacks {
  onText(text: string): void;
  onThinking(text: string): void;
  onToolStart(call: { id: string; name: string; input: any; kind: ToolSpec["kind"]; title: string }): void;
  onToolEnd(call: { id: string; output: string; isError: boolean }): void;
  /** Ask the client whether a dangerous tool may run. */
  onPermission(call: { id: string; name: string; input: any; title: string; kind: ToolSpec["kind"] }): Promise<boolean>;
}

export interface AgentSession {
  cwd: string;
  model?: string;
  mode: AgentMode;
  history: ChatMessage[];
}

const MAX_ITERATIONS = 60;

const BASE_PROMPT = (cwd: string) => `You are Koder, the agent inside the Koder IDE — an agentic development environment whose whole purpose is SHIPPED SOFTWARE QUALITY.

Workspace: ${cwd}

Operating principles:
1. Gather context before acting: read the relevant files, grep for usages, understand conventions. Never guess file contents.
2. Act with the smallest correct change. Match the codebase's existing style, naming, and idioms.
3. VERIFY before declaring done — this is non-negotiable. If the project has a typecheck/lint/test/build command (check package.json scripts, Makefile, etc.), run the fastest relevant one after your edits and fix what breaks. Never claim something works without having checked.
4. Report honestly: if a check fails or you skipped verification, say so plainly.
5. Prefer edit_file for surgical changes; write_file only for new files or full rewrites.
6. Keep responses tight: lead with what you did/found; no filler. Never use emoji.`;

function systemPrompt(cwd: string, mode: AgentMode): string {
  const base = BASE_PROMPT(cwd);
  if (mode === "review") {
    return `${base}

CURRENT MODE: REVIEW-FIRST (read-only). You may ONLY read, list, and search — write_file, edit_file, and bash are disabled. Your job this turn:
1. Research the codebase thoroughly for the user's request.
2. End your reply with a complete implementation plan in markdown under the heading "# Plan" — files to touch, ordered steps, risks, and how to verify.
Do not attempt any modification; the plan will be saved automatically and the session moves to Approve mode next.

You have: read_file, list_dir, grep.`;
  }
  return `${base}

You have: read_file, write_file, edit_file, list_dir, grep, bash. bash runs zsh in the workspace.${
    mode === "auto" ? "\nCURRENT MODE: AUTO — your actions are pre-approved; still follow the verify principle rigorously." : ""
  }`;
}

function makeAdapter(providerKind: "anthropic" | "openai", providerCfg: any): ChatAdapter {
  return providerKind === "anthropic" ? new AnthropicAdapter(providerCfg) : new OpenAICompatAdapter(providerCfg);
}

function toolTitle(name: string, input: any): string {
  switch (name) {
    case "read_file": return `Read ${input.path}`;
    case "write_file": return `Write ${input.path}`;
    case "edit_file": return `Edit ${input.path}`;
    case "list_dir": return `List ${input.path ?? "."}`;
    case "grep": return `Search "${input.pattern}"`;
    case "bash": return `$ ${String(input.command ?? "").slice(0, 80)}`;
    default: return name;
  }
}

export async function runPrompt(
  session: AgentSession,
  userText: string,
  cb: LoopCallbacks,
  signal?: AbortSignal,
): Promise<"end_turn" | "max_turn_requests" | "cancelled"> {
  const cfg = loadConfig();
  const { provider, model } = resolveModel(cfg, session.model);
  const adapter = makeAdapter(provider.kind, provider);

  const allowedTools =
    session.mode === "review" ? TOOLS.filter((t) => !t.dangerous) : TOOLS;

  session.history.push({ role: "user", content: [{ type: "text", text: userText }] });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal?.aborted) return "cancelled";

    const result = await adapter.runTurn({
      model,
      system: systemPrompt(session.cwd, session.mode),
      messages: session.history,
      tools: allowedTools.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
      signal,
      onText: cb.onText,
      onThinking: cb.onThinking,
    });

    const assistantBlocks: ContentBlock[] = [];
    if (result.text) assistantBlocks.push({ type: "text", text: result.text });
    for (const tc of result.toolCalls) {
      assistantBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    session.history.push({ role: "assistant", content: assistantBlocks.length ? assistantBlocks : [{ type: "text", text: "" }] });

    if (result.stopReason !== "tool_use" || result.toolCalls.length === 0) {
      return "end_turn";
    }

    const results: ContentBlock[] = [];
    for (const tc of result.toolCalls) {
      if (signal?.aborted) return "cancelled";
      const spec = toolByName.get(tc.name);
      const title = toolTitle(tc.name, tc.input ?? {});
      if (!spec) {
        results.push({ type: "tool_result", tool_use_id: tc.id, content: `Unknown tool ${tc.name}`, is_error: true });
        continue;
      }
      cb.onToolStart({ id: tc.id, name: tc.name, input: tc.input, kind: spec.kind, title });

      let allowed = true;
      if (spec.dangerous && session.mode === "review") {
        allowed = false; // hard gate: review mode never modifies anything
      } else if (spec.dangerous && session.mode !== "auto") {
        allowed = await cb.onPermission({ id: tc.id, name: tc.name, input: tc.input, title, kind: spec.kind });
      }
      if (!allowed) {
        const msg = "User declined this action. Adjust your approach or ask what they'd prefer.";
        cb.onToolEnd({ id: tc.id, output: msg, isError: true });
        results.push({ type: "tool_result", tool_use_id: tc.id, content: msg, is_error: true });
        continue;
      }

      try {
        const output = await spec.run(tc.input ?? {}, session.cwd, signal);
        cb.onToolEnd({ id: tc.id, output, isError: false });
        results.push({ type: "tool_result", tool_use_id: tc.id, content: output });
      } catch (err: any) {
        const msg = `ERROR: ${err?.message ?? err}`;
        cb.onToolEnd({ id: tc.id, output: msg, isError: true });
        results.push({ type: "tool_result", tool_use_id: tc.id, content: msg, is_error: true });
      }
    }
    session.history.push({ role: "user", content: results });
  }
  return "max_turn_requests";
}
