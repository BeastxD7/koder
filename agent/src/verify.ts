/**
 * Royal Mode 2.0 — Stage A: VerificationSpec + a real verifier + the
 * primitive that a harness-enforced completion gate (`declare_done`, loop.ts)
 * is built on.
 *
 * Design source: `docs/research/12-royal-mode-2-agentic-architecture.md`,
 * the VERIFY phase and "External validation" section specifically. That
 * section confirms this is a DELIBERATE choice, not incidental rigor:
 * Anthropic's own `/goal` feature (Claude Code v2.1.139) judges completion
 * from a smaller model reading the TRANSCRIPT ONLY — it never runs a
 * command, so a worker that fabricates "tests passed" in its own output text
 * can, in principle, fool the grader. This module's `runVerification` is
 * what makes this codebase's design strictly more rigorous than that: it
 * ACTUALLY EXECUTES the checks server-side, in the harness, every time
 * `declare_done` is called — never trusting the model's own report of what
 * happened. Do not weaken this toward transcript-only/simulated judging for
 * simplicity; that would throw away the exact property the design doc calls
 * out as the differentiator.
 *
 * Stage A scope, precisely:
 *  - REAL: the `mechanical` tier (`{cmd, expect}` — build/test/lint/typecheck
 *    commands) — `runVerification` spawns each command for real via
 *    `execWithKillEscalation` (tools.ts, reused rather than reinvented) and
 *    reports the REAL exit code / output.
 *  - STUBBED (Stage B or later, per doc 12's VERIFY tier list): `behavioral`
 *    (interactive browser-driven checks — needs Stage 1a's `browser_act`
 *    verbs) and `visual` (screenshot + fresh-context critic subagent rubric).
 *    Both fields exist on `VerificationSpec` so the shape already matches the
 *    3-tier design and Stage B won't need a breaking type change, but
 *    `runVerification` never reads either field — see its own doc comment.
 *  - Also NOT built here (explicitly Stage B/orchestration territory per the
 *    task this module was written for): the full PLAN-phase artifact system,
 *    the EXECUTE-phase `amend_verification_spec` tamper-watch tool/UI, and
 *    the phase machine itself. `hashSpec`/`verifySpecIntegrity` below are the
 *    real, correct primitives Stage B's tamper watch will be built on top of
 *    — this Stage only makes the hash function itself trustworthy.
 */
import { createHash } from "node:crypto";
import { clip, execWithKillEscalation, SHELL } from "./tools.js";

/** One mechanical check: run `cmd` for real, then judge it by exit code OR an output pattern. */
export interface MechanicalCheck {
  cmd: string;
  expect: "exitZero" | { pattern: string };
}

/**
 * Stage-B placeholder shapes — deliberately loose (`unknown`), not designed
 * yet. Doc 12's behavioral tier needs Stage 1a's `browser_act` verbs
 * (navigate/click/type/assert selectors/console allowlist) and the visual
 * tier needs a fresh-context critic subagent + rubric, neither of which this
 * Stage builds. Declaring the fields now means `VerificationSpec` won't need
 * a breaking shape change when Stage B adds real execution for them.
 */
export type BehavioralCheckStub = unknown;
export type VisualCheckStub = unknown;

/**
 * A VerificationSpec "frozen at plan time" (doc 12 PLAN phase artifact #3).
 * `frozenAt` is a content hash of `{mechanical, behavioral, visual}` — see
 * `hashSpec` — always computed by the HARNESS (`freezeSpec`), never trusted
 * from the model. That is what "frozen" means operationally: recomputing the
 * hash and comparing it to `frozenAt` (`verifySpecIntegrity`) detects any
 * later attempt to run a DIFFERENT spec under the same "frozen" commitment.
 * Stage B wires this into the actual EXECUTE-phase tamper-watch enforcement
 * (`amend_verification_spec` per doc 12 §"Phase enforcement mechanics") —
 * this Stage does not build that UI/enforcement, only the correct primitive.
 */
export interface VerificationSpec {
  mechanical: MechanicalCheck[];
  /** Stage B tier. Never read by `runVerification` in this Stage. */
  behavioral?: BehavioralCheckStub[];
  /** Stage B tier. Never read by `runVerification` in this Stage. */
  visual?: VisualCheckStub[];
  /** sha256 hex digest of `{mechanical, behavioral, visual}` — set by `hashSpec`/`freezeSpec`, never model-supplied. */
  frozenAt: string;
}

