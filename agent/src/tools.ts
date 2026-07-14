/** Koder agent tool set v1 — minimal composable surface (mini-SWE-agent lesson). */
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
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

export type ToolKind = "read" | "edit" | "execute" | "search";

export interface ToolSpec extends ToolDef {
  /** ACP tool-call kind for UI rendering */
  kind: ToolKind;
  /** true → must pass through the permission gate */
  dangerous: boolean;
  run(input: any, cwd: string, signal?: AbortSignal): Promise<string>;
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
      return slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n") || "(offset past end of file)";
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
      const rg = process.env.KODER_RG_PATH ?? "rg";
      const globArg = input.glob ? `--glob ${JSON.stringify(input.glob)}` : "";
      const target = JSON.stringify(abs(cwd, input.path ?? "."));
      try {
        const { stdout } = await execAsync(
          `${JSON.stringify(rg)} --line-number --no-heading --max-count 200 --max-columns 300 ${globArg} -e ${JSON.stringify(input.pattern)} ${target}`,
          { cwd, signal, maxBuffer: 4 * 1024 * 1024 },
        );
        return stdout.slice(0, 60_000) || "(no matches)";
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
        const { stdout, stderr } = await execAsync(input.command, {
          cwd,
          signal,
          timeout: input.timeout_ms ?? 120_000,
          maxBuffer: 4 * 1024 * 1024,
          shell: SHELL,
        });
        const out = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
        return out.slice(0, 60_000) || "(no output)";
      } catch (err: any) {
        const out = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 60_000);
        return `EXIT ${err.code ?? "?"}\n${out}`;
      }
    },
  },
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
