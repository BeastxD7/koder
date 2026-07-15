/** Unit tests for src/tools.ts — every tool exercised against a temp workspace. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { toolByName } from "../src/tools.js";

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tool(name: string) {
  const t = toolByName.get(name);
  assert.ok(t, `tool ${name} registered`);
  return t!;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "lakshx-tools-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Find a usable ripgrep binary, or undefined (grep tests then skip). */
function findRg(): string | undefined {
  const candidates = [
    process.env.LAKSHX_RG_PATH,
    "rg",
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    resolve(agentDir, "../upstream/node_modules/@vscode/ripgrep/bin/rg"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/* ---------------- read_file ---------------- */

test("read_file returns 1-based line-numbered content", async () =>
  withTmp(async (dir) => {
    await writeFile(join(dir, "f.txt"), "alpha\nbravo\ncharlie");
    const out = await tool("read_file").run({ path: "f.txt" }, dir);
    assert.equal(out, "1\talpha\n2\tbravo\n3\tcharlie");
  }));

test("read_file honors offset and limit", async () =>
  withTmp(async (dir) => {
    await writeFile(join(dir, "f.txt"), "l1\nl2\nl3\nl4\nl5");
    assert.equal(await tool("read_file").run({ path: "f.txt", offset: 3 }, dir), "3\tl3\n4\tl4\n5\tl5");
    assert.equal(await tool("read_file").run({ path: "f.txt", offset: 2, limit: 2 }, dir), "2\tl2\n3\tl3");
  }));

test("read_file handles empty files and rejects missing ones", async () =>
  withTmp(async (dir) => {
    await writeFile(join(dir, "empty.txt"), "");
    assert.equal(await tool("read_file").run({ path: "empty.txt" }, dir), "(empty file)");
    await assert.rejects(tool("read_file").run({ path: "nope.txt" }, dir), /ENOENT/);
  }));

/* ---------------- write_file ---------------- */

test("write_file creates parent directories and writes content", async () =>
  withTmp(async (dir) => {
    const out = await tool("write_file").run({ path: "a/b/c/new.txt", content: "hello lakshx" }, dir);
    assert.match(out, /wrote 12 chars/);
    assert.equal(await readFile(join(dir, "a/b/c/new.txt"), "utf8"), "hello lakshx");
  }));

test("write_file overwrites an existing file", async () =>
  withTmp(async (dir) => {
    await writeFile(join(dir, "f.txt"), "old");
    await tool("write_file").run({ path: "f.txt", content: "new" }, dir);
    assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "new");
  }));

/* ---------------- edit_file ---------------- */

test("edit_file rejects when old_string has 0 matches", async () =>
  withTmp(async (dir) => {
    await writeFile(join(dir, "f.txt"), "one two three");
    await assert.rejects(
      tool("edit_file").run({ path: "f.txt", old_string: "missing", new_string: "x" }, dir),
      /old_string not found/,
    );
  }));

test("edit_file rejects when old_string matches more than once", async () =>
  withTmp(async (dir) => {
    await writeFile(join(dir, "f.txt"), "dup A dup B dup");
    await assert.rejects(
      tool("edit_file").run({ path: "f.txt", old_string: "dup", new_string: "x" }, dir),
      /matches 3 times.*surrounding context/,
    );
  }));

test("edit_file replaces a unique match exactly once", async () =>
  withTmp(async (dir) => {
    await writeFile(join(dir, "f.txt"), "const port = 3000;\nconst host = 'x';\n");
    const out = await tool("edit_file").run(
      { path: "f.txt", old_string: "port = 3000", new_string: "port = 8080" },
      dir,
    );
    assert.match(out, /^edited /);
    assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "const port = 8080;\nconst host = 'x';\n");
  }));

/* ---------------- list_dir ---------------- */

test("list_dir marks directories with a trailing slash, sorted", async () =>
  withTmp(async (dir) => {
    await mkdir(join(dir, "subdir"));
    await writeFile(join(dir, "zfile.txt"), "");
    await writeFile(join(dir, "afile.txt"), "");
    const out = await tool("list_dir").run({ path: "." }, dir);
    assert.equal(out, "afile.txt\nsubdir/\nzfile.txt");
  }));

test("list_dir defaults to the workspace root and reports empty dirs", async () =>
  withTmp(async (dir) => {
    assert.equal(await tool("list_dir").run({}, dir), "(empty)");
  }));

/* ---------------- grep ---------------- */

const rgPath = findRg();

test("grep returns path:line:text matches", { skip: rgPath ? false : "ripgrep not available" }, async () =>
  withTmp(async (dir) => {
    const saved = process.env.LAKSHX_RG_PATH;
    process.env.LAKSHX_RG_PATH = rgPath;
    try {
      await writeFile(join(dir, "hay.txt"), "nothing here\nthe needle_xyz sits on line two\n");
      const out = await tool("grep").run({ pattern: "needle_xyz", path: "." }, dir);
      assert.match(out, /hay\.txt:2:.*needle_xyz/);
    } finally {
      if (saved === undefined) delete process.env.LAKSHX_RG_PATH;
      else process.env.LAKSHX_RG_PATH = saved;
    }
  }));

test("grep reports (no matches) instead of throwing", { skip: rgPath ? false : "ripgrep not available" }, async () =>
  withTmp(async (dir) => {
    const saved = process.env.LAKSHX_RG_PATH;
    process.env.LAKSHX_RG_PATH = rgPath;
    try {
      await writeFile(join(dir, "hay.txt"), "just some text\n");
      const out = await tool("grep").run({ pattern: "zz_will_never_match_qq", path: "." }, dir);
      assert.equal(out, "(no matches)");
    } finally {
      if (saved === undefined) delete process.env.LAKSHX_RG_PATH;
      else process.env.LAKSHX_RG_PATH = saved;
    }
  }));

/* ---------------- bash ---------------- */

test("bash returns stdout of a successful command", async () =>
  withTmp(async (dir) => {
    const out = await tool("bash").run({ command: "echo lakshx-bash-ok" }, dir);
    assert.equal(out.trim(), "lakshx-bash-ok");
  }));

test("bash captures the exit code and output of a failing command", async () =>
  withTmp(async (dir) => {
    const out = await tool("bash").run({ command: "echo boom; exit 7" }, dir);
    assert.match(out, /^EXIT 7\n/);
    assert.match(out, /boom/);
  }));

test("bash merges stderr under a marker", async () =>
  withTmp(async (dir) => {
    const out = await tool("bash").run({ command: "echo out; echo err 1>&2" }, dir);
    assert.match(out, /out\n\n--- stderr ---\nerr/);
  }));

test("bash runs in the session cwd", async () =>
  withTmp(async (dir) => {
    const out = await tool("bash").run({ command: "pwd" }, dir);
    // macOS tmpdir is often behind a /private symlink — compare realpath-ish suffix
    assert.ok(out.trim().endsWith(dir.replace(/^\/private/, "")) || out.trim() === dir);
  }));
