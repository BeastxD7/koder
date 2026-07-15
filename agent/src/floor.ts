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
 * `review`/`approve`/`auto` all call `floorCheck()` — this is what keeps Auto
 * "locked." `royal` mode is the one exception: it does NOT call
 * `floorCheck()` at all (see `loop.ts`'s `runPrompt()`), by explicit design —
 * see `docs/research/09-royal-mode-autonomous.md`'s reversed thesis (Royal is
 * dangerous, not Auto). Royal instead calls the separate, much narrower
 * `royalTamperCheck()` below, which protects only the passive safety net's
 * own storage (audit log, checkpoints) — not a restriction on the user's
 * project, just what keeps that net honest.
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
 * Cross-platform: Koder ships for macOS, Windows, and Linux (see
 * `.github/workflows/build.yml`'s 4-platform matrix), and `tools.ts`'s
 * `resolveShell()` falls back to the platform default shell (cmd.exe) on
 * win32 — so the recursive-delete and pipe-to-shell rules also recognize
 * cmd.exe's slash-flag syntax (`rmdir /s`, `del /s`) and PowerShell's
 * dash-flag aliases for the same POSIX command names (`rm`/`del`/`rd`/
 * `rmdir`/`erase`/`ri` are all built-in PowerShell aliases for
 * `Remove-Item`, and `iwr ... | iex` is PowerShell's `curl ... | sh`) —
 * see `checkRecursiveDeleteSegment`/`checkPipeToShell`. `checkDiskDestructive`
 * covers `format`/`diskpart` alongside `mkfs`/`dd`/`diskutil eraseDisk`.
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
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

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
 * Resolve an rm/find/Windows-delete target argument to an absolute path and
 * decide whether it's dangerous: outside the workspace, the workspace root
 * itself, the user's home directory root, or the filesystem root. Uses
 * `node:path` resolution the same way `tools.ts`'s `abs()` does (no symlink
 * resolution — see the module-level limitations comment). `node:path` itself
 * is platform-aware (win32 semantics when actually running on Windows), so
 * this same logic correctly resolves `C:\...`-style absolute paths without
 * any extra branching — it only needs to run on the OS it's protecting.
 * `verb` labels the reason message with whatever command triggered the
 * check (`"rm -rf"`, `"rmdir /s"`, `"find -delete"`, ...) so the message
 * reads naturally regardless of caller.
 */
function checkDangerousPath(raw: string, cwd: string, verb = "rm -rf"): FloorResult {
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
    return block(`${verb} targets the filesystem root ("${raw}") — never allowed.`);
  }
  if (resolved === home) {
    return block(`${verb} targets the home directory root ("${raw}") — never allowed.`);
  }
  if (resolved === cwdResolved) {
    return block(
      `${verb} targets the entire workspace root ("${raw}") — scope the deletion to a subdirectory instead (e.g. "./build"), or ask the user to do this manually.`,
    );
  }
  const rel = relative(cwdResolved, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return block(
      `${verb} targets a path outside the workspace ("${raw}" → ${resolved}) — never allowed, even in auto mode.`,
    );
  }
  return SAFE;
}

/**
 * Command names that mean "delete a file/directory tree", across POSIX
 * shells, cmd.exe, and PowerShell. PowerShell ships `rm`/`del`/`erase`/`rd`/
 * `rmdir`/`ri` as BUILT-IN ALIASES for `Remove-Item` — the same words this
 * check already needed for `rm` mean something different, with different
 * flag syntax, depending on which shell is actually interpreting them,
 * which a static string check can't know for certain. So every name here is
 * checked against BOTH flag styles below (POSIX/PowerShell dash flags AND
 * cmd.exe's slash flags) rather than trying to guess the shell — a false
 * positive from checking both styles is an accepted cost, per this module's
 * stated bias toward catching real danger over precision. Without this,
 * `tools.ts`'s `resolveShell()` falling back to cmd.exe on win32 meant the
 * floor was blind to `rmdir /s`/`del /s`/PowerShell's `Remove-Item -Recurse
 * -Force` entirely — a real gap, not a hypothetical one, for a project that
 * explicitly targets Windows alongside macOS/Linux.
 */
const RECURSIVE_DELETE_COMMANDS = new Set(["rm", "rmdir", "rd", "del", "erase", "ri", "remove-item"]);

/**
 * A cmd.exe-style slash flag: a SHORT `/letter` token (`/s`, `/q`, `/f`,
 * `/y`, ...), never a whole target path. Deliberately narrow (anchored,
 * 1-2 letters) so an absolute POSIX path like `/tmp/foo` — which also
 * "starts with /" — is never misclassified as a flag and dropped from the
 * target list; only something flag-shaped is excluded.
 */
const WINDOWS_SLASH_FLAG = /^\/[a-z]{1,2}$/i;

