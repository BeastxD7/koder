/**
 * Context assembly: environment block + rules-file injection + secret
 * scrubbing. Kept as plain functions the loop calls — no state beyond a
 * small mtime cache, per the "context assembly is code" design.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function tryExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

/** OS, date, git state, top-level layout — the only per-turn-volatile prompt section. */
export function envBlock(cwd: string): string {
  const lines: string[] = [];
  lines.push(`platform: ${process.platform} (node ${process.version})`);
  lines.push(`date: ${new Date().toISOString().slice(0, 10)}`);

  // rev-parse fails with exit 128 on a brand-new repo (unborn HEAD, no
  // commits yet) — branch --show-current handles that case too
  const branch = tryExec("git branch --show-current", cwd);
  if (branch) {
    const dirty = tryExec("git status --porcelain", cwd);
    const dirtyCount = dirty ? dirty.split("\n").filter(Boolean).length : 0;
    lines.push(`git: branch=${branch}${dirtyCount ? `, ${dirtyCount} uncommitted change(s)` : ", clean"}`);
  }

  try {
    const entries = readdirSync(cwd, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .slice(0, 40)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (entries.length) lines.push(`workspace root:\n  ${entries.join("\n  ")}`);
  } catch {
    /* unreadable cwd — skip */
  }

  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 12);
    lines.push(`package.json: ${pkg.name ?? "(unnamed)"}${scripts.length ? `, scripts: ${scripts.join(", ")}` : ""}`);
  } catch {
    /* no package.json — skip */
  }

  return `<env>\n${lines.join("\n")}\n</env>`;
}

interface RuleFile {
  path: string;
  mtimeMs: number;
  text: string;
}
const ruleCache = new Map<string, RuleFile>();

function readRuleFile(path: string, cap: number): string | null {
  if (!existsSync(path)) return null;
  const mtimeMs = statSync(path).mtimeMs;
  const cached = ruleCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.text;
  let text = readFileSync(path, "utf8");
  if (text.length > cap) {
    text = text.slice(0, cap) + `\n…[truncated at ${cap.toLocaleString()} chars]…`;
  }
  ruleCache.set(path, { path, mtimeMs, text });
  return text;
}

const PROJECT_RULE_CANDIDATES = [".koder/rules.md", "AGENTS.md", "CLAUDE.md"];
const PROJECT_RULE_CAP = 24_000;
const USER_RULE_CAP = 8_000;

/** Project rules (first match wins) + global user rules, delimited with provenance. */
export function loadRules(cwd: string): string {
  const blocks: string[] = [];

  for (const rel of PROJECT_RULE_CANDIDATES) {
    const text = readRuleFile(join(cwd, rel), PROJECT_RULE_CAP);
    if (text) {
      blocks.push(
        `## Project instructions\nLoaded from ${rel} in the workspace. Trusted configuration from the user/team — follow it unless it conflicts with the current mode's restrictions.\n<project-rules>\n${text}\n</project-rules>`,
      );
      break; // first existing file wins, per design
    }
  }

  const userText = readRuleFile(join(homedir(), ".koder", "rules.md"), USER_RULE_CAP);
  if (userText) {
    blocks.push(`## User preferences\n<user-rules>\n${userText}\n</user-rules>`);
  }

  return blocks.join("\n\n");
}

/** Deny patterns for secrets that must never be persisted or echoed into memory/summaries. */
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi,
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}
