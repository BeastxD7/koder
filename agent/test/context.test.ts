import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envBlock, loadRules, scrubSecrets } from "../src/context.js";
import { clip } from "../src/tools.js";

async function withTmp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "koder-ctx-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("envBlock reports platform, date, and workspace listing", async () =>
  withTmp(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { build: "x" } }));
    await writeFile(join(dir, "a.ts"), "");
    const block = envBlock(dir);
    assert.match(block, /^<env>/);
    assert.match(block, /platform: \w+/);
    assert.match(block, /date: \d{4}-\d{2}-\d{2}/);
    assert.match(block, /workspace root:[\s\S]*a\.ts/);
    assert.match(block, /package\.json: demo, scripts: build/);
    assert.match(block, /<\/env>$/);
  }));

test("envBlock reports git branch and dirty state when inside a repo", async () =>
  withTmp(async (dir) => {
    execSync("git init -q -b main", { cwd: dir });
    execSync("git config user.email a@b.c && git config user.name a", { cwd: dir });
    await writeFile(join(dir, "f.txt"), "x");
    const block = envBlock(dir);
    assert.match(block, /git: branch=main, 1 uncommitted change/);
  }));

test("loadRules picks .koder/rules.md over AGENTS.md over CLAUDE.md", async () =>
  withTmp(async (dir) => {
    await writeFile(join(dir, "AGENTS.md"), "agents rules");
    await writeFile(join(dir, "CLAUDE.md"), "claude rules");
    let out = loadRules(dir);
    assert.match(out, /agents rules/);
    assert.doesNotMatch(out, /claude rules/);

    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".koder"));
    await writeFile(join(dir, ".koder", "rules.md"), "koder rules win");
    out = loadRules(dir);
    assert.match(out, /koder rules win/);
    assert.doesNotMatch(out, /agents rules/);
  }));

test("loadRules includes user rules from a separate HOME and labels provenance", async () =>
  withTmp(async (dir) => {
    const home = await mkdtemp(join(tmpdir(), "koder-home-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(home, ".koder"), { recursive: true });
      await writeFile(join(home, ".koder", "rules.md"), "never use npm, use pnpm");
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const out = loadRules(dir);
        assert.match(out, /User preferences/);
        assert.match(out, /never use npm, use pnpm/);
      } finally {
        process.env.HOME = prevHome;
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }));

test("loadRules returns empty string when no rule files exist", async () =>
  withTmp(async (dir) => {
    assert.equal(loadRules(dir), "");
  }));

test("scrubSecrets redacts common secret shapes", () => {
  assert.equal(scrubSecrets("key=sk-ant-abcdefghijklmnopqrstuvwxyz"), "key=[redacted]");
  assert.equal(scrubSecrets("token: ghp_abcdefghijklmnopqrstuvwxyz01"), "[redacted]");
  // AKIA + 16 alphanumeric = 20 chars total (AWS's canonical example key id)
  assert.equal(scrubSecrets("AWS AKIAIOSFODNN7EXAMPLE used here"), "AWS [redacted] used here");
  assert.match(scrubSecrets("password=hunter2"), /\[redacted\]/);
  assert.equal(scrubSecrets("nothing secret here"), "nothing secret here");
});

test("clip leaves short strings untouched and preserves head+tail on long ones", () => {
  assert.equal(clip("short", 100), "short");
  const long = "H".repeat(100) + "MIDDLE" + "T".repeat(100);
  const out = clip(long, 50, 0.6);
  assert.ok(out.startsWith("H".repeat(30)));
  assert.ok(out.endsWith("T".repeat(20)));
  assert.match(out, /chars elided/);
  assert.doesNotMatch(out, /MIDDLE/);
});
