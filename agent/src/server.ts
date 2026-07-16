#!/usr/bin/env node
/**
 * LakshX Agent Runtime — ACP agent server over stdio.
 * Any ACP client (the LakshX panel, Zed, JetBrains, neovim) can drive it.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { maybeCompact, readFileAtCommit, undoFile, undoPaths } from "./checkpoint.js";
import { availableProviders, loadConfig } from "./config.js";
import { runPrompt, toolTitle, type AgentMode, type AgentSession } from "./loop.js";
import { toolResultText } from "./providers/types.js";
import { probeProvider } from "./providers/validate.js";
import { loadSessionFile, pruneSessions, saveSessionSoon, type PromptCheckpoint, type PromptMarker } from "./store.js";
import { capToolImageBase64 } from "./tool-image-cap.js";

interface Session extends AgentSession {
  pending?: AbortController;
  checkpoints: PromptCheckpoint[];
  /** promptId → history-index markers for conversation rewind — see store.ts's PromptMarker. */
  prompts: PromptMarker[];
}

/**
 * doc 11 §4.3: does any prompt LATER than `promptId` also touch a file
 * `promptId` touched? Non-empty result = undoing `promptId` would silently
 * discard those later changes too — surfaced so the client can warn before
 * proceeding, same shape as the manual-edit conflict (§5).
 *
 * SINGLE-prompt undo only (`lakshx/undo_prompt`). The coordinated multi-prompt
 * rewind (`lakshx/rewind_to_prompt` below) deliberately does NOT consult this:
 * there, the later prompts' changes are being reverted together as part of the
 * same operation — they are the point, not a conflict — and flagging them
 * would misreport every multi-prompt rewind as conflicted. Genuinely external
 * disk edits are still caught for rewind by `undoPaths`' per-path
 * `hasConflict` check (disk matching neither the target sha nor shadow HEAD).
 */
function laterOverlap(checkpoints: PromptCheckpoint[], promptId: string): Record<string, string[]> {
  const target = checkpoints.find((c) => c.promptId === promptId);
  if (!target) return {};
  const targetFiles = new Set(target.tools.flatMap((t) => t.files));
  const overlaps: Record<string, string[]> = {};
  for (const c of checkpoints) {
    if (c.createdAt <= target.createdAt) continue;
    for (const t of c.tools) {
      for (const f of t.files) {
        if (targetFiles.has(f)) (overlaps[f] ??= []).push(c.promptId);
      }
    }
  }
  return overlaps;
}

const sessions = new Map<string, Session>();

// housekeeping: bound ~/.lakshx/sessions/ so it never grows unbounded
pruneSessions();

const MODES = [
  { id: "review", name: "Review", description: "Read-only: research the codebase and produce an implementation plan" },
  { id: "approve", name: "Approve", description: "Edits and commands ask for your approval" },
  { id: "auto", name: "Auto", description: "The agent acts without asking" },
  {
    id: "royal",
    name: "Royal",
    description:
      "Full autonomy, full machine access, no restrictions — no safety floor, no permission prompts. Actions are logged and checkpointed, not blocked.",
  },
];

/** Save the review-mode output as a plan file; returns its path. */
function savePlan(cwd: string, text: string): string {
  const dir = join(cwd, ".lakshx", "plans");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const file = join(dir, `plan-${stamp}.md`);
  writeFileSync(file, text.trim() + "\n");
  return file;
}

