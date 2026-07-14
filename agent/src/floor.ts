/**
 * Destructive-command floor — a deterministic, code-enforced hard block.
 *
 * Until this module existed, the floor described in `loop.ts`'s `modeBlock()`
 * ("no force-push, no history rewrites, no rm -rf outside the workspace, no
 * package publishes") was PROMPT TEXT ONLY: the model was asked nicely not to
 * do these things, and nothing inspected `tc.input.command`/`tc.input.path`
 * before executing a tool. A model that misreads the instruction — or is
 * prompt-injected via tool output (see `ANTI_INJECTION` in loop.ts) — had zero
 * resistance in `auto` mode.
 *
 * `floorCheck()` is that resistance. It is a pure, synchronous, no-I/O
 * function so it can run unconditionally, in every mode, before the
 * mode/permission branch in `loop.ts`'s `runPrompt()` — including `approve`
 * mode even after a human clicks "Allow", because this is a safety floor, not
 * a permission that can be granted away.
 *
 * Naming/shape matches `docs/research/09-royal-mode-autonomous.md` §3.1,
 * which designs Royal mode's safety substrate on top of this exact function
 * (`agent/src/floor.ts`, `floorCheck(name, input, cwd)`) — so this module is
 * meant to be reused, not reinvented, when Royal mode lands.
 *
 * Scope, deliberately: this covers the 5 categories the existing prompt text
 * already promises (force-push, history rewrites, rm -rf outside the
 * workspace, package publishes, plus disk-destructive commands and
 * pipe-to-shell as a prompt-injection amplifier). It does NOT implement the
 * fuller Royal-only table from doc 09 §3.1 (credential-path blocking,
 * self-tamper protection, persistence-mechanism writes, `sudo`/privilege
 * escalation, `git clean -f`, `docker push`, filesystem-scope checks on
 * write_file/edit_file) — those are Royal-mode-specific hardening that doc 09
 * explicitly scopes to a later phase, not part of today's auto-mode floor.
 *
 * Parsing approach: lightweight tokenization + regex, matching this
 * codebase's existing style (see `tools.ts`'s command handling) — NOT a full
 * shell parser. Known limitations, called out inline where relevant:
 *  - No real shell semantics: no variable expansion, no glob expansion
 *    (beyond a few hardcoded "whole workspace" patterns), no subshell
 *    evaluation, no alias resolution.
 *  - No symlink resolution (matches `tools.ts`'s `abs()`, which also doesn't
 *    call `realpath`) — a symlink that escapes the workspace can defeat the
 *    outside-workspace check.
 *  - `git rebase` is blocked broadly (any invocation), not just the
 *    history-losing subset — see the comment on `checkGitHistoryRewrite`.
 *  - Segment splitting on `|`/`&&`/`||`/`;`/newline is a heuristic, not a
 *    real shell grammar; deeply nested quoting or `$(...)`/backtick command
 *    substitution can confuse it.
 *  - `sudo`/`doas`/`env`/`VAR=val`/absolute-path (`/bin/rm`) prefixes ARE
 *    stripped/normalized before matching (see `effectiveTokens`) so they
 *    can't trivially bypass a rule — but shell aliases and backslash-escaped
 *    command names (`\rm`) are not unwrapped; that requires real shell
 *    semantics.
 *  - `cd`'ing to another directory mid-command doesn't change which `cwd`
 *    path checks resolve against — `floorCheck` always resolves relative to
 *    the tool call's `cwd` (the workspace root), not a simulated post-`cd`
 *    directory.
 * Given these, this function is deliberately biased toward catching real
 * danger even at the cost of occasional false negatives on obfuscated input,
 * while using word-boundary/exact-token matching (not naive substring search)
 * to avoid flagging benign commands like `git log --pretty=force` or a string
 * literal that happens to contain the word "force".
 */

import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";

export interface FloorResult {
  blocked: boolean;
  reason?: string;
}

const SAFE: FloorResult = { blocked: false };

function block(reason: string): FloorResult {
  return { blocked: true, reason };
}

/** Lightweight tokenizer: whitespace-split, respecting simple single/double quotes. */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Split a full command string into top-level "commands" on common shell chaining/piping operators. */
function splitSegments(command: string): string[] {
  return command.split(/\|\||&&|;|\n|\|/);
}

