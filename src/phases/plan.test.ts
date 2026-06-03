/**
 * Plan phase — unit tests for the verdict routing (#75).
 *
 * `runPhaseSession` is module-mocked so no tmux session is spawned; the plan
 * file is a real temp file in the noop run dir, written per-test, so the
 * read-back-and-thread behaviour is exercised end to end.
 */
import { mock, describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { HandlerError } from "../pipeline/errors";
import { RunArtifacts } from "../run-artifacts";
import type { RunArtifactsShape } from "../run-artifacts";
import type { State } from "../pipeline/state";

// Capture the real module before mocking it. Bun's `mock.module` is global and
// `mock.restore()` does NOT undo it, so the afterAll below re-mocks it back to
// the captured original to keep this mock from leaking into later test files.
import * as realPhase from "../session/phase";
const capturedPhase = { ...realPhase };

let _sessionEffect: Effect.Effect<"PLAN_DONE" | "BLOCKER_SUSPECTED", any, any> =
  Effect.succeed("PLAN_DONE" as const);

mock.module("../session/phase", () => ({
  runPhaseSession: () => _sessionEffect,
}));

afterAll(() => {
  mock.module("../session/phase", () => capturedPhase);
});

// Import AFTER the mock is registered (Bun hoists mock.module above static imports).
import { planPhase } from "./plan";

const RUN_DIR = "/tmp/test-plan-run-dir";
const noopRunArtifacts: RunArtifactsShape = {
  dir: RUN_DIR,
  runId: "test-plan-run-dir",
  logPath: `${RUN_DIR}/run.jsonl`,
  sentinelPath: () => `${RUN_DIR}/sentinel.flag`,
  tmuxLogPath: () => `${RUN_DIR}/tmux.log`,
  promptFilePath: () => `${RUN_DIR}/prompt.md`,
  findingsPath: () => `${RUN_DIR}/findings.json`,
  triagePath: () => `${RUN_DIR}/triage.json`,
  sessionName: () => "test-session",
  logEvent: () => Effect.void,
};
const TestRunArtifacts: Layer.Layer<RunArtifacts> = Layer.succeed(RunArtifacts, noopRunArtifacts);

const planState: Extract<State, { kind: "plan" }> = {
  kind: "plan",
  issue: { iid: 42, title: "Test issue", body: "body" },
  branch: "afk/issue-42-test",
  worktree: "/wt/42",
};

const planFile = join(RUN_DIR, "plan-42.md");

const run = (effect: Effect.Effect<State, HandlerError, RunArtifacts>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestRunArtifacts)));

const runFlip = (effect: Effect.Effect<State, HandlerError, RunArtifacts>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestRunArtifacts), Effect.flip));

describe("planPhase", () => {
  beforeEach(() => {
    _sessionEffect = Effect.succeed("PLAN_DONE" as const);
    rmSync(planFile, { force: true });
  });
  afterEach(() => rmSync(planFile, { force: true }));

  it("PLAN_DONE → implementation carrying the approved plan the session wrote", async () => {
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(planFile, "Approach: reuse runPhaseSession; mirror implementation.\n");
    _sessionEffect = Effect.succeed("PLAN_DONE" as const);
    const next = await run(planPhase(planState));
    expect(next.kind).toBe("implementation");
    if (next.kind === "implementation") {
      expect(next.branch).toBe(planState.branch);
      expect(next.worktree).toBe(planState.worktree);
      expect(next.plan).toBe("Approach: reuse runPhaseSession; mirror implementation.");
    }
  });

  it("PLAN_DONE with no plan file → implementation with a visible fallback", async () => {
    _sessionEffect = Effect.succeed("PLAN_DONE" as const);
    const next = await run(planPhase(planState));
    expect(next.kind).toBe("implementation");
    if (next.kind === "implementation") {
      expect(next.plan).toContain("no plan file");
    }
  });

  it("BLOCKER_SUSPECTED → failed via the failure fate", async () => {
    _sessionEffect = Effect.succeed("BLOCKER_SUSPECTED" as const);
    const error = await runFlip(planPhase(planState));
    expect(error).toBeInstanceOf(HandlerError);
    expect(error.fate).toBe("failure");
    expect(error.reason).toContain("approve");
  });
});
