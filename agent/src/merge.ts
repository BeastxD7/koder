/**
 * AI-assisted merge conflict resolution (docs/research/15-ide-feature-roadmap.md
 * item #6). Backs the `list_merge_conflicts` / `resolve_merge_conflict` tools
 * (tools.ts) — this module owns the git plumbing, conflict-marker parsing,
 * and the dedicated model call; tools.ts just wires it into the normal
 * dangerous-tool dispatch path so the EXISTING floor/permission/checkpoint
 * machinery (loop.ts) gates it exactly like write_file/edit_file, with no
 * parallel safety mechanism built here.
 *
 * Detection prefers git-native status (`git diff --diff-filter=U`) over a
 * marker-regex scan — it's what git itself considers unresolved, matching
 * what VS Code's own Source Control view and 3-way merge editor already key
 * off, and it's immune to a file that happens to contain the literal text
 * "<<<<<<<" without actually being an unresolved conflict (a code sample in
 * a markdown file, a test fixture, etc). The marker scan is kept only as a
 * fallback for a workspace with no `.git` at all (or a broken git binary),
 * and every caller can see which path was used via `method`.
 */
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig, resolveModel } from "./config.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { OpenAICompatAdapter } from "./providers/openai-compat.js";
import type { ChatAdapter } from "./providers/types.js";
import { clip } from "./tools.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Conflict-hunk parsing — pure, synchronous, no I/O. This is the piece unit
// tests target directly with synthetic conflicted-file strings.
// ---------------------------------------------------------------------------

export interface ConflictHunk {
  /** "our" side content (no trailing newline), i.e. between <<<<<<< and either ||||||| or =======. */
  ours: string;
  /** "their" side content, between ======= and >>>>>>>. */
  theirs: string;
  /** Common-ancestor content, only present for diff3-style markers (between ||||||| and =======). */
  base?: string;
  /** Whatever followed <<<<<<< on its own line (usually a ref/branch name), e.g. "HEAD". */
  oursLabel: string;
  /** Whatever followed >>>>>>> on its own line, e.g. "feature-branch". */
  theirsLabel: string;
  /** 1-based line number of the <<<<<<< marker. */
  startLine: number;
  /** 1-based line number of the >>>>>>> marker. */
  endLine: number;
}

const CONFLICT_START = /^<<<<<<<[ \t]?(.*)$/;
const CONFLICT_BASE = /^\|\|\|\|\|\|\|[ \t]?(.*)$/;
const CONFLICT_MID = /^=======[ \t]*$/;
const CONFLICT_END = /^>>>>>>>[ \t]?(.*)$/;

/**
 * Parse every conflict hunk out of a file's raw content. Tolerates both
 * plain (ours/theirs only) and diff3-style (ours/base/theirs,
 * `merge.conflictStyle = diff3`) markers. A malformed/truncated hunk (a
 * `<<<<<<<` with no matching `=======`/`>>>>>>>` before EOF) is dropped
 * rather than throwing — callers treat zero hunks as "nothing to resolve,"
 * which is the safe default for a file that doesn't actually have real
 * conflict markers.
 */
export function parseConflictHunks(content: string): ConflictHunk[] {
  const lines = content.split("\n");
  const hunks: ConflictHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const startMatch = CONFLICT_START.exec(lines[i]);
    if (!startMatch) {
      i++;
      continue;
    }
    const startLine = i + 1;
    const oursLabel = startMatch[1]?.trim() || "ours";
    i++;

    const oursLines: string[] = [];
    let baseLines: string[] | undefined;
    let inBase = false;
    let foundMid = false;
    while (i < lines.length) {
      if (CONFLICT_MID.test(lines[i])) {
        foundMid = true;
        break;
      }
      const baseMatch = CONFLICT_BASE.exec(lines[i]);
      if (baseMatch && !inBase) {
        inBase = true;
        baseLines = [];
        i++;
        continue;
      }
      (inBase ? baseLines! : oursLines).push(lines[i]);
      i++;
    }
    if (!foundMid) break; // malformed: no ======= before EOF — stop parsing, drop this partial hunk
    i++; // skip the ======= line itself

    const theirsLines: string[] = [];
    let foundEnd = false;
    let endMatch: RegExpExecArray | null = null;
    while (i < lines.length) {
      endMatch = CONFLICT_END.exec(lines[i]);
      if (endMatch) {
        foundEnd = true;
        break;
      }
      theirsLines.push(lines[i]);
      i++;
    }
    if (!foundEnd) break; // malformed: no >>>>>>> before EOF
    const endLine = i + 1;
    const theirsLabel = endMatch![1]?.trim() || "theirs";
    i++;

    hunks.push({
      ours: oursLines.join("\n"),
      theirs: theirsLines.join("\n"),
      base: baseLines?.join("\n"),
      oursLabel,
      theirsLabel,
      startLine,
      endLine,
    });
  }
  return hunks;
}

