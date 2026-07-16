/**
 * Unit tests for agent/src/verify.ts (Royal Mode 2.0 Stage A): the
 * VerificationSpec type, `hashSpec`'s determinism/sensitivity, and — the
 * proof that matters most — `runVerification` actually spawning REAL child
 * processes and reporting REAL exit codes, not simulating anything.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  freezeSpec,
  hashSpec,
  parseVerificationSpecInput,
  runVerification,
  verifySpecIntegrity,
  type VerificationSpec,
} from "../src/verify.js";

test("runVerification: a real passing command (node -e process.exit(0)) actually runs and reports exit 0", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-verify-real-"));
  try {
    const spec = freezeSpec({
      mechanical: [{ cmd: `node -e "process.exit(0)"`, expect: "exitZero" }],
    });
    const result = await runVerification(spec, workspace);
    assert.equal(result.passed, true, "a real exit-0 process must report passed:true");
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].passed, true);
    assert.equal(result.results[0].exitCode, 0, "the REAL captured exit code must be 0, not simulated");
    assert.ok(result.results[0].durationMs >= 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runVerification: a real failing command (node -e process.exit(1)) actually runs and reports exit 1, not a fabricated pass", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-verify-real-fail-"));
  try {
    const spec = freezeSpec({
      mechanical: [{ cmd: `node -e "process.exit(1)"`, expect: "exitZero" }],
    });
    const result = await runVerification(spec, workspace);
    assert.equal(result.passed, false, "a real exit-1 process must NEVER report passed:true");
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].passed, false);
    assert.equal(result.results[0].exitCode, 1, "the REAL captured exit code must be 1 (execWithKillEscalation rejects on non-zero — this proves the reject path is read correctly)");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runVerification: multiple mechanical checks — mixed pass/fail reports per-check results and an overall fail", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-verify-mixed-"));
  try {
    const spec = freezeSpec({
      mechanical: [
        { cmd: `node -e "process.exit(0)"`, expect: "exitZero" },
        { cmd: `node -e "console.log('boom'); process.exit(3)"`, expect: "exitZero" },
      ],
    });
    const result = await runVerification(spec, workspace);
    assert.equal(result.passed, false, "overall must fail if ANY check fails");
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].passed, true);
    assert.equal(result.results[1].passed, false);
    assert.equal(result.results[1].exitCode, 3);
    assert.match(result.results[1].output, /boom/, "real stdout must be captured, not simulated");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runVerification: {pattern} expect matches real output regardless of exit code", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-verify-pattern-"));
  try {
    // Exits non-zero but prints text a pattern check cares about — proves
    // the {pattern} branch reads output off the REJECT path too, not only
    // the resolve path.
    const spec = freezeSpec({
      mechanical: [
        { cmd: `node -e "console.log('0 failures, 4 passed'); process.exit(1)"`, expect: { pattern: "0 failures" } },
      ],
    });
    const result = await runVerification(spec, workspace);
    assert.equal(result.results[0].exitCode, 1, "process really did exit non-zero");
    assert.equal(result.results[0].passed, true, "{pattern} must judge by output content, not exit code");
    assert.equal(result.passed, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runVerification: {pattern} that does not match real output fails, even on exit 0", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-verify-pattern-fail-"));
  try {
    const spec = freezeSpec({
      mechanical: [{ cmd: `node -e "console.log('all good'); process.exit(0)"`, expect: { pattern: "FAILURE_MARKER_XYZ" } }],
    });
    const result = await runVerification(spec, workspace);
    assert.equal(result.results[0].exitCode, 0);
    assert.equal(result.results[0].passed, false, "a non-matching pattern must fail even though the process exited 0");
    assert.equal(result.passed, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runVerification: an unknown/nonexistent command reports a real non-zero-ish failure, not a crash", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-verify-nonexistent-"));
  try {
    const spec = freezeSpec({
      mechanical: [{ cmd: "this-command-does-not-exist-anywhere-xyz123", expect: "exitZero" }],
    });
    const result = await runVerification(spec, workspace);
    assert.equal(result.passed, false);
    assert.equal(result.results[0].passed, false);
    // shell reports command-not-found via a real non-zero exit code
    assert.notEqual(result.results[0].exitCode, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("hashSpec: deterministic — the same spec content produces the same hash", () => {
  const specA: Pick<VerificationSpec, "mechanical" | "behavioral" | "visual"> = {
    mechanical: [{ cmd: "npm test", expect: "exitZero" }],
  };
  const specB: Pick<VerificationSpec, "mechanical" | "behavioral" | "visual"> = {
    mechanical: [{ cmd: "npm test", expect: "exitZero" }],
  };
  assert.equal(hashSpec(specA), hashSpec(specA), "hashing the same object twice must be stable");
  assert.equal(hashSpec(specA), hashSpec(specB), "two independently-constructed but content-equal specs must hash identically");
});

test("hashSpec: sensitive to any field change — different cmd, different expect, extra check, all change the hash", () => {
  const base = hashSpec({ mechanical: [{ cmd: "npm test", expect: "exitZero" }] });

  const differentCmd = hashSpec({ mechanical: [{ cmd: "npm run typecheck", expect: "exitZero" }] });
  assert.notEqual(base, differentCmd, "a different cmd must change the hash");

  const differentExpect = hashSpec({ mechanical: [{ cmd: "npm test", expect: { pattern: "0 failing" } }] });
  assert.notEqual(base, differentExpect, "a different expect must change the hash");

  const extraCheck = hashSpec({
    mechanical: [
      { cmd: "npm test", expect: "exitZero" },
      { cmd: "npm run typecheck", expect: "exitZero" },
    ],
  });
  assert.notEqual(base, extraCheck, "an added check must change the hash");

  const withBehavioral = hashSpec({ mechanical: [{ cmd: "npm test", expect: "exitZero" }], behavioral: [{ x: 1 }] });
  assert.notEqual(base, withBehavioral, "a populated behavioral/visual field must change the hash too");
});

test("hashSpec: key order in the input object does not affect the hash (canonical serialization)", () => {
  const a = hashSpec({ visual: [], mechanical: [{ expect: "exitZero", cmd: "npm test" }], behavioral: [] });
  const b = hashSpec({ mechanical: [{ cmd: "npm test", expect: "exitZero" }], behavioral: [], visual: [] });
  assert.equal(a, b, "canonical stringify must sort keys so property order never affects the hash");
});

test("freezeSpec + verifySpecIntegrity: a frozen spec's hash matches itself; a tampered copy does not", () => {
  const spec = freezeSpec({ mechanical: [{ cmd: "npm test", expect: "exitZero" }] });
  assert.ok(spec.frozenAt.length > 0);
  assert.equal(verifySpecIntegrity(spec), true, "a freshly frozen spec must verify against its own hash");

  // Recomputing hashSpec on the frozen spec (which now HAS a frozenAt field)
  // must ignore that field, not fold it into the hash circularly.
  assert.equal(hashSpec(spec), spec.frozenAt, "hashSpec on a full VerificationSpec must ignore its own frozenAt and reproduce the same hash");

  const tampered: VerificationSpec = { ...spec, mechanical: [{ cmd: "rm -rf /", expect: "exitZero" }] };
  assert.equal(verifySpecIntegrity(tampered), false, "swapping the checks under the same frozenAt must be detected");
});

test("parseVerificationSpecInput: rejects malformed input without throwing", () => {
  assert.equal(parseVerificationSpecInput(null).ok, false);
  assert.equal(parseVerificationSpecInput({}).ok, false);
  assert.equal(parseVerificationSpecInput({ mechanical: [] }).ok, false, "empty mechanical array must be rejected");
  assert.equal(parseVerificationSpecInput({ mechanical: [{ cmd: "" , expect: "exitZero" }] }).ok, false, "empty cmd must be rejected");
  assert.equal(parseVerificationSpecInput({ mechanical: [{ cmd: "npm test" }] }).ok, false, "missing expect must be rejected");
  assert.equal(parseVerificationSpecInput({ mechanical: [{ cmd: "npm test", expect: "bogus" }] }).ok, false, "invalid expect string must be rejected");
  assert.equal(parseVerificationSpecInput({ mechanical: [{ cmd: "npm test", expect: {} }] }).ok, false, "expect object missing pattern must be rejected");
});

test("parseVerificationSpecInput: accepts a well-formed spec and normalizes it", () => {
  const parsed = parseVerificationSpecInput({
    mechanical: [
      { cmd: "npm run typecheck", expect: "exitZero" },
      { cmd: "npm test", expect: { pattern: "0 failing" } },
    ],
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.spec.mechanical.length, 2);
    assert.equal(parsed.spec.mechanical[0].expect, "exitZero");
    assert.deepEqual(parsed.spec.mechanical[1].expect, { pattern: "0 failing" });
  }
});