function checkRecursiveDeleteSegment(tokens: string[], cwd: string): FloorResult {
  const cmd = tokens[0]?.toLowerCase();
  if (!cmd || !RECURSIVE_DELETE_COMMANDS.has(cmd)) return SAFE;
  const rest = tokens.slice(1);

  // cmd.exe slash-style flags (/s recurse, /q quiet, /f force-delete
  // read-only files). /s alone is treated as sufficient — matching rm -rf's
  // severity — since a non-interactive `rmdir /s`/`del /s` already deletes
  // the whole tree without per-file confirmation prompts.
  if (rest.some((t) => /^\/s$/i.test(t))) {
    const targets = rest.filter((t) => !WINDOWS_SLASH_FLAG.test(t));
    for (const raw of targets) {
      const check = checkDangerousPath(raw, cwd, `${tokens[0]} /s`);
      if (check.blocked) return check;
    }
  }

  // POSIX dash flags (-rf/--recursive --force) or PowerShell single-dash
  // words (-Recurse/-Force/-r/-f, case-insensitive — PowerShell flag
  // matching is case-insensitive). Lowercasing before comparison also fixes
  // a pre-existing bug: the old check for "-Force" required a literal
  // lowercase "f", which "-Force" (capital F) never contained, so a
  // PowerShell-flavored `rm -Recurse -Force` on tokens[0]==="rm" silently
  // never counted as force even though it obviously is.
  const dashFlags = rest.filter((t) => t.startsWith("-") && t !== "--");
  let hasDashRecursive = false;
  let hasDashForce = false;
  for (const f of dashFlags) {
    const isLong = f.startsWith("--");
    const body = (isLong ? f.slice(2) : f.slice(1)).toLowerCase();
    if (isLong || body.length > 3) {
      // `--recursive`/`--force`, or a single-dash PowerShell WORD
      // (`-Recurse`/`-Force`) — exact match only, never substring. Body
      // length > 3 is the signal it's a word, not a combined short-flag
      // cluster: real combined clusters top out around 3-4 letters
      // (`-vrf`), while `force` (5) and `recurse` (7) are both longer than
      // that AND both happen to contain the other's trigger letter
      // (`force` contains "r", `recurse` contains... well it doesn't
      // contain "f", but the asymmetry isn't something to rely on) — a
      // substring check here would make a bare `-Force` also count as
      // recursive, which is exactly the false positive this branch exists
      // to avoid.
      if (body === "recursive" || body === "recurse") hasDashRecursive = true;
      if (body === "force") hasDashForce = true;
    } else {
      // combined POSIX short flags (-r, -f, -rf, -fr, -vrf, ...) — each
      // character is an independent single-letter flag, so substring
      // containment is correct here (unlike the word case above).
      if (body.includes("r")) hasDashRecursive = true;
      if (body.includes("f")) hasDashForce = true;
    }
  }
  if (hasDashRecursive && hasDashForce) {
    const targets = rest.filter((t) => !t.startsWith("-") && !WINDOWS_SLASH_FLAG.test(t));
    for (const raw of targets) {
      const check = checkDangerousPath(raw, cwd);
      if (check.blocked) return check;
    }
  }

  return SAFE;
}