// ---------------------------------------------------------------------------
// Detection: which files have unresolved conflicts right now.
// ---------------------------------------------------------------------------

export interface MergeConflictScan {
  /** Absolute paths of files with unresolved conflicts. */
  files: string[];
  /** Which detection strategy actually produced this list — surfaced honestly, never hidden. */
  method: "git-status" | "marker-scan";
}

/**
 * List files with unresolved merge conflicts. Prefers `git diff --diff-filter=U`
 * (files git itself considers "unmerged" — stage 1/2/3 entries in the index,
 * exactly what an in-progress `git merge`/`rebase`/`cherry-pick` leaves
 * behind, and the same set VS Code's Source Control view groups as "Merge
 * Changes"). Falls back to a bounded ripgrep marker scan only when git isn't
 * usable at all (no `.git`, git not installed) — an honest, documented
 * fallback, not the preferred path.
 */
export async function listMergeConflicts(cwd: string): Promise<MergeConflictScan> {
  const worktree = resolve(cwd);
  try {
    const { stdout: topOut } = await execFileAsync("git", ["-C", worktree, "rev-parse", "--show-toplevel"]);
    const toplevel = topOut.trim();
    const { stdout } = await execFileAsync("git", ["-C", worktree, "diff", "--name-only", "--diff-filter=U"]);
    const files = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((relPath) => resolve(toplevel, relPath));
    return { files, method: "git-status" };
  } catch {
    return markerScanFallback(worktree);
  }
}

async function markerScanFallback(worktree: string): Promise<MergeConflictScan> {
  const rg = process.env.LAKSHX_RG_PATH ?? "rg";
  try {
    const { stdout } = await execFileAsync(rg, ["-l", "--max-count", "1", "^<<<<<<< ", worktree], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const files = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return { files, method: "marker-scan" };
  } catch {
    // rg exit code 1 = no matches, or rg/the whole scan failed outright — either way, nothing found
    return { files: [], method: "marker-scan" };
  }
}

// ---------------------------------------------------------------------------
// Reading the three git index stages for a conflicted path (base/ours/theirs)
// — extra signal for the model beyond what's already inline in the file's
// own conflict markers (the markers alone never carry the base/common
// ancestor unless `merge.conflictStyle = diff3` is set).
// ---------------------------------------------------------------------------

export interface ConflictStages {
  base?: string;
  ours?: string;
  theirs?: string;
}

async function gitShowStage(toplevel: string, stage: 1 | 2 | 3, relPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", toplevel, "show", `:${stage}:${relPath}`], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    // Stage doesn't exist for this path (e.g. an add/add conflict has no
    // common-ancestor stage 1) — not an error, just missing context.
    return undefined;
  }
}

/**
 * Read git's stage 1 (base)/2 (ours)/3 (theirs) blobs for `filePath` via
 * `git show :<n>:<path>`. Paths in the index are relative to the repo
 * TOPLEVEL, not to `cwd` — this resolves that mapping so callers can pass
 * either an absolute path or one relative to `cwd`. Returns all-undefined
 * (never throws) when the workspace isn't a git repo at all — the caller
 * still has the file's own inline markers to work with.
 */
export async function readConflictStages(cwd: string, filePath: string): Promise<ConflictStages> {
  const worktree = resolve(cwd);
  const absPath = isAbsolute(filePath) ? filePath : resolve(worktree, filePath);
  let toplevel = worktree;
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktree, "rev-parse", "--show-toplevel"]);
    toplevel = stdout.trim() || worktree;
  } catch {
    return {}; // not a git repo — no stages available
  }
  const relPath = relative(toplevel, absPath);
  const [base, ours, theirs] = await Promise.all([
    gitShowStage(toplevel, 1, relPath),
    gitShowStage(toplevel, 2, relPath),
    gitShowStage(toplevel, 3, relPath),
  ]);
  return { base, ours, theirs };
}

// ---------------------------------------------------------------------------
// The dedicated model call — deliberately a FRESH, minimal conversation (one
// system prompt, one user message, no tools), not a continuation of the main
// loop's `session.history`. Keeps the sub-call focused purely on "resolve
// this conflict" and testable in isolation; the main agent's much larger
// system prompt/tool surface would only add noise to a call that has exactly
// one job.
// ---------------------------------------------------------------------------