export interface MechanicalCheckResult {
  cmd: string;
  passed: boolean;
  /** `null` when the process never produced a normal exit code (e.g. cancelled before running). */
  exitCode: number | null;
  /** Clipped stdout+stderr — same head+tail `clip()` convention tools.ts's `bash` tool output uses, so the verdict text at the tail (FAIL, TSxxxx, stack traces) survives truncation. */
  output: string;
  durationMs: number;
}

export interface VerificationResult {
  passed: boolean;
  results: MechanicalCheckResult[];
}

/** Per-check timeout — matches the `bash` tool's own default (tools.ts). Not yet per-check configurable; the VerificationSpec shape this Stage was asked to build deliberately keeps `{cmd, expect}` minimal. */
const CHECK_TIMEOUT_MS = 120_000;
/** Matches tools.ts's `bash` tool maxBuffer. */
const CHECK_MAX_BUFFER = 4 * 1024 * 1024;
/** Matches tools.ts's `bash` tool output clip length. */
const OUTPUT_CLIP = 60_000;

/**
 * Canonical (sorted-key) JSON stringify. The same VALUE always produces the
 * same STRING regardless of key insertion order or object identity — this is
 * what makes `hashSpec` deterministic across two independently-constructed
 * but content-equal specs (e.g. `{mechanical, behavioral}` vs
 * `{behavioral, mechanical}` key order), and sensitive to any real content
 * change (a different `cmd`, a different `expect`, an added check).
 */
function canonicalStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}

/**
 * Content hash of a spec's CHECKS only — `mechanical`/`behavioral`/`visual`.
 * Deliberately excludes `frozenAt` itself from the hashed input: hashing a
 * field that STORES the hash would be circular (recompute-to-verify would
 * never match). Callers may pass either a full `VerificationSpec` (its own
 * `frozenAt`, if present, is ignored — only these three fields are read) or
 * the bare `{mechanical, behavioral?, visual?}` shape before one has been
 * assigned. This IS "frozen at plan time" made concrete: hash once when a
 * plan is approved, and any later re-run under the same commitment that
 * produces a different hash proves the spec was swapped or weakened.
 */