/** Basic, best-effort coverage of `find ... -delete` used destructively (task asks at minimum for robust `rm` coverage; this is a bonus, not exhaustive). */
function checkFindDelete(tokens: string[], cwd: string): FloorResult {
  if (tokens[0] !== "find" || !tokens.includes("-delete")) return SAFE;
  const target = tokens.slice(1).find((t) => !t.startsWith("-"));
  if (!target) return SAFE;
  return checkDangerousPath(target, cwd, "find -delete");
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
  const cmdLower = cmd?.toLowerCase();
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
  // Windows equivalents: `format` (formats a volume) and `diskpart`
  // (scriptable partitioning/erasing) are the same danger class as
  // mkfs/diskutil above — blocked outright, no target-resolution needed,
  // matching mkfs's bare-command blocking.
  if (cmdLower === "format") {
    return block("'format' formats a filesystem/volume — never allowed by the safety floor.");
  }
  if (cmdLower === "diskpart") {
    return block(
      "'diskpart' can partition or erase disks — never allowed by the safety floor. Ask the user to run this manually if truly needed.",
    );
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
  // `iwr`/`Invoke-WebRequest` are PowerShell's fetch (and `curl`/`wget`
  // themselves are built-in PowerShell aliases for it too); `iex`/
  // `Invoke-Expression` is PowerShell's "run this string as code" sink —
  // `curl https://... | iex` is the exact PowerShell-world equivalent of
  // `curl https://... | sh`, and was entirely unmatched before.
  const re = /\b(curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|iex|invoke-expression)\b/i;
  if (!re.test(command)) return SAFE;
  return block(
    "piping a remote download directly into a shell/expression interpreter is never allowed — a compromised or malicious remote script would execute unreviewed. Download to a file, inspect it, then run it explicitly if it's safe.",
  );
}

// ---------------------------------------------------------------------------
// Rule 5: write_file/edit_file targeting a path outside the workspace — the
// write-side counterpart of rule 3's rm -rf-outside-workspace check.
//
// Before this rule existed, `write_file`/`edit_file` had NO path-scoping
// check anywhere: `floorCheck()` only ever inspected the `bash` tool (see
// its doc comment below, which literally anticipated this gap), and
// `tools.ts`'s own `abs(cwd, p)` helper is a plain resolve — it does not
// reject an absolute or `../`-escaping path. So Auto mode — the one mode
// whose entire premise is "the floor keeps this locked," which also skips
// the permission prompt for dangerous tools entirely — could silently
// create or overwrite a file ANYWHERE on disk the process can reach (an SSH
// key, a shell rc file, an unrelated project) with zero warning and zero
// block. This closes that gap the same way rule 3 already closes it for
// `rm -rf`. Reuses `checkDangerousPath` as-is: its "outside the workspace"
// branch is the one that matters here; the filesystem-root/home-root/
// workspace-root special cases are harmless no-ops for a file path (they'd
// fail naturally with EISDIR if ever hit).
//
// Royal mode is unaffected — `floorCheck()` isn't called there at all, by
// design (see the module doc comment and `loop.ts`'s `runPrompt()`).
// ---------------------------------------------------------------------------
function checkFileOutsideWorkspace(name: string, input: any, cwd: string): FloorResult {
  if (name !== "write_file" && name !== "edit_file") return SAFE;
  const path = String(input?.path ?? "").trim();
  if (!path) return SAFE;
  return checkDangerousPath(path, cwd, name);
}

/**
 * The floor. Pure, synchronous, no I/O — safe to call unconditionally for
 * every tool call, in every mode, before any permission/mode branching.
 *
 * `write_file`/`edit_file` get their own dedicated path check (rule 5,
 * above); every other rule category inspects the `bash` tool's `command`
 * string. Any other tool name falls through as SAFE.
 */
export function floorCheck(name: string, input: any, cwd: string): FloorResult {
  if (name === "write_file" || name === "edit_file") {
    return checkFileOutsideWorkspace(name, input, cwd);
  }
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
      checkRecursiveDeleteSegment(tokens, cwd),
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

// ---------------------------------------------------------------------------
// Royal mode's ONE narrow exception — self-tamper protection on the passive
// safety net's own storage, not `floorCheck()`.
//
// Royal mode deliberately does NOT call `floorCheck()` at all (see
// `loop.ts`'s `runPrompt()`) — that is the entire point of the mode per
// `docs/research/09-royal-mode-autonomous.md`'s reversed thesis: Auto is
// locked (floorCheck fully enforced, unconditional), Royal is dangerous by
// design (floorCheck bypassed entirely, full machine access, zero
// pre-execution blocking, zero permission prompts).
//
// What Royal keeps is a *passive* net: an audit log (`audit.ts`) and
// pre-mutation checkpoints (`checkpoint.ts`), so a human always has a record
// and an undo path after the fact even though nothing was blocked in the
// moment. That net is worthless if Royal can erase it — a log you can erase
// isn't a log. So this one check exists, separate from `floorCheck()`,
// covering only the two directories the net itself writes to
// (`~/.koder/royal-audit/`, `~/.koder/checkpoints/`). It is not a
// restriction on what Royal can do to the user's project (it can still
// force-push, rm -rf anywhere in or outside the workspace, rewrite history,
// publish packages — none of that touches these paths) — it's what makes
// the passive net trustworthy enough to be worth keeping at all.
//
// Deliberately simple, matching this module's existing style: a substring/
// path-resolution check, not a shell parser. Known limitation: `bash`
// detection is a substring match against the guarded roots, so an obfuscated
// path (env var expansion, `cd` + relative reference, a symlink) can evade
// it — same class of limitation the rest of this module already documents
// and accepts. This is a last-line backstop against an incidental or
// instructed-but-not-obfuscated tamper attempt, not a sandbox boundary.
// ---------------------------------------------------------------------------

function guardedRoyalRoots(): string[] {
  return [join(homedir(), ".koder", "royal-audit"), join(homedir(), ".koder", "checkpoints")];
}

function underGuardedRoot(p: string): string | undefined {
  const resolved = resolve(p);
  return guardedRoyalRoots().find((root) => resolved === root || resolved.startsWith(root + sep));
}

export function royalTamperCheck(name: string, input: any): FloorResult {
  if (name === "write_file" || name === "edit_file") {
    const path = String(input?.path ?? "");
    if (!path) return SAFE;
    const hit = underGuardedRoot(path);
    if (hit) {
      return block(
        `Royal's own safety-net storage (${hit}) cannot be written to or modified, even in royal mode — a log you can erase isn't a log.`,
      );
    }
    return SAFE;
  }
  if (name === "bash") {
    const command = String(input?.command ?? "");
    if (!command.trim()) return SAFE;
    for (const root of guardedRoyalRoots()) {
      if (command.includes(root)) {
        return block(
          `Royal's own safety-net storage (${root}) cannot be touched by a command, even in royal mode — a log you can erase isn't a log.`,
        );
      }
    }
    return SAFE;
  }
  return SAFE;
}
