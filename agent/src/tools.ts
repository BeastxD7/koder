/** LakshX agent tool set v1 — minimal composable surface (mini-SWE-agent lesson). */
import { exec, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { runBrowserPreview } from "./browser.js";
import type { ToolDef } from "./providers/types.js";

const execAsync = promisify(exec);

/**
 * Pick a real shell instead of assuming one. zsh is the macOS default but is
 * frequently absent on Linux (including GitHub's ubuntu-latest runners) —
 * hardcoding it there throws ENOENT. Windows keeps Node's own cmd.exe
 * default (shell: undefined).
 */
function resolveShell(): string | undefined {
  if (process.platform === "win32") return undefined;
  for (const candidate of ["/bin/zsh", "/bin/bash"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined; // falls back to /bin/sh, always present on POSIX
}
const SHELL = resolveShell();

/**
 * Kill-switch hardening for `bash`: plain `exec({ signal })` sends exactly
 * one SIGTERM to the direct child and never escalates — a child that ignores
 * SIGTERM (or a grandchild it spawned itself, e.g. a dev server a build
 * script starts) survives `session/cancel` indefinitely.
 *
 * This uses `child_process.spawn` directly (NOT `exec`) with `detached:
 * true`, which makes the child its own process-GROUP leader so
 * cancellation/timeout can target the whole group via `process.kill(-pid,
 * sig)`, then escalates SIGTERM → SIGKILL after a short grace period if
 * anything in that group is still alive. This is what makes `session/cancel`
 * (`server.ts`) an actual kill switch rather than a best-effort request,
 * regardless of mode — Royal mode being the hardest one to stop unattended
 * would be exactly backwards.
 *
 * `spawn`, not `exec`, is load-bearing here, verified empirically before
 * committing to this design: `exec(cmd, { detached: true })` does NOT
 * actually give the child its own process group — `exec` builds a fixed set
 * of options for the underlying `spawn` call and does not forward arbitrary
 * extra keys through, so `detached` is silently dropped and the child stays
 * in the parent's group (confirmed via `ps -o pid,pgid` on the running
 * child: PGID matched the parent, not the child's own PID). `spawn(shell,
 * ["-c", command], { detached: true })` gives the correct PGID-equals-PID
 * group-leader shape. This is the reason a hand-rolled shell invocation
 * (`spawn(shellPath, ["-c", command], ...)`) replaces `execAsync` here
 * instead of trying to coerce more options into `exec`.
 */
const KILL_GRACE_MS = 2000;

function execWithKillEscalation(
  command: string,
  opts: { cwd: string; signal?: AbortSignal; timeoutMs: number; maxBuffer: number; shell?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const isWin = process.platform === "win32";
    const shellPath = opts.shell ?? (isWin ? undefined : "/bin/sh"); // matches resolveShell()'s own POSIX fallback comment
    const child = isWin
      ? spawn(command, { cwd: opts.cwd, shell: true, windowsHide: true })
      : spawn(shellPath!, ["-c", command], { cwd: opts.cwd, detached: true });

    let stdout = "";
    let stderr = "";
    let overBuffer = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    function killGroup(signal: NodeJS.Signals) {
      if (!child.pid) return;
      try {
        // Negative pid = "the whole process group" on POSIX (requires the
        // detached:true group-leader spawn above). Windows has no equivalent
        // via process.kill, so fall back to killing the direct child only —
        // matches this tool's pre-existing Windows behavior, not a regression.
        if (isWin) child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // already exited, or the group is already gone — nothing to do
      }
    }

    function escalate() {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    }

    function cleanup() {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
    }

    function trackOutput(chunk: Buffer, stream: "stdout" | "stderr") {
      if (overBuffer) return;
      const s = chunk.toString("utf8");
      if (stream === "stdout") stdout += s;
      else stderr += s;
      // Matches Node's own `exec` maxBuffer semantics: a PER-STREAM cap, not combined.
      if (stdout.length > opts.maxBuffer || stderr.length > opts.maxBuffer) {
        overBuffer = true;
        escalate(); // stop the process instead of buffering unbounded output
      }
    }
    child.stdout?.on("data", (c) => trackOutput(c, "stdout"));
    child.stderr?.on("data", (c) => trackOutput(c, "stderr"));

    child.on("error", (err: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (overBuffer) {
        const err: any = new Error(`stdout/stderr maxBuffer (${opts.maxBuffer} bytes) exceeded`);
        err.code = code;
        err.signal = signal;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        const err: any = new Error(signal ? `command killed by ${signal}` : `command failed with exit code ${code}`);
        err.code = code ?? undefined;
        err.signal = signal ?? undefined;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });

    if (opts.signal) {
      onAbort = () => escalate();
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    timeoutTimer = setTimeout(escalate, opts.timeoutMs);
  });
}

/**
 * Head+tail truncation instead of pure head truncation: build/test output
 * puts the verdict at the TAIL (FAIL, error TS2345, exit summaries) — a
 * naive head-only cap systematically deletes the most load-bearing bytes.
 */
export function clip(s: string, max = 60_000, headFrac = 0.65): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * headFrac);
  const tail = max - head;
  return (
    s.slice(0, head) +
    `\n…[${(s.length - max).toLocaleString()} chars elided — narrow the command/pattern to see more]…\n` +
    s.slice(-tail)
  );
}

export type ToolKind = "read" | "edit" | "execute" | "search";

/**
 * Additive, optional side-channel attached to a tool's result for the UI
 * layer only — see `ToolRunResult` below. Currently only `browser_preview`
 * (src/browser.ts) ever populates this, to carry its screenshot to the
 * client for inline rendering (loop.ts -> server.ts -> extension.js ->
 * panel.js). Never flows into the model-facing tool_result content: only
 * `ToolRunResult.text` (or a plain string) does that, so this can never
 * change what the model sees.
 */
export interface ToolImageAttachment {
  mimeType: string;
  /** Base64-encoded image bytes. */
  base64: string;
  /** Absolute path to the file already saved on disk (e.g. for "open full size"). */
  path: string;
}

/**
 * The richer, opt-in shape a tool's `run()` may return instead of a plain
 * string — same `text` contract every other tool already satisfies (a plain
 * `string` return still works everywhere `run()` is awaited, see loop.ts's
 * one dispatch site), plus an optional `image` attachment. This keeps the
 * shared tool-result contract additive: existing tools returning `string`
 * needed zero changes.
 */
export interface ToolRunResult {
  text: string;
  image?: ToolImageAttachment;
}

export interface ToolSpec extends ToolDef {
  /** ACP tool-call kind for UI rendering */
  kind: ToolKind;
  /** true → must pass through the permission gate */
  dangerous: boolean;
  run(input: any, cwd: string, signal?: AbortSignal): Promise<string | ToolRunResult>;
}

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export const TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    kind: "read",
    dangerous: false,
    description: "Read a file. Returns its content with 1-based line numbers.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute or relative to workspace)" },
        offset: { type: "number", description: "1-based line to start from" },
        limit: { type: "number", description: "Max lines to return (default 800)" },
      },
      required: ["path"],
    },
    async run(input, cwd) {
      const content = await readFile(abs(cwd, input.path), "utf8");
      if (content === "") return "(empty file)";
      const lines = content.replace(/\n$/, "").split("\n");
      const start = Math.max(0, (input.offset ?? 1) - 1);
      const slice = lines.slice(start, start + (input.limit ?? 800));
      const out = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
      return clip(out, 48_000) || "(offset past end of file)";
    },
  },
  {
    name: "write_file",
    kind: "edit",
    dangerous: true,
    description: "Create or overwrite a file with the given content.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    async run(input, cwd) {
      const p = abs(cwd, input.path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, input.content, "utf8");
      return `wrote ${input.content.length} chars to ${p}`;
    },
  },
  {
    name: "edit_file",
    kind: "edit",
    dangerous: true,
    description:
      "Replace an exact string in a file. old_string must appear exactly once — include surrounding lines to disambiguate.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async run(input, cwd) {
      const p = abs(cwd, input.path);
      const content = await readFile(p, "utf8");
      const count = content.split(input.old_string).length - 1;
      if (count === 0) throw new Error("old_string not found in file");
      if (count > 1) throw new Error(`old_string matches ${count} times — add surrounding context to make it unique`);
      // replacer fn: string form interprets $&, $', $$ patterns and corrupts code
      await writeFile(p, content.replace(input.old_string, () => input.new_string), "utf8");
      return `edited ${p}`;
    },
  },
  {
    name: "list_dir",
    kind: "read",
    dangerous: false,
    description: "List a directory. Directories end with /.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Defaults to workspace root" } },
    },
    async run(input, cwd) {
      const p = abs(cwd, input.path ?? ".");
      const entries = await readdir(p);
      const out: string[] = [];
      for (const e of entries.slice(0, 500)) {
        try {
          const s = await stat(resolve(p, e));
          out.push(s.isDirectory() ? `${e}/` : e);
        } catch {
          out.push(e);
        }
      }
      return out.sort().join("\n") || "(empty)";
    },
  },
  {
    name: "grep",
    kind: "search",
    dangerous: false,
    description: "Search file contents with a regex (ripgrep). Returns matching lines as path:line:text.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Directory or file to search (default workspace)" },
        glob: { type: "string", description: "Filter files, e.g. *.ts" },
      },
      required: ["pattern"],
    },
    async run(input, cwd, signal) {
      const rg = process.env.LAKSHX_RG_PATH ?? "rg";
      const globArg = input.glob ? `--glob ${JSON.stringify(input.glob)}` : "";
      const target = JSON.stringify(abs(cwd, input.path ?? "."));
      try {
        const { stdout } = await execAsync(
          `${JSON.stringify(rg)} --line-number --no-heading --max-count 200 --max-columns 300 ${globArg} -e ${JSON.stringify(input.pattern)} ${target}`,
          { cwd, signal, maxBuffer: 4 * 1024 * 1024 },
        );
        return clip(stdout, 24_000) || "(no matches)";
      } catch (err: any) {
        if (err.code === 1) return "(no matches)";
        throw err;
      }
    },
  },
  {
    name: "bash",
    kind: "execute",
    dangerous: true,
    description:
      "Run a shell command in the workspace. Use for builds, tests, git, and anything the other tools don't cover.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number", description: "Default 120000" },
      },
      required: ["command"],
    },
    async run(input, cwd, signal) {
      try {
        const { stdout, stderr } = await execWithKillEscalation(input.command, {
          cwd,
          signal,
          timeoutMs: input.timeout_ms ?? 120_000,
          maxBuffer: 4 * 1024 * 1024,
          shell: SHELL,
        });
        const out = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
        return clip(out, 60_000) || "(no output)";
      } catch (err: any) {
        const out = clip([err.stdout, err.stderr, err.message].filter(Boolean).join("\n"), 60_000);
        return `EXIT ${err.code ?? "?"}\n${out}`;
      }
    },
  },
  {
    name: "browser_preview",
    kind: "execute",
    dangerous: true,
    description:
      "Load a LOCALHOST-ONLY dev server or webview you just built in a real browser and get back text signals: " +
      "HTTP status, page title, console errors/warnings captured during load, whether an optional CSS selector " +
      "appeared, and a capped chunk of visible page text. A screenshot is also saved to disk under .lakshx/tmp/ " +
      "and shown inline to the HUMAN in chat — it is NOT shown to you, so don't rely on it to answer visual " +
      "questions; use the text signals above for that. " +
      "Only 127.0.0.1, ::1, and localhost URLs are accepted (with any port/path) — this cannot reach the public " +
      "internet or any other host, and file:// URLs are rejected outright.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Loopback URL to load, e.g. http://localhost:3000/" },
        wait_for_selector: { type: "string", description: "Optional CSS selector to wait for before capturing signals" },
        timeout_ms: { type: "number", description: "Default 15000" },
      },
      required: ["url"],
    },
    async run(input, cwd, signal) {
      return runBrowserPreview(input, cwd, signal);
    },
  },
  {
    name: "dispatch_subtasks",
    kind: "execute",
    // Not gated behind the permission/floor machinery itself — the
    // SUBTASK's own tool calls go through that machinery recursively, in
    // whatever mode the subtask runs under (same as any other tool call in
    // the main loop), so this dispatch call has nothing dangerous to gate on
    // its own. See loop.ts's `dispatchSubtasks()` for the actual execution
    // (this tool is special-cased there, before the generic `spec.run(...)`
    // path every other tool goes through — `run` below is a defensive stub
    // that should never actually be invoked).
    dangerous: false,
    description:
      "Run 2-6 independent subtasks concurrently, each in its own isolated context, then get all their results back together. " +
      "Use this ONLY for genuinely independent, parallelizable work — e.g. \"investigate 3 unrelated files for the same bug pattern\" or \"research 2 different implementation approaches\". " +
      "Do NOT use it for tasks that depend on each other's output (a subtask cannot see another subtask's results while running) — keep those sequential in your normal tool calls instead. " +
      "Do NOT dispatch subtasks that are likely to edit the SAME file — there is no file-level lock, only a lock around the checkpoint/commit bookkeeping itself, so two subtasks racing on one file can silently overwrite each other's edits (last write wins). " +
      "Each subtask starts with an EMPTY history (not your conversation so far) plus exactly what you give it: its own `prompt`, and, only if you explicitly include it, a short `context` string carrying anything from your own investigation the subtask needs (e.g. \"the bug is likely in auth.ts around line 40\") — nothing else about this conversation is shared automatically. " +
      "At most 6 tasks run per call; extra tasks beyond that are not run and must be resubmitted in a follow-up call. Subtasks cannot themselves call dispatch_subtasks (no nested fan-out). " +
      "Available in review mode too, for parallel read-only research — but if YOU are currently in review mode, every subtask is forced to run in review mode as well no matter what `mode` you request for it, so it can only read/list/grep, never write or run commands.",
    input_schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          description: "2-6 independent subtasks to run concurrently (max 6 per call).",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short unique id for this task, used to label its result." },
              prompt: { type: "string", description: "The subtask's instructions — self-contained, this is the ONLY thing the subtask is asked to do." },
              context: {
                type: "string",
                description: "Optional. A short, explicitly-chosen excerpt of what you already know that the subtask needs — NOT your full conversation, just what's relevant.",
              },
              mode: {
                type: "string",
                enum: ["review", "approve", "auto", "royal"],
                description: "Optional. Defaults to your own current mode if omitted.",
              },
            },
            required: ["id", "prompt"],
          },
        },
      },
      required: ["tasks"],
    },
    async run() {
      // Defensive only: loop.ts special-cases `dispatch_subtasks` and never
      // reaches this — see the comment on this tool's `dangerous` field.
      throw new Error("dispatch_subtasks must be handled by the loop's dispatch_subtasks branch, not executed generically");
    },
  },
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
