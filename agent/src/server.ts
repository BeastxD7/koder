#!/usr/bin/env node
/**
 * Koder Agent Runtime — ACP agent server over stdio.
 * Any ACP client (the Koder panel, Zed, JetBrains, neovim) can drive it.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { availableProviders, loadConfig } from "./config.js";
import { runPrompt, toolTitle, type AgentMode, type AgentSession } from "./loop.js";
import { probeProvider } from "./providers/validate.js";
import { loadSessionFile, pruneSessions, saveSessionSoon } from "./store.js";

interface Session extends AgentSession {
  pending?: AbortController;
}

const sessions = new Map<string, Session>();

// housekeeping: bound ~/.koder/sessions/ so it never grows unbounded
pruneSessions();

const MODES = [
  { id: "review", name: "Review", description: "Read-only: research the codebase and produce an implementation plan" },
  { id: "approve", name: "Approve", description: "Edits and commands ask for your approval" },
  { id: "auto", name: "Auto", description: "The agent acts without asking" },
];

/** Save the review-mode output as a plan file; returns its path. */
function savePlan(cwd: string, text: string): string {
  const dir = join(cwd, ".koder", "plans");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const file = join(dir, `plan-${stamp}.md`);
  writeFileSync(file, text.trim() + "\n");
  return file;
}

acp
  .agent({ name: "koder-agent" })
  .onRequest("initialize", async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
  }))
  .onRequest("authenticate", async () => ({}))
  .onRequest("session/new", async (ctx) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, { cwd: ctx.params.cwd, history: [], mode: "review" });
    return {
      sessionId,
      modes: { currentModeId: "review", availableModes: MODES },
    };
  })
  .onRequest("session/load", async (ctx) => {
    const { sessionId, cwd } = ctx.params as { sessionId: string; cwd?: string };
    const saved = loadSessionFile(sessionId);
    if (!saved) throw new Error(`no saved session ${sessionId}`); // client falls back to session/new

    sessions.set(sessionId, {
      cwd: cwd ?? saved.cwd,
      mode: saved.mode,
      model: saved.model,
      history: saved.history,
    });

    // ACP contract: replay the conversation via session/update before returning.
    // Our own extension already renders its own local transcript and ignores
    // these; other ACP clients (Zed, JetBrains) rely on this to rebuild their UI.
    const notify = (update: any) => ctx.client.notify(acp.methods.client.session.update, { sessionId, update });
    for (const msg of saved.history) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          void notify({
            sessionUpdate: msg.role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
            content: { type: "text", text: block.text },
          });
        } else if (block.type === "tool_use") {
          void notify({
            sessionUpdate: "tool_call",
            toolCallId: block.id,
            title: toolTitle(block.name, block.input ?? {}),
            kind: "execute",
            status: "completed",
            rawInput: block.input,
          });
        } else if (block.type === "tool_result") {
          void notify({
            sessionUpdate: "tool_call_update",
            toolCallId: block.tool_use_id,
            status: block.is_error ? "failed" : "completed",
            content: [{ type: "content", content: { type: "text", text: block.content.slice(0, 4000) } }],
          });
        }
      }
    }

    return { modes: { currentModeId: saved.mode, availableModes: MODES } };
  })
  .onRequest("session/set_mode", async (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (s && MODES.some((m) => m.id === ctx.params.modeId)) s.mode = ctx.params.modeId as AgentMode;
    return {};
  })
  // Koder extension: list configured providers + current default model
  .onRequest("koder/models", (v: unknown) => v as Record<string, never>, async () => {
    const cfg = loadConfig();
    return { defaultModel: cfg.defaultModel, providers: availableProviders(cfg) };
  })
  // Koder extension: validate a provider key and list its live models
  .onRequest(
    "koder/validate",
    (v: unknown) => v as { provider: string; apiKey?: string },
    async (ctx) => probeProvider(ctx.params.provider, ctx.params.apiKey),
  )
  // Koder extension: set the model for a session ("provider/model")
  .onRequest(
    "koder/set_model",
    (v: unknown) => v as { sessionId: string; model: string },
    async (ctx) => {
      const s = sessions.get(ctx.params.sessionId);
      if (s) s.model = ctx.params.model;
      return {};
    },
  )
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId, prompt } = ctx.params;
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);

    session.pending?.abort();
    const abort = new AbortController();
    session.pending = abort;

    const text = prompt
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    const notify = (update: any) =>
      ctx.client.notify(acp.methods.client.session.update, { sessionId, update });

    const persist = () =>
      saveSessionSoon({ id: sessionId, cwd: session.cwd, mode: session.mode, model: session.model, history: session.history });

    let finalText = "";
    try {
      const stop = await runPrompt(
        session,
        text,
        {
          onText: (t) => {
            finalText += t;
            void notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
          },
          onThinking: (t) =>
            void notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: t } }),
          onUsage: (usage) => void ctx.client.notify("koder/usage", { sessionId, ...usage }),
          onHistoryChanged: persist,
          onToolStart: (c) =>
            void notify({
              sessionUpdate: "tool_call",
              toolCallId: c.id,
              title: c.title,
              kind: c.kind,
              status: "in_progress",
              rawInput: c.input,
            }),
          onToolEnd: (c) =>
            void notify({
              sessionUpdate: "tool_call_update",
              toolCallId: c.id,
              status: c.isError ? "failed" : "completed",
              content: [{ type: "content", content: { type: "text", text: c.output.slice(0, 4000) } }],
            }),
          onPermission: async (c) => {
            const res = await ctx.client.request(acp.methods.client.session.requestPermission, {
              sessionId,
              toolCall: { toolCallId: c.id, title: c.title, kind: c.kind, status: "pending", rawInput: c.input },
              options: [
                { kind: "allow_once", name: "Allow", optionId: "allow" },
                { kind: "reject_once", name: "Deny", optionId: "deny" },
              ],
            });
            return res.outcome.outcome === "selected" && res.outcome.optionId === "allow";
          },
        },
        abort.signal,
      );

      // Review-first flow: a turn that produced a "# Plan" saves it and asks
      // the USER to decide — mode only advances on explicit approval
      // (clarifying-question turns produce no plan and change nothing).
      if (
        session.mode === "review" &&
        !abort.signal.aborted &&
        /^#{1,3}\s*Plan\b/m.test(finalText)
      ) {
        const planPath = savePlan(session.cwd, finalText);
        await ctx.client.notify("koder/plan_ready", { sessionId, path: planPath });
      }

      return { stopReason: abort.signal.aborted ? "cancelled" : stop };
    } catch (err: any) {
      if (abort.signal.aborted) return { stopReason: "cancelled" };
      await notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `\n\nError: ${err?.message ?? err}` },
      });
      return { stopReason: "refusal" };
    } finally {
      if (session.pending === abort) session.pending = undefined;
    }
  })
  .onNotification("session/cancel", async (ctx) => {
    sessions.get(ctx.params.sessionId)?.pending?.abort();
  })
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );

process.stderr.write("koder-agent ready (ACP over stdio)\n");
