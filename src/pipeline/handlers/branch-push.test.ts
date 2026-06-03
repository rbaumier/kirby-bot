/**
 * Branch-push.test.ts — the `branch_push → plan` transition (#75).
 *
 * `runShellGit` (the `git push`) is module-mocked so no remote is touched; the
 * checkpoint store reads from a per-test STATE_DIR subtree wiped in beforeEach,
 * so a fresh branch (no checkpoint) takes the new `plan` gate instead of jumping
 * straight to `implementation`.
 */
import { mock, describe, it, expect, beforeEach, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { STATE_DIR } from "../../config";
import type { Environment } from "../../preflight";
import { RunArtifacts } from "../../run-artifacts";
import type { RunArtifactsShape } from "../../run-artifacts";
import type { State } from "../state";

// Capture the real module before mocking it; afterAll re-mocks it back so the
// global `mock.module` does not leak into later test files (see the same dance
// in src/phases/implementation.test.ts).
import * as realShell from "../../shell";
const capturedShell = { ...realShell };

let _pushEffect: Effect.Effect<{ stdout: string; stderr: string }, any, any> = Effect.succeed({
  stdout: "",
  stderr: "",
});

mock.module("../../shell", () => ({
  runShellGit: () => _pushEffect,
}));

afterAll(() => {
  mock.module("../../shell", () => capturedShell);
});

// Import AFTER the mock is registered (Bun hoists mock.module above static imports).
import { onBranchPush } from "./queue";

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

const env: Environment = { repoName: "kirby-branchpush-plantest", defaultBranch: "main" };

const branchPush: Extract<State, { kind: "branch_push" }> = {
  kind: "branch_push",
  issue: { iid: 42, title: "Test issue", body: "body" },
  branch: "afk/issue-42-test",
  worktree: "/wt/42",
};

describe("onBranchPush", () => {
  // Own the checkpoint subtree so a stale checkpoint can't route us to open_draft_mr.
  beforeEach(() => rm(join(STATE_DIR, env.repoName), { recursive: true, force: true }));

  it("a fresh branch (no checkpoint) transitions to plan, not implementation (#75)", async () => {
    const next = await Effect.runPromise(
      onBranchPush(branchPush, env).pipe(Effect.provide(TestRunArtifacts)),
    );
    expect(next.kind).toBe("plan");
    if (next.kind === "plan") {
      expect(next.branch).toBe(branchPush.branch);
      expect(next.worktree).toBe(branchPush.worktree);
    }
  });
});