acp
  .agent({ name: "lakshx-agent" })
  .onRequest("initialize", async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
  }))
  .onRequest("authenticate", async () => ({}))
  .onRequest("session/new", async (ctx) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, { cwd: ctx.params.cwd, history: [], mode: "review", checkpoints: [], prompts: [] });
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
      checkpoints: saved.checkpoints ?? [],
      prompts: saved.prompts ?? [],
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
            // toolResultText: persisted history is always the flat string
            // shape (store.ts scrubs rich image-bearing content down to a
            // string on save), but tolerate the rich form defensively.
            content: [{ type: "content", content: { type: "text", text: toolResultText(block.content).slice(0, 4000) } }],
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
  // LakshX extension: list configured providers + current default model
  .onRequest("lakshx/models", (v: unknown) => v as Record<string, never>, async () => {
    const cfg = loadConfig();
    return { defaultModel: cfg.defaultModel, providers: availableProviders(cfg) };
  })
  // LakshX extension: validate a provider key and list its live models
  .onRequest(
    "lakshx/validate",
    (v: unknown) => v as { provider: string; apiKey?: string },
    async (ctx) => probeProvider(ctx.params.provider, ctx.params.apiKey),
  )
  // LakshX extension: set the model for a session ("provider/model")
  .onRequest(
    "lakshx/set_model",
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

    // doc 11 §1: LakshX's own client mints promptId client-side and attaches
    // it via `_meta` — the ACP SDK's own agent-side request registration
    // auto-validates "session/prompt" against its built-in `zPromptRequest`
    // schema (sessionId/prompt/_meta only) and SILENTLY STRIPS any other
    // top-level field before this handler ever sees `ctx.params`, so a bare
    // `promptId` field (as an early draft of this doc sketched) never
    // arrives no matter what the client sends. `_meta` is the ACP spec's own
    // sanctioned extension-data bag for exactly this case — verified against
    // the SDK's zod schema (`_meta: z.record(z.string(), z.unknown())`)
    // before relying on it. Any other ACP client (Zed, JetBrains) that
    // doesn't send one still works — checkpointing just isn't
    // client-correlatable for that turn.
    const promptId: string = (ctx.params as any)?._meta?.promptId ?? randomUUID();

    // Rewind bookkeeping: record where THIS prompt's user message is about to
    // land in history (runPrompt pushes it at the current end, so the index is
    // exactly `history.length` right now). A marker at/past that index can
    // only be stale — left behind by a prompt whose dangling user message
    // loop.ts popped after a provider error — so it's superseded here rather
    // than ever pointing two prompts at the same slot.
    session.prompts = session.prompts.filter((p) => p.index < session.history.length);
    session.prompts.push({ promptId, index: session.history.length, createdAt: Date.now() });

    const text = prompt
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    const notify = (update: any) =>
      ctx.client.notify(acp.methods.client.session.update, { sessionId, update });

    const persist = () =>
      saveSessionSoon({
        id: sessionId,
        cwd: session.cwd,
        mode: session.mode,
        model: session.model,
        history: session.history,
        checkpoints: session.checkpoints,
        prompts: session.prompts,
      });

    // The one PromptCheckpoint record this turn builds up — created lazily
    // on the first baseline commit, appended to by every subsequent tool
    // commit. Both onBaseline/onCheckpoint close over this same reference.
    let entry: PromptCheckpoint | undefined;
    const ensureEntry = (baselineSha: string | null): PromptCheckpoint => {
      if (!entry) {
        entry = { promptId, baselineSha: baselineSha ?? "", tools: [], createdAt: Date.now() };
        session.checkpoints.push(entry);
      }
      return entry;
    };

    // Live tool-input streaming (LoopCallbacks.onToolInputDelta) — throttled
    // per toolCallId so a fast-typing write_file doesn't flood the wire with
    // one ACP notification per raw JSON fragment. Leading edge fires
    // immediately (the FIRST fragment for a given id is what lets the client
    // create the tool card before the real `tool_call` notification arrives,
    // which is the whole point of this feature); everything after that is
    // coalesced to at most one send per THROTTLE_MS, always carrying the
    // latest value, never a stale intermediate one. Scoped to this one turn
    // — cleared in the `finally` below so a pending timer can never fire
    // after `ctx.client` is no longer safe to notify on (turn already
    // resolved/rejected).
    const TOOL_DELTA_THROTTLE_MS = 100;
    const toolDeltaThrottle = new Map<string, { last: number; timer?: NodeJS.Timeout; pending?: unknown }>();
    const notifyToolInputDelta = (params: { id: string; name: string; field: string; value: string; path?: string }) => {
      const key = params.id;
      const payload = { sessionId, toolCallId: params.id, name: params.name, field: params.field, value: params.value, path: params.path };
      const state = toolDeltaThrottle.get(key);
      if (!state) {
        toolDeltaThrottle.set(key, { last: Date.now() });
        void ctx.client.notify("lakshx/tool_input_delta", payload);
        return;
      }
      state.pending = payload;
      if (state.timer) return;
      const wait = Math.max(0, TOOL_DELTA_THROTTLE_MS - (Date.now() - state.last));
      state.timer = setTimeout(() => {
        state.last = Date.now();
        state.timer = undefined;
        const p = state.pending;
        state.pending = undefined;
        if (p) void ctx.client.notify("lakshx/tool_input_delta", p);
      }, wait);
    };

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
          onUsage: (usage) => void ctx.client.notify("lakshx/usage", { sessionId, ...usage }),
          onHistoryChanged: persist,
          onToolStart: (c) => {
            // The tool is now genuinely dispatching — no more genuine
            // `onToolInputDelta` fragments can arrive for this id (they only
            // ever fire during the model's streaming turn, strictly BEFORE
            // this point in `runPromptLoop`). FLUSH (not discard) any
            // still-pending throttled fragment first: the last fragment of a
            // call is very likely still sitting in its coalescing window
            // right up to this exact moment (this fires within
            // microseconds of the stream ending), and dropping it would
            // leave the client's live preview permanently missing the tail
            // of the value with nothing to ever correct it (unlike title,
            // which `tool_call`'s own `rawInput` refreshes) — always let the
            // client see the true final extracted value before/alongside the
            // official `tool_call`.
            const pending = toolDeltaThrottle.get(c.id);
            if (pending) {
              clearTimeout(pending.timer);
              toolDeltaThrottle.delete(c.id);
              if (pending.pending) void ctx.client.notify("lakshx/tool_input_delta", pending.pending);
            }
            void notify({
              sessionUpdate: "tool_call",
              toolCallId: c.id,
              title: c.title,
              kind: c.kind,
              status: "in_progress",
              rawInput: c.input,
            });
          },
          onToolEnd: (c) => {
            void notify({
              sessionUpdate: "tool_call_update",
              toolCallId: c.id,
              status: c.isError ? "failed" : "completed",
              content: [{ type: "content", content: { type: "text", text: c.output.slice(0, 4000) } }],
            });
            // Screenshot side-channel (currently only `browser_preview` ever
            // sets `image` — see tools.ts's `ToolImageAttachment`). A
            // CUSTOM notification, not an extension of the standard
            // `tool_call_update` above — same shape as `lakshx/tool_input_delta`:
            // one extra ACP notification alongside the unchanged standard
            // flow, so every other tool's existing text-only contract is
            // untouched. `dataBase64` is omitted (not truncated) past the
            // size cap — the client still gets `path` so it can offer
            // "open the saved file" even when the inline preview is
            // skipped.
            if (c.image) {
              void ctx.client.notify("lakshx/tool_image", {
                sessionId,
                toolCallId: c.id,
                mimeType: c.image.mimeType,
                path: c.image.path,
                dataBase64: capToolImageBase64(c.image.base64),
              });
            }
          },
          onToolInputDelta: notifyToolInputDelta,
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
          onBaseline: (sha) => {
            ensureEntry(sha);
            persist();
          },
          onCheckpoint: (info) => {
            const e = ensureEntry(null);
            e.tools.push({ toolCallId: info.toolCallId, toolName: info.toolName, sha: info.sha, files: info.files });
            void ctx.client.notify("lakshx/checkpoint", { sessionId, promptId, ...info });
            persist();
          },
          // Live subagent progress (Part 3) — same shape/pattern as
          // onBaseline/onCheckpoint above: one ACP notification per callback,
          // params spread straight through, no server-side state beyond the
          // sessionId this needs to add for the client to route it.
          onSubagentsStart: (info) => void ctx.client.notify("lakshx/subagents_start", { sessionId, ...info }),
          onSubagentActivity: (info) => void ctx.client.notify("lakshx/subagent_activity", { sessionId, ...info }),
          onSubagentsEnd: (info) => void ctx.client.notify("lakshx/subagents_end", { sessionId, ...info }),
        },
        promptId,
        abort.signal,
        sessionId,
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
        await ctx.client.notify("lakshx/plan_ready", { sessionId, path: planPath });
      }

      // doc 11 §2.6: opportunistic, size-triggered only (250MB) — never
      // blocks the response; fires a one-off notice the client renders as a
      // system transcript line ("older undo history was compacted..."),
      // never silently.
      void maybeCompact(session.cwd).then((r) => {
        if (r.compacted) void ctx.client.notify("lakshx/checkpoint_compacted", { sessionId });
      });

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
      // never let a coalescing timer fire after this turn's `ctx` is done —
      // any still-pending fragment is moot anyway, since the real `tool_call`
      // notification (full rawInput) either already landed or never will.
      for (const state of toolDeltaThrottle.values()) clearTimeout(state.timer);
    }
  })
  // LakshX extension: undo one file to its state before the most recent
  // prompt that touched it (doc 11 §3.2/§4.1) — user-initiated only, never a
  // tool the model can call; available in every mode, including review.
  .onRequest(
    "lakshx/undo_file",
    (v: unknown) => v as { sessionId: string; path: string; force?: boolean },
    async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) throw new Error(`unknown session ${ctx.params.sessionId}`);
      const { path, force } = ctx.params;
      let target: PromptCheckpoint | undefined;
      for (const c of session.checkpoints) {
        if (c.tools.some((t) => t.files.includes(path)) && (!target || c.createdAt > target.createdAt)) target = c;
      }
      if (!target) throw new Error(`no checkpoint found for ${path}`);
      return undoFile(session.cwd, path, target.baselineSha, force);
    },
  )
  // LakshX extension: undo every file a specific prompt touched, atomically,
  // back to that prompt's baseline (doc 11 §3.2/§4.2), warning first if a
  // later prompt also touched one of those files (§4.3).
  .onRequest(
    "lakshx/undo_prompt",
    (v: unknown) => v as { sessionId: string; promptId: string; force?: boolean },
    async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) throw new Error(`unknown session ${ctx.params.sessionId}`);
      const { promptId: targetPromptId, force } = ctx.params;
      const target = session.checkpoints.find((c) => c.promptId === targetPromptId);
      if (!target) throw new Error(`no checkpoint found for prompt ${targetPromptId}`);
      const files = [...new Set(target.tools.flatMap((t) => t.files))];
      if (!force) {
        const overlap = laterOverlap(session.checkpoints, targetPromptId);
        if (Object.keys(overlap).length > 0) return { ok: false, overlap };
      }
      return undoPaths(session.cwd, files, target.baselineSha, force);
    },
  )
  // Conversation rewind ("come back to this message"): revert EVERY file
  // change made by the target prompt AND every later prompt, then truncate
  // session.history to just BEFORE the target prompt's user message, so the
  // next prompt genuinely continues from that earlier context. User-initiated
  // only, never a tool the model can call. Unlike `lakshx/undo_prompt`, later
  // prompts are being reverted together here, so `laterOverlap` is deliberately
  // NOT consulted (see its doc comment) — only genuinely external disk edits
  // (caught per-path by `undoPaths`' hasConflict) require `force`.
  .onRequest(
    "lakshx/rewind_to_prompt",
    (v: unknown) => v as { sessionId: string; promptId: string; force?: boolean },
    async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) throw new Error(`unknown session ${ctx.params.sessionId}`);
      // A running turn is still mutating history/checkpoints/files — rewinding
      // under it would race all three. The client disables the control during
      // a turn too; this is the authoritative backstop.
      if (session.pending) throw new Error("a turn is still running — stop it before rewinding");
      const { promptId, force } = ctx.params;
      const marker = session.prompts.find((p) => p.promptId === promptId);
      if (!marker) throw new Error(`no rewind point recorded for prompt ${promptId}`);
      if (session.history[marker.index]?.role !== "user") {
        throw new Error(`rewind point for prompt ${promptId} is stale — cannot rewind`);
      }

      // The target prompt and every LATER one, by history position (markers),
      // with a createdAt fallback for checkpoints whose promptId was never
      // marker-tracked (e.g. written by an older runtime version).
      const affectedIds = new Set(session.prompts.filter((p) => p.index >= marker.index).map((p) => p.promptId));
      const tracked = new Set(session.prompts.map((p) => p.promptId));
      const affected = session.checkpoints.filter(
        (c) => affectedIds.has(c.promptId) || (!tracked.has(c.promptId) && c.createdAt >= marker.createdAt),
      );
      // Revert set: the union of every file those prompts touched; target sha:
      // the EARLIEST affected checkpoint's baseline (checkpoints are appended
      // chronologically), i.e. the workspace state captured just before the
      // first mutation at/after the rewind point. A rewind across prompts that
      // never mutated anything has nothing to revert and just truncates.
      const files = [...new Set(affected.flatMap((c) => c.tools.flatMap((t) => t.files)))];
      const baselineSha = affected.find((c) => c.baselineSha)?.baselineSha;
      let revertedFiles: string[] = [];
      if (files.length) {
        if (!baselineSha) throw new Error("no baseline recorded for the rewind range — cannot revert files");
        const res = await undoPaths(session.cwd, files, baselineSha, force);
        if (!res.ok) return { ok: false, conflicts: res.conflict.paths };
        revertedFiles = res.reverted;
      }

      const truncatedMessages = session.history.length - marker.index;
      session.history.length = marker.index; // drops the user message itself + everything after
      const affectedSet = new Set(affected);
      session.checkpoints = session.checkpoints.filter((c) => !affectedSet.has(c));
      session.prompts = session.prompts.filter((p) => p.index < marker.index);
      saveSessionSoon({
        id: ctx.params.sessionId,
        cwd: session.cwd,
        mode: session.mode,
        model: session.model,
        history: session.history,
        checkpoints: session.checkpoints,
        prompts: session.prompts,
      });
      return { ok: true, revertedFiles, truncatedMessages };
    },
  )
  // "Open diff" (client-driven, not a tool the model can call): the pre-turn
  // version of a file at the prompt's baseline commit, for the client to
  // hand to `vscode.diff` against the live file on disk — the shadow-git
  // plumbing only lives in this process, so the client can't read it itself.
  .onRequest(
    "lakshx/checkpoint_file_before",
    (v: unknown) => v as { sessionId: string; promptId: string; path: string },
    async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) throw new Error(`unknown session ${ctx.params.sessionId}`);
      const target = session.checkpoints.find((c) => c.promptId === ctx.params.promptId);
      if (!target) throw new Error(`no checkpoint found for prompt ${ctx.params.promptId}`);
      if (!target.baselineSha) throw new Error(`no baseline recorded for prompt ${ctx.params.promptId}`);
      const content = await readFileAtCommit(session.cwd, target.baselineSha, ctx.params.path);
      return { content };
    },
  )
  .onNotification("session/cancel", async (ctx) => {
    sessions.get(ctx.params.sessionId)?.pending?.abort();
  })
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );

process.stderr.write("lakshx-agent ready (ACP over stdio)\n");