const RESOLUTION_SYSTEM_PROMPT = `You are a focused merge-conflict resolution assistant. You will be given one file's full content with unresolved git conflict markers (possibly several hunks), plus each hunk's OURS/THEIRS (and BASE, when available) content from the git index for extra context.

For EACH hunk, decide the correct resolution:
- If one side is clearly a superset, a fix, or clearly supersedes the other, prefer it.
- If both sides made independent, compatible changes, combine them sensibly.
- If a hunk's correct resolution is genuinely ambiguous or the two sides conflict semantically (not just textually), make your best reasonable judgment call and say so plainly in your reasoning — never leave conflict markers in the output.

Respond in exactly this shape:
1. A "### Reasoning" section: one short paragraph per hunk (in order) explaining what you resolved and why, including any hunk you flagged as ambiguous.
2. Then the COMPLETE resolved file content, with ALL conflict markers removed, wrapped EXACTLY like this (nothing else inside the tags but the file's own content):
<resolved_file>
...full resolved file content here...
</resolved_file>

Do not add commentary inside the tags. Do not omit any part of the file that wasn't part of a conflict — reproduce it unchanged.`;

export interface ResolutionProposal {
  resolvedContent: string;
  reasoning: string;
}

function buildAdapter(): { adapter: ChatAdapter; model: string } {
  // Deliberately the configured DEFAULT model, not necessarily whatever
  // model the calling session/turn is using — this sub-call is meant to stay
  // small and focused (per this module's doc comment), and using the
  // session's live model would require threading it through tools.ts's
  // shared `ToolSpec.run(input, cwd, signal)` signature for every tool, not
  // just this one. A future version could accept an explicit override.
  const cfg = loadConfig();
  const { provider, model } = resolveModel(cfg);
  const adapter: ChatAdapter = provider.kind === "anthropic" ? new AnthropicAdapter(provider) : new OpenAICompatAdapter(provider);
  return { adapter, model };
}

const RESOLVED_FILE_RE = /<resolved_file>([\s\S]*?)<\/resolved_file>/;
/** Any conflict marker surviving in a proposed resolution means the model didn't actually resolve it — refuse to write. */
const LEFTOVER_MARKER_RE = /^(<<<<<<<|=======|>>>>>>>)/m;

/**
 * Ask the model to resolve one conflicted file's hunks. Never writes
 * anything — purely a proposal step; the caller (tools.ts's
 * `resolve_merge_conflict`) decides whether/when to write, and only reaches
 * that point after the normal dangerous-tool gate has already cleared.
 *
 * Throws (rather than returning a best-effort guess) on anything that would
 * make writing the result unsafe: a truncated response, a response that
 * doesn't contain a `<resolved_file>` block, or a "resolved" file that still
 * contains conflict markers. A bad write corrupts the user's source file, so
 * these are refusals, not warnings.
 */
export async function proposeResolution(
  filePath: string,
  content: string,
  hunks: ConflictHunk[],
  stages: ConflictStages,
  signal?: AbortSignal,
): Promise<ResolutionProposal> {
  const { adapter, model } = buildAdapter();

  const stageBlock =
    stages.base !== undefined || stages.ours !== undefined || stages.theirs !== undefined
      ? "\n\nGit index stages for additional context (the common ancestor and each side's full version — may include unrelated parts of the file the inline markers don't show):\n" +
        (stages.base !== undefined ? `--- base (common ancestor) ---\n${clip(stages.base, 12_000)}\n` : "") +
        (stages.ours !== undefined ? `--- ours ---\n${clip(stages.ours, 12_000)}\n` : "") +
        (stages.theirs !== undefined ? `--- theirs ---\n${clip(stages.theirs, 12_000)}\n` : "")
      : "";

  const user =
    `File: ${filePath}\nThis file has ${hunks.length} unresolved git conflict hunk${hunks.length === 1 ? "" : "s"}. ` +
    `Full current content with conflict markers:\n\n${clip(content, 40_000)}${stageBlock}`;

  const result = await adapter.runTurn({
    model,
    system: RESOLUTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: user }] }],
    tools: [],
    signal,
  });

  if (result.stopReason === "max_tokens") {
    throw new Error(
      "the model's response was truncated (max_tokens) before it finished the resolved file — refusing to write a partial result; try resolving fewer hunks at once or a smaller file",
    );
  }

  const match = RESOLVED_FILE_RE.exec(result.text);
  if (!match) {
    throw new Error(
      "the model did not return a resolution in the expected <resolved_file> format — refusing to write anything to disk",
    );
  }
  const resolvedContent = match[1].replace(/^\n/, "");
  if (LEFTOVER_MARKER_RE.test(resolvedContent)) {
    throw new Error(
      "the model's proposed resolution still contains conflict markers — refusing to write an unresolved file",
    );
  }
  const reasoning = result.text.slice(0, match.index).trim() || "(no reasoning provided)";
  return { resolvedContent, reasoning };
}
