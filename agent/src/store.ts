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
import type { ChatMessage } from "./providers/types.js";

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
}

function sessionsDir(): string {
  const dir = join(homedir(), ".lakshx", "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

/** Deep-scrub any secret-shaped strings out of a history array before it hits disk. */
function scrubHistory(history: ChatMessage[]): ChatMessage[] {
  return history.map((m) => ({
    ...m,
    content: m.content.map((b) => {
      if (b.type === "text") return { ...b, text: scrubSecrets(b.text) };
      if (b.type === "tool_result") return { ...b, content: scrubSecrets(b.content) };
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
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored));
  renameSync(tmp, path);
}

export function loadSessionFile(id: string): StoredSession | null {
  try {
    const raw = JSON.parse(readFileSync(sessionPath(id), "utf8"));
    if ((raw?.v !== 1 && raw?.v !== 2) || !Array.isArray(raw.history)) return null;
    return { ...raw, checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints : [] } as StoredSession;
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
