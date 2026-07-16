/**
 * Local session persistence — makes "resume an old chat" actually restore
 * the agent's working memory (session.history), not just a rendered view.
 * Plain JSON files under ~/.lakshx/sessions/, atomic writes, debounced.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scrubSecrets } from "./context.js";
import type { AgentMode } from "./loop.js";
import type { ChatMessage, ToolResultPart } from "./providers/types.js";

/**
 * One prompt's checkpoint record (docs/research/11-prompt-checkpoints-undo.md
 * §3.1) — the baseline SHA plus every mutating tool call's own commit, each
 * with the file list `commitAfterTool()` derived from the shadow-git diff
 * (never from a tool's declared input path). Both UI undo surfaces (chat
 * panel per-turn "Files changed", editor-title per-file undo) read from this
 * one structure — they are two views, not two mechanisms.
 */
export interface PromptCheckpoint {
  promptId: string;
  baselineSha: string;
  tools: { toolCallId: string; toolName: string; sha: string; files: string[] }[];
  createdAt: number;
}

/**
 * Where one prompt's user message landed in `history` — the correlation the
 * conversation-rewind feature needs to truncate history "to just before this
 * prompt". Recorded by server.ts at `session/prompt` time (BEFORE runPrompt
 * pushes the user message, so `index === history.length` at that moment) and
 * kept in sync with truncation on rewind. `createdAt` is the fallback used to
 * classify checkpoints whose promptId predates marker tracking.
 */
export interface PromptMarker {
  promptId: string;
  /** Index in `history` of this prompt's user message. */
  index: number;
  createdAt: number;
}

export interface StoredSession {
  v: 1 | 2;
  id: string;
  cwd: string;
  mode: AgentMode;
  model?: string;
  createdAt: number;
  updatedAt: number;
  history: ChatMessage[];
  /** Absent on v1 files — always treated as [] when reading. */
  checkpoints?: PromptCheckpoint[];
  /**
   * Absent on files written before the rewind feature — always treated as []
   * when reading (rewind is then simply unavailable for those old prompts —
   * graceful degradation, no schema bump needed: this is a purely additive
   * optional field, so v2 stays v2 and files written by this code still load
   * fine in older readers).
   */
  prompts?: PromptMarker[];
}

function sessionsDir(): string {
  const dir = join(homedir(), ".lakshx", "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

/**
 * Flatten a tool_result's content to a scrubbed plain STRING for disk.
 *
 * A rich `ToolResultPart[]` content (loop.ts's vision embedding — see
 * providers/types.ts) can carry a screenshot's multi-MB base64; persisting
 * that would balloon every session JSON and every debounced re-write. So on
 * save: text parts are scrubbed and kept, image parts are DROPPED and
 * replaced with a small marker naming the already-on-disk PNG path. The
 * persisted format therefore stays the pre-existing string shape (no schema
 * bump, old readers unaffected). Consequence, accepted deliberately: after
 * a session/load the model won't re-see old screenshots — it can always
 * re-run browser_act {action:"screenshot"} for fresh eyes.
 */
function scrubToolResultContent(content: string | ToolResultPart[]): string {
  if (typeof content === "string") return scrubSecrets(content);
  return content
    .map((p) =>
      p.type === "text"
        ? scrubSecrets(p.text)
        : `[screenshot omitted from saved session${p.path ? `: ${scrubSecrets(p.path)}` : ""}]`,
    )
    .join("\n");
}

/** Deep-scrub any secret-shaped strings out of a history array before it hits disk. */
function scrubHistory(history: ChatMessage[]): ChatMessage[] {
  return history.map((m) => ({
    ...m,
    content: m.content.map((b) => {
      if (b.type === "text") return { ...b, text: scrubSecrets(b.text) };
      if (b.type === "tool_result") return { ...b, content: scrubToolResultContent(b.content) };
      if (b.type === "tool_use") return { ...b, input: JSON.parse(scrubSecrets(JSON.stringify(b.input ?? {}))) };
      return b;
    }),
  }));
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
const createdAtCache = new Map<string, number>();

/** Debounced (300ms) atomic write — safe to call after every history push. */
export function saveSessionSoon(session: {
  id: string;
  cwd: string;
  mode: AgentMode;
  model?: string;
  history: ChatMessage[];
  checkpoints?: PromptCheckpoint[];
  prompts?: PromptMarker[];
}): void {
  const existing = pending.get(session.id);
  if (existing) clearTimeout(existing);
  pending.set(
    session.id,
    setTimeout(() => {
      pending.delete(session.id);
      try {
        writeSessionNow(session);
      } catch {
        /* best-effort — never let persistence crash a turn */
      }
    }, 300),
  );
}

function writeSessionNow(session: {
  id: string;
  cwd: string;
  mode: AgentMode;
  model?: string;
  history: ChatMessage[];
  checkpoints?: PromptCheckpoint[];
  prompts?: PromptMarker[];
}): void {
  const path = sessionPath(session.id);
  const createdAt = createdAtCache.get(session.id) ?? (existsSync(path) ? loadSessionFile(session.id)?.createdAt : undefined) ?? Date.now();
  createdAtCache.set(session.id, createdAt);

  const stored: StoredSession = {
    v: 2,
    id: session.id,
    cwd: session.cwd,
    mode: session.mode,
    model: session.model,
    createdAt,
    updatedAt: Date.now(),
    history: scrubHistory(session.history),
    checkpoints: session.checkpoints ?? [],
    prompts: session.prompts ?? [],
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored));
  renameSync(tmp, path);
}

export function loadSessionFile(id: string): StoredSession | null {
  try {
    const raw = JSON.parse(readFileSync(sessionPath(id), "utf8"));
    if ((raw?.v !== 1 && raw?.v !== 2) || !Array.isArray(raw.history)) return null;
    return {
      ...raw,
      checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints : [],
      prompts: Array.isArray(raw.prompts) ? raw.prompts : [],
    } as StoredSession;
  } catch {
    return null;
  }
}

/** Keep the newest N session files and drop anything older than maxAgeDays. */
export function pruneSessions(keepNewest = 200, maxAgeDays = 60): void {
  try {
    const dir = sessionsDir();
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const full = join(dir, f);
        return { full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    files.forEach((f, i) => {
      if (i >= keepNewest || f.mtime < cutoff) {
        try {
          unlinkSync(f.full);
        } catch {
          /* ignore */
        }
      }
    });
  } catch {
    /* best-effort housekeeping, never fatal */
  }
}