export function hashSpec(spec: {
  mechanical: MechanicalCheck[];
  behavioral?: BehavioralCheckStub[];
  visual?: VisualCheckStub[];
}): string {
  const canonical = canonicalStringify({
    mechanical: spec.mechanical,
    behavioral: spec.behavioral ?? [],
    visual: spec.visual ?? [],
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Freeze a spec: compute its content hash and attach it as `frozenAt`. The
 * harness always calls this (`set_verification_spec`'s loop.ts handler) — a
 * model-supplied `frozenAt` is never trusted; there is no path in this
 * codebase where the model can set that field directly.
 */
export function freezeSpec(input: {
  mechanical: MechanicalCheck[];
  behavioral?: BehavioralCheckStub[];
  visual?: VisualCheckStub[];
}): VerificationSpec {
  return { mechanical: input.mechanical, behavioral: input.behavioral, visual: input.visual, frozenAt: hashSpec(input) };
}

/**
 * True if a spec's content still matches its own recorded hash. Unused
 * elsewhere in Stage A (there is no amend/edit path yet for a frozen spec to
 * drift from) — provided now because Stage B's EXECUTE-phase tamper watch
 * (doc 12 §"Phase enforcement mechanics") will call this before allowing any
 * edit near the frozen spec through.
 */
export function verifySpecIntegrity(spec: VerificationSpec): boolean {
  return hashSpec(spec) === spec.frozenAt;
}

/**
 * Runtime validation of a `set_verification_spec` tool call's raw input.
 * The model's own claim about the shape is never trusted — this throws
 * nothing; it returns a discriminated result so the loop.ts handler can turn
 * a malformed spec into a clean tool-error instead of crashing the turn.
 */
export function parseVerificationSpecInput(input: any):
  | { ok: true; spec: { mechanical: MechanicalCheck[]; behavioral?: BehavioralCheckStub[]; visual?: VisualCheckStub[] } }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "expected an object" };
  if (!Array.isArray(input.mechanical) || input.mechanical.length === 0) {
    return { ok: false, error: `"mechanical" must be a non-empty array of {cmd, expect} checks` };
  }
  const mechanical: MechanicalCheck[] = [];
  for (let i = 0; i < input.mechanical.length; i++) {
    const item = input.mechanical[i];
    if (!item || typeof item !== "object" || typeof item.cmd !== "string" || !item.cmd.trim()) {
      return { ok: false, error: `mechanical[${i}]: "cmd" must be a non-empty string` };
    }
    const expect = item.expect;
    const isExitZero = expect === "exitZero";
    const isPattern = !!expect && typeof expect === "object" && typeof expect.pattern === "string";
    if (!isExitZero && !isPattern) {
      return { ok: false, error: `mechanical[${i}]: "expect" must be "exitZero" or {"pattern": "<regex>"}` };
    }
    mechanical.push({ cmd: item.cmd, expect: isExitZero ? "exitZero" : { pattern: (expect as { pattern: string }).pattern } });
  }
  return { ok: true, spec: { mechanical, behavioral: input.behavioral, visual: input.visual } };
}

/**
 * Run ONE mechanical check for real via `execWithKillEscalation` (tools.ts)
 * — the exact spawn/timeout/SIGTERM-then-SIGKILL machinery the `bash` tool
 * already uses, reused rather than reinvented.
 *
 * `execWithKillEscalation` RESOLVES only on exit code 0 and REJECTS
 * otherwise (matching Node's own `exec` semantics, see tools.ts) — so both
 * paths are handled here: the resolve path gives `exitCode: 0`, and the
 * reject path pulls the real exit code and captured stdout/stderr off the
 * rejected error (tools.ts attaches both there for exactly this reason).
 * This matters for two cases: an `exitZero` check that legitimately fails
 * (needs the real non-zero code), and a `{pattern}` check (needs the output
 * regardless of which path produced it — a pattern match must work whether
 * the command exited 0 or not).
 */
async function runOneCheck(check: MechanicalCheck, cwd: string, signal?: AbortSignal): Promise<MechanicalCheckResult> {
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null;
  try {
    const res = await execWithKillEscalation(check.cmd, {
      cwd,
      signal,
      timeoutMs: CHECK_TIMEOUT_MS,
      maxBuffer: CHECK_MAX_BUFFER,
      shell: SHELL,
    });
    stdout = res.stdout;
    stderr = res.stderr;
    exitCode = 0;
  } catch (err: any) {
    stdout = err?.stdout ?? "";
    stderr = err?.stderr ?? "";
    exitCode = typeof err?.code === "number" ? err.code : null;
  }
  const output = clip([stdout, stderr].filter(Boolean).join("\n--- stderr ---\n"), OUTPUT_CLIP);
  const passed = check.expect === "exitZero" ? exitCode === 0 : new RegExp(check.expect.pattern, "m").test(output);
  return { cmd: check.cmd, passed, exitCode, output, durationMs: Date.now() - startedAt };
}

/**
 * ACTUALLY EXECUTES every `spec.mechanical` check's `cmd` as a real child
 * process and reports structured, real pass/fail per check — this is the
 * function `declare_done`'s loop.ts handler calls, and it is the entire
 * reason that handler can refuse to accept the model's own claim: nothing
 * about "done" is true until THIS runs and reports back a real result. See
 * this module's own doc comment (and docs/research/12's "External
 * validation" section) for why that distinction — real re-run vs.
 * transcript-only judging — is load-bearing and must not be simplified away.
 *
 * Stage A scope: only `spec.mechanical` is executed. `spec.behavioral`/
 * `spec.visual` are read by NOTHING in this function — see the module doc
 * for exactly what Stage B still needs to build for those two tiers.
 *
 * Checks run sequentially (not `Promise.all`) — deliberately: mechanical
 * checks are typically build/test commands that share the same working
 * tree and often can't safely run concurrently (a `build` racing a `test`
 * against half-built output), and this keeps output attribution simple to
 * read in `declare_done`'s report. `passed` is vacuously `false` (not
 * `true`) for an empty check list — defense in depth; `parseVerificationSpecInput`
 * already refuses to accept an empty `mechanical` array in the first place.
 */
export async function runVerification(
  spec: VerificationSpec,
  cwd: string,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const results: MechanicalCheckResult[] = [];
  for (const check of spec.mechanical) {
    if (signal?.aborted) {
      results.push({ cmd: check.cmd, passed: false, exitCode: null, output: "(cancelled before this check ran)", durationMs: 0 });
      continue;
    }
    results.push(await runOneCheck(check, cwd, signal));
  }
  return { passed: results.length > 0 && results.every((r) => r.passed), results };
}