const INVOCATION_WRAPPERS = new Set(["sudo", "doas", "command", "nice", "time"]);

/**
 * Strip leading invocation wrappers (`sudo`, `doas`, `env`, bare `VAR=val`
 * assignment prefixes, `command`, `nice`, `time`) so e.g. `sudo rm -rf /x` or
 * `FOO=bar npm publish` are inspected as `rm -rf /x` / `npm publish` rather
 * than bailing out on `tokens[0] !== "rm"`. Without this, a one-token prefix
 * would silently neutralize every rule below — exactly the kind of thing a
 * prompt-injected payload or a misreading model would plausibly emit.
 * Known limitation: does not chase `env`'s own flags beyond skipping leading
 * `-x`-shaped tokens, and doesn't unwrap shell aliases/backslash-escapes
 * (`\rm`) — those require real shell semantics this module deliberately
 * doesn't implement (see module doc comment).
 */
function stripInvocationWrappers(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (INVOCATION_WRAPPERS.has(basename(t))) {
      i++;
      continue;
    }
    if (basename(t) === "env") {
      i++;
      while (i < tokens.length && (tokens[i].startsWith("-") || /^\w+=/.test(tokens[i]))) i++;
      continue;
    }
    if (/^\w+=/.test(t)) {
      i++; // bare VAR=val prefix before the real command
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/** Resolve the effective command tokens for a segment: wrapper-stripped, and the leading token reduced to its basename so `/bin/rm` matches `rm`. */
function effectiveTokens(segment: string): string[] {
  const stripped = stripInvocationWrappers(tokenize(segment));
  if (stripped.length === 0) return stripped;
  return [basename(stripped[0]), ...stripped.slice(1)];
}

// ---------------------------------------------------------------------------
// Rule 1: git force-push
// ---------------------------------------------------------------------------
function checkGitForcePush(tokens: string[]): FloorResult {
  if (tokens[0] !== "git" || !tokens.includes("push")) return SAFE;
  const forced = tokens.some(
    (t) => t === "--force" || t === "-f" || t === "--force-with-lease" || t.startsWith("--force-with-lease="),
  );
  if (!forced) return SAFE;
  return block(
    "force-push is never allowed, even in auto/approved mode. Push without --force, or ask the user to force-push manually if truly needed.",
  );
}

// ---------------------------------------------------------------------------
// Rule 2: history rewrites
// ---------------------------------------------------------------------------
function checkGitHistoryRewrite(tokens: string[]): FloorResult {
  if (tokens[0] !== "git") return SAFE;

  if (tokens.includes("reset") && tokens.includes("--hard")) {
    return block(
      "'git reset --hard' rewrites history and irreversibly discards commits/working-tree changes — never allowed. Use 'git reset --soft' or '--mixed', or ask the user to do this manually.",
    );
  }

  if (tokens.includes("filter-branch")) {
    return block(
      "'git filter-branch' rewrites repository history — never allowed. Ask the user to run this manually if truly needed.",
    );
  }

  if (tokens.includes("rebase")) {
    // Intentionally conservative v1 floor rule: blocks ALL `git rebase`
    // invocations, not just the interactive/history-losing subset. Detecting
    // "rebasing onto/past an already-pushed ref" requires inspecting
    // remote-tracking state, which this static, no-I/O, regex-based check
    // deliberately does not do (that's real complexity, not a regex tweak).
    // Blocking broadly means some genuinely-safe local-only rebases get
    // rejected too — an accepted false positive per the task's guidance to
    // err toward catching real danger. Refine later (e.g. allow rebase of a
    // branch with no upstream/no remote-tracking ref) if this proves too
    // broad in practice.
    return block(
      "'git rebase' is blocked broadly by the safety floor (history-rewrite risk) — this is intentionally conservative in v1 and blocks even safe local-only rebases. Use 'git merge' instead, or ask the user to rebase manually.",
    );
  }

  if (tokens.includes("push")) {
    const hasDeleteFlag = tokens.some((t) => t === "--delete" || t === "-d");
    const hasColonRefspec = tokens.some((t) => t.startsWith(":") && t.length > 1);
    if (hasDeleteFlag || hasColonRefspec) {
      return block(
        "deleting a remote ref via 'git push' (--delete/-d or a ':branch' refspec) is a history-rewrite-class action — never allowed. Ask the user to delete the remote branch manually.",
      );
    }
  }

  return SAFE;
}

// ---------------------------------------------------------------------------
// Rule 3: rm -rf (and equivalents) outside the workspace, or targeting a
// dangerous root-level path even nominally "inside" it.
// ---------------------------------------------------------------------------

/** Tokens that mean "the whole current directory" when handed to rm as a bare glob/dot. */
const WHOLE_CWD_TOKENS = new Set([".", "./", "*", "./*", "$(pwd)", '"$(pwd)"']);

/**
 * Resolve an rm/find target argument to an absolute path and decide whether
 * it's dangerous: outside the workspace, the workspace root itself, the
 * user's home directory root, or the filesystem root. Uses `node:path`
 * resolution the same way `tools.ts`'s `abs()` does (no symlink resolution —
 * see the module-level limitations comment).
 */
function checkDangerousPath(raw: string, cwd: string): FloorResult {
  const norm = raw.trim();
  if (!norm) return SAFE;
  const home = resolve(homedir());
  const cwdResolved = resolve(cwd);

  let resolved: string;
  if (WHOLE_CWD_TOKENS.has(norm)) {
    resolved = cwdResolved;
  } else if (norm === "~" || norm === "~/") {
    resolved = home;
  } else if (norm.startsWith("~/")) {
    resolved = resolve(home, norm.slice(2));
  } else {
    resolved = isAbsolute(norm) ? resolve(norm) : resolve(cwd, norm);
  }

  if (resolved === "/") {
    return block(`rm -rf targets the filesystem root ("${raw}") — never allowed.`);
  }
  if (resolved === home) {
    return block(`rm -rf targets the home directory root ("${raw}") — never allowed.`);
  }
  if (resolved === cwdResolved) {
    return block(
      `rm -rf targets the entire workspace root ("${raw}") — scope the deletion to a subdirectory instead (e.g. "./build"), or ask the user to do this manually.`,
    );
  }
  const rel = relative(cwdResolved, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return block(
      `rm -rf targets a path outside the workspace ("${raw}" → ${resolved}) — never allowed, even in auto mode.`,
    );
  }
  return SAFE;
}

function checkRmSegment(tokens: string[], cwd: string): FloorResult {
  if (tokens[0] !== "rm") return SAFE;
  const rest = tokens.slice(1);
  const flags = rest.filter((t) => t.startsWith("-") && t !== "--");
  const targets = rest.filter((t) => !t.startsWith("-"));

  let hasRecursive = false;
  let hasForce = false;
  for (const f of flags) {
    if (f.startsWith("--")) {
      if (f === "--recursive") hasRecursive = true;
      if (f === "--force") hasForce = true;
    } else {
      // combined short flags in any order: -rf, -fr, -Rf, -vrf, ...
      if (/[rR]/.test(f)) hasRecursive = true;
      if (/f/.test(f)) hasForce = true;
    }
  }
  if (!(hasRecursive && hasForce)) return SAFE; // scope: only the rm -rf class, not bare `rm -f file`
  if (targets.length === 0) return SAFE; // nothing to resolve — let it fail naturally

  for (const raw of targets) {
    const check = checkDangerousPath(raw, cwd);
    if (check.blocked) return check;
  }
  return SAFE;
}

/** Basic, best-effort coverage of `find ... -delete` used destructively (task asks at minimum for robust `rm` coverage; this is a bonus, not exhaustive). */
function checkFindDelete(tokens: string[], cwd: string): FloorResult {
  if (tokens[0] !== "find" || !tokens.includes("-delete")) return SAFE;
  const target = tokens.slice(1).find((t) => !t.startsWith("-"));
  if (!target) return SAFE;
  const check = checkDangerousPath(target, cwd);
  if (!check.blocked) return SAFE;
  return block(`find ... -delete: ${check.reason}`);
}

// ---------------------------------------------------------------------------
// Rule 4: package publishes
// ---------------------------------------------------------------------------
function checkPublishSegment(tokens: string[]): FloorResult {
  const cmd = tokens[0];
  const sub = tokens[1];
  // Match the immediate subcommand only (tokens[1]), not "includes", so e.g.
  // `npm run publish` (an arbitrary custom script named "publish") is not a
  // false positive — only the real `npm publish` / `cargo publish` / etc.
  if (["npm", "yarn", "pnpm"].includes(cmd) && sub === "publish") {
    if (tokens.includes("--dry-run")) return SAFE; // rehearsal only, does not publish
    return block(
      `'${cmd} publish' publishes a package to a registry — never allowed. Ask the user to publish manually if this release is intended.`,
    );
  }
  if (cmd === "cargo" && sub === "publish") {
    if (tokens.includes("--dry-run")) return SAFE;
    return block(
      "'cargo publish' publishes a crate to a registry — never allowed. Ask the user to publish manually if this release is intended.",
    );
  }
  if (cmd === "twine" && sub === "upload") {
    return block(
      "'twine upload' publishes a package to PyPI (or another index) — never allowed. Ask the user to publish manually if this release is intended.",
    );
  }
  if (cmd === "gem" && sub === "push") {
    return block(
      "'gem push' publishes a gem to RubyGems — never allowed. Ask the user to publish manually if this release is intended.",
    );
  }
  return SAFE;
}

// ---------------------------------------------------------------------------
// Bonus: disk-destructive commands
// ---------------------------------------------------------------------------
function checkDiskDestructive(tokens: string[]): FloorResult {
  const cmd = tokens[0];
  if (cmd && /^mkfs(\.\w+)?$/.test(cmd)) {
    return block(`'${cmd}' formats a filesystem/device — never allowed by the safety floor.`);
  }
  if (cmd === "dd") {
    const ofTok = tokens.find((t) => t.startsWith("of="));
    if (ofTok && /^of=\/dev\//.test(ofTok)) {
      return block(`dd writing directly to a device path (${ofTok}) — never allowed by the safety floor.`);
    }
  }
  if (cmd === "diskutil" && tokens[1] === "eraseDisk") {
    return block("'diskutil eraseDisk' erases an entire disk — never allowed by the safety floor.");
  }
  return SAFE;
}

// ---------------------------------------------------------------------------
// Bonus: remote-script execution piped directly to a shell (prompt-injection
// amplifier — a compromised/malicious remote script bypasses any file-level
// review entirely). Checked against the RAW command, not a split segment,
// since the pipe itself is the thing being detected.
// ---------------------------------------------------------------------------
function checkPipeToShell(command: string): FloorResult {
  const re = /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b/i;
  if (!re.test(command)) return SAFE;
  return block(
    "piping a remote download (curl/wget) directly into a shell interpreter is never allowed — a compromised or malicious remote script would execute unreviewed. Download to a file, inspect it, then run it explicitly if it's safe.",
  );
}

/**
 * The floor. Pure, synchronous, no I/O — safe to call unconditionally for
 * every tool call, in every mode, before any permission/mode branching.
 *
 * Today this only inspects the `bash` tool's `command` string (all 5 rule
 * categories are shell-invoked actions). Other tool names fall through as
 * SAFE — extend here if a future rule needs to inspect e.g. `write_file`'s
 * `path` (see the module doc comment for what's deliberately deferred).
 */
export function floorCheck(name: string, input: any, cwd: string): FloorResult {
  if (name !== "bash") return SAFE;
  const command = String(input?.command ?? "");
  if (!command.trim()) return SAFE;

  const pipeCheck = checkPipeToShell(command);
  if (pipeCheck.blocked) return pipeCheck;

  for (const seg of splitSegments(command)) {
    const tokens = effectiveTokens(seg);
    if (tokens.length === 0) continue;
    const checks = [
      checkGitForcePush(tokens),
      checkGitHistoryRewrite(tokens),
      checkRmSegment(tokens, cwd),
      checkFindDelete(tokens, cwd),
      checkPublishSegment(tokens),
      checkDiskDestructive(tokens),
    ];
    for (const c of checks) {
      if (c.blocked) return c;
    }
  }
  return SAFE;
}
