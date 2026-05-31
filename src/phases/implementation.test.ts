/**
 * Implementation phase — unit tests for the timeout-salvage logic (#51).
 *
 * `runPhaseSession` and `runShellGit` are module-mocked so no tmux or git
 * process is spawned. Control variables are set per-test.
 */
import { mock, describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Effect, Layer } from "effect";
import { SessionTimedOut } from "../session/errors";
import { HandlerError } from "../pipeline/errors";
import { RunArtifacts } from "../run-artifacts";
import type { RunArtifactsShape } from "../run-artifacts";
import type { State } from "../pipeline/state";

// Capture the real modules before mocking them. Bun's `mock.module` is global
// and `mock.restore()` does NOT undo it, so without an explicit restore these
// mocks leak into every test file that runs later and imports `../shell` or
// `../session/phase` (e.g. rebase-branch and phase-primitives). The afterAll
// below re-mocks them back to the captured originals.
import * as realPhase from "../session/phase";
import * as realShell from "../shell";
const capturedPhase = { ...realPhase };
const capturedShell = { ...realShell };

// --- module-level mock state (mutated per test) ---
let _sessionEffect: Effect.Effect<"READY_FOR_REVIEW" | "BLOCKER_SUSPECTED", any, any> =
  Effect.succeed("READY_FOR_REVIEW" as const);
let _revListStdout = "0";

mock.module("../session/phase", () => ({
  runPhaseSession: () => _sessionEffect,
}));

mock.module("../shell", () => ({
  runShellGit: () => Effect.succeed({ stdout: _revListStdout, stderr: "" }),
}));

afterAll(() => {
  mock.module("../session/phase", () => capturedPhase);
  mock.module("../shell", () => capturedShell);
});

// Import AFTER mocks are registered (Bun hoists mock.module above static imports)
import { implementationPhase } from "./implementation";

// --- shared fixtures ---
const noopRunArtifacts: RunArtifactsShape = {
  dir: "/tmp/test-run-dir",
  runId: "test-run-dir",
  logPath: "/tmp/test-run-dir/run.jsonl",
  sentinelPath: () => "/tmp/test-run-dir/sentinel.flag",
  tmuxLogPath: () => "/tmp/test-run-dir/tmux.log",
  promptFilePath: () => "/tmp/test-run-dir/prompt.md",
  findingsPath: () => "/tmp/test-run-dir/findings.json",
  triagePath: () => "/tmp/test-run-dir/triage.json",
  sessionName: () => "test-session",
  logEvent: () => Effect.void,
};
const TestRunArtifacts: Layer.Layer<RunArtifacts> = Layer.succeed(RunArtifacts, noopRunArtifacts);

const implState: Extract<State, { kind: "implementation" }> = {
  kind: "implementation",
  issue: { iid: 42, title: "Test issue", body: "body" },
  branch: "afk/issue-42-test",
  worktree: "/wt/42",
};

const env = { repoName: "test-repo", defaultBranch: "main" };

const run = (effect: Effect.Effect<State, HandlerError, RunArtifacts>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestRunArtifacts)));

const runFlip = (effect: Effect.Effect<State, HandlerError, RunArtifacts>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestRunArtifacts), Effect.flip));

// --- tests ---
describe("implementationPhase", () => {
  beforeEach(() => {
    _sessionEffect = Effect.succeed("READY_FOR_REVIEW" as const);
    _revListStdout = "0";
  });

  it("READY_FOR_REVIEW → open_draft_mr (unchanged happy path)", async () => {
    _sessionEffect = Effect.succeed("READY_FOR_REVIEW" as const);
    const next = await run(implementationPhase(implState, env));
    expect(next.kind).toBe("open_draft_mr");
  });

  it("timeout with commits ahead → advances to open_draft_mr (salvage)", async () => {
    _sessionEffect = Effect.fail(
      new SessionTimedOut({ phase: "implementation", elapsedMs: 180_000 }),
    );
    _revListStdout = "3\n";
    const next = await run(implementationPhase(implState, env));
    expect(next.kind).toBe("open_draft_mr");
    if (next.kind === "open_draft_mr") {
      expect(next.branch).toBe(implState.branch);
      expect(next.worktree).toBe(implState.worktree);
    }
  });

  it("timeout with no commits → failed as today", async () => {
    _sessionEffect = Effect.fail(
      new SessionTimedOut({ phase: "implementation", elapsedMs: 180_000 }),
    );
    _revListStdout = "0\n";
    const error = await runFlip(implementationPhase(implState, env));
    expect(error).toBeInstanceOf(HandlerError);
    expect(error.reason).toContain("timed out");
  });

  it("BLOCKER_SUSPECTED → failed (unchanged)", async () => {
    _sessionEffect = Effect.succeed("BLOCKER_SUSPECTED" as const);
    const error = await runFlip(implementationPhase(implState, env));
    expect(error).toBeInstanceOf(HandlerError);
    expect(error.reason).toContain("blocker");
  });
});
