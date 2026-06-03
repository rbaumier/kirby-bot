/**
 * Phase-primitives.test.ts — the session timing primitives read the ambient
 * `Clock`, so a virtual clock drives both the poll sleeps and the elapsed-time
 * predicate together. Before the Clock migration these used `Date.now()` and a
 * TestClock could only move half the system (see issue #23).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { Effect, Fiber, Random, TestClock, TestContext } from "effect";
import { SENTINEL_POLL_MS } from "../config";
import { buildRunArtifacts, RunArtifacts } from "../run-artifacts";
import { NoVerdict, SessionTimedOut } from "./errors";
import { runPhaseSession } from "./phase";
import { pollSentinel, recoverNoVerdictOnce, writeStopHookConfig } from "./phase-primitives";
import type { VerdictToken } from "./verdict";

const ABSENT_SENTINEL = "/kirby-bot-test-no-such-sentinel-xyz.flag";

describe("pollSentinel under a virtual clock", () => {
  it("fails SessionTimedOut when the clock passes the timeout with no sentinel", async () => {
    const timeoutMs = SENTINEL_POLL_MS * 3;
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        pollSentinel({ phase: "implementation", sentinel: ABSENT_SENTINEL, startedAt: 0, timeoutMs }),
      );
      // One push past the budget: every queued poll sleep fires in sequence
      // until the elapsed-time predicate trips. A real clock could not do this
      // deterministically — this is the whole point of the Clock migration.
      yield* TestClock.adjust(`${timeoutMs + SENTINEL_POLL_MS} millis`);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.flip, Effect.provide(TestContext.TestContext));

    const error = await Effect.runPromise(program);
    expect(error._tag).toBe("SessionTimedOut");
  });
});

describe("runPhaseSession budget guard under a virtual clock", () => {
  it("fails BudgetExhausted when the deadline is already spent", async () => {
    const clockMs = 1_700_000_000_000;
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(clockMs);
      const artifacts = yield* buildRunArtifacts;
      return yield* runPhaseSession(
        {
          phase: "implementation",
          issueIid: 1,
          worktree: "/tmp/kirby-test-worktree",
          iteration: 0,
          deadline: clockMs, // no budget left: deadline - now === 0
          replacements: {},
        },
        ["READY_FOR_REVIEW"],
      ).pipe(Effect.provideService(RunArtifacts, artifacts), Effect.flip);
    }).pipe(Effect.withRandom(Random.make(1)), Effect.provide(TestContext.TestContext));

    const error = await Effect.runPromise(program);
    expect(error._tag).toBe("BudgetExhausted");
  });
});

// Issue #26: a session that stops without a clean verdict gets exactly one
// re-prompt before the failure becomes terminal — bounded, and only re-prompts
// when the first poll actually missed.
describe("recoverNoVerdictOnce", () => {
  const makePoll = (outcomes: readonly (VerdictToken | "no-verdict")[]) => {
    let i = 0;
    return Effect.suspend((): Effect.Effect<VerdictToken, NoVerdict> => {
      const outcome = outcomes[Math.min(i, outcomes.length - 1)] ?? "no-verdict";
      i += 1;
      return outcome === "no-verdict"
        ? Effect.fail(new NoVerdict({ phase: "fix", captured: "no verdict line" }))
        : Effect.succeed(outcome);
    });
  };

  it("re-prompts once and returns the verdict from the second poll", async () => {
    let reprompts = 0;
    const reprompt = Effect.sync(() => {
      reprompts += 1;
    });
    const verdict = await Effect.runPromise(
      recoverNoVerdictOnce(makePoll(["no-verdict", "FIX_DONE"]), reprompt),
    );
    expect(verdict).toBe("FIX_DONE");
    expect(reprompts).toBe(1);
  });

  it("does not re-prompt when the first poll already has a verdict", async () => {
    let reprompts = 0;
    const reprompt = Effect.sync(() => {
      reprompts += 1;
    });
    const verdict = await Effect.runPromise(
      recoverNoVerdictOnce(makePoll(["READY_FOR_REVIEW"]), reprompt),
    );
    expect(verdict).toBe("READY_FOR_REVIEW");
    expect(reprompts).toBe(0);
  });

  it("stays terminal after a single re-prompt: a second miss surfaces NoVerdict", async () => {
    let reprompts = 0;
    const reprompt = Effect.sync(() => {
      reprompts += 1;
    });
    const error = await Effect.runPromise(
      recoverNoVerdictOnce(makePoll(["no-verdict", "no-verdict"]), reprompt).pipe(Effect.flip),
    );
    expect(error._tag).toBe("NoVerdict");
    expect(reprompts).toBe(1);
  });

  it("propagates a timeout while waiting after the re-prompt", async () => {
    const reprompt = Effect.void;
    let i = 0;
    const poll = Effect.suspend((): Effect.Effect<VerdictToken, NoVerdict | SessionTimedOut> => {
      i += 1;
      return i === 1
        ? Effect.fail(new NoVerdict({ phase: "fix", captured: "" }))
        : Effect.fail(new SessionTimedOut({ phase: "fix", elapsedMs: 1_800_000 }));
    });
    const error = await Effect.runPromise(recoverNoVerdictOnce(poll, reprompt).pipe(Effect.flip));
    expect(error._tag).toBe("SessionTimedOut");
  });
});

// Issue #21: the Stop-hook config is merged into any preexisting
// settings.local.json instead of overwriting it. We own Stop/StopFailure
// (replace), everything else survives.
describe("writeStopHookConfig merges into an existing settings.local.json", () => {
  const run = (worktree: string) =>
    Effect.runPromise(writeStopHookConfig("implementation", worktree));
  type HookEntry = { matcher: string; hooks: { type: string; command: string }[] };
  type Settings = {
    permissions?: unknown;
    hooks: Record<string, HookEntry[]>;
  };
  const readSettings = (worktree: string): Promise<Settings> =>
    readFile(join(worktree, ".claude", "settings.local.json"), "utf8").then(
      (raw) => JSON.parse(raw) as Settings,
    );
  const firstCommand = (entries: HookEntry[] | undefined): string | undefined =>
    entries?.[0]?.hooks?.[0]?.command;

  it("preserves preexisting permissions and registers our Stop hooks", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "kirby-merge-"));
    try {
      await mkdir(join(worktree, ".claude"), { recursive: true });
      await writeFile(
        join(worktree, ".claude", "settings.local.json"),
        JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }),
      );
      await run(worktree);

      const settings = await readSettings(worktree);
      expect(settings.permissions).toEqual({ allow: ["Bash(git status)"] });
      expect(settings.hooks.Stop).toHaveLength(1);
      expect(settings.hooks.StopFailure).toHaveLength(1);
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(firstCommand(settings.hooks.Stop)).toContain("stop-hook.ts");
      // The SessionStart readiness hook (issue #76) writes the per-session
      // marker bootClaudeSession polls for, dispatched via $AGENT_READY.
      expect(firstCommand(settings.hooks.SessionStart)).toContain("$AGENT_READY");
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it("keeps other hook events but replaces a foreign Stop hook (we own Stop)", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "kirby-merge-"));
    try {
      // Seed .claude/ via a first call, then write a file with a foreign Stop
      // hook plus an unrelated PreToolUse hook.
      await run(worktree);
      const foreign = [{ matcher: "", hooks: [{ type: "command", command: "echo foreign" }] }];
      await writeFile(
        join(worktree, ".claude", "settings.local.json"),
        JSON.stringify({ hooks: { PreToolUse: foreign, Stop: foreign } }),
      );
      await run(worktree);

      const settings = await readSettings(worktree);
      // PreToolUse (another origin) survives untouched.
      expect(settings.hooks.PreToolUse).toEqual(foreign);
      // Our Stop wins — the foreign "echo foreign" command is gone.
      expect(firstCommand(settings.hooks.Stop)).toContain("stop-hook.ts");
      expect(firstCommand(settings.hooks.StopFailure)).toContain("stop-hook.ts");
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
