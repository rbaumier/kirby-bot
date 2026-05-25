/**
 * Session/phase.ts — running one pipeline phase as a fresh `claude` tmux session.
 *
 * `runPhaseSession` is the load-bearing helper. It writes the
 * Stop-hook config, renders the prompt, and drives a tmux session
 * to a verdict. The session is held in an `acquireUseRelease`
 * bracket so it is always killed on every exit path (verdict
 * returned, timeout, defect, or Ctrl-C).
 *
 * Every failure is one of the typed errors in `./errors`.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Console, Effect } from "effect";
import type { Phase } from "../config";
import { PHASE_CAP_MINUTES, SENTINEL_POLL_MS } from "../config";
import { RunArtifacts } from "../run-artifacts";
import type { PhaseError } from "./errors";
import {
  BudgetExhausted,
  NoVerdict,
  SessionTimedOut,
  UnexpectedVerdictError,
  WorkspaceError,
} from "./errors";
import { renderPrompt } from "./prompt";
import { bootClaudeSession, createSession, killSession } from "./tmux";
import type { VerdictToken } from "./verdict";
import { parseVerdict } from "./verdict";

/**
 * Write the Claude Code Stop-hook config into a worktree's `.claude/`.
 *
 * The hook is non-blocking: on every Stop it dumps the payload's
 * `last_assistant_message` into `sentinel`, written atomically (`.tmp` then
 * `mv`) so the poller never sees a half-written file. Registered for both
 * `Stop` and `StopFailure`. Every path is double-quoted — `jq`/`mv` run
 * through a shell and the worktree path may contain spaces.
 */
const writeStopHookConfig = (
  phase: Phase,
  worktree: string,
  sentinel: string,
): Effect.Effect<void, WorkspaceError> =>
  Effect.tryPromise({
    try: async () => {
      const claudeDir = join(worktree, ".claude");
      await mkdir(claudeDir, { recursive: true });
      const command =
        `jq -r '.last_assistant_message // empty' > "${sentinel}.tmp" ` +
        `&& mv "${sentinel}.tmp" "${sentinel}"`;
      const hookEntry = [{ matcher: "", hooks: [{ type: "command", command }] }];
      await writeFile(
        join(claudeDir, "settings.local.json"),
        JSON.stringify({ hooks: { Stop: hookEntry, StopFailure: hookEntry } }, null, 2),
      );
    },
    catch: (cause) =>
      new WorkspaceError({ phase, operation: "write the Stop-hook config", reason: String(cause) }),
  });

/** Input for {@link pollSentinel}. */
type PollSentinelInput = {
  readonly phase: Phase;
  readonly sentinel: string;
  readonly startedAt: number;
  readonly timeoutMs: number;
};

/**
 * Poll `sentinel` every {@link SENTINEL_POLL_MS} until it appears
 * or the timeout elapses. Returns the verdict, or fails with
 * {@link SessionTimedOut} / {@link NoVerdict}.
 *
 * Killing the tmux session is not this function's job. The bracket
 * in `runPhaseSession` owns the session and kills it on every exit.
 */
const pollSentinel = (
  input: PollSentinelInput,
): Effect.Effect<VerdictToken, SessionTimedOut | NoVerdict | WorkspaceError> =>
  Effect.gen(function* () {
    const { phase, sentinel, startedAt, timeoutMs } = input;

    // Stack-safe poll loop: sleep one interval per tick until the
    // sentinel appears or the timeout elapses. The interruptible
    // sleep also lets a Ctrl-C unwind the wait promptly.
    yield* Effect.iterate(0, {
      while: () => !existsSync(sentinel) && Date.now() - startedAt <= timeoutMs,
      body: (tick) => Effect.as(Effect.sleep(`${SENTINEL_POLL_MS} millis`), tick + 1),
    });

    if (!existsSync(sentinel)) {
      return yield* Effect.fail(new SessionTimedOut({ phase, elapsedMs: Date.now() - startedAt }));
    }

    const message = yield* Effect.tryPromise({
      try: () => readFile(sentinel, "utf8"),
      catch: (cause) =>
        new WorkspaceError({ phase, operation: "read the sentinel", reason: String(cause) }),
    });
    const verdict = parseVerdict(message);
    if (verdict === null) {
      return yield* Effect.fail(
        new NoVerdict({ phase, captured: message.trim().replaceAll("\n", " ") }),
      );
    }
    return verdict;
  });

/** Input for {@link runPhaseSession}. */
export type RunPhaseSessionInput = {
  readonly phase: Phase;
  readonly issueIid: number;
  readonly worktree: string;
  readonly iteration: number;
  readonly deadline: number;
  readonly replacements: Record<string, string>;
};

/**
 * Run one phase as a fresh `claude` tmux session and return a verdict narrowed
 * to the expected set.
 *
 * The tmux session is an `acquireUseRelease` resource. `createSession` is the
 * acquire, `killSession` the release — guaranteed to run on every exit of
 * `use` (verdict, timeout, defect, or interruption).
 *
 * An out-of-set verdict fails with `UnexpectedVerdictError` so callers route
 * on tagged data rather than re-pattern-matching a verdict string.
 */
export const runPhaseSession = <const V extends VerdictToken>(
  input: RunPhaseSessionInput,
  expected: readonly V[],
): Effect.Effect<V, PhaseError, RunArtifacts> =>
  Effect.gen(function* () {
    const { phase, issueIid, worktree, iteration, deadline, replacements } = input;
    // Phase timeout: the smaller of its per-phase cap and the budget still
    // left for the issue. No floor — below one poll interval we refuse to spawn.
    const timeoutMs = Math.min(PHASE_CAP_MINUTES[phase] * 60 * 1000, deadline - Date.now());

    // A budget below one poll interval can never yield a verdict in time —
    // fail now rather than spawn a session that is killed mid-boot.
    if (timeoutMs < SENTINEL_POLL_MS) {
      return yield* Effect.fail(new BudgetExhausted({ phase }));
    }

    const artifacts = yield* RunArtifacts;
    const ref = { issueIid, phase, iteration };
    const session = artifacts.sessionName(ref);
    const sentinel = artifacts.sentinelPath(ref);
    const tmuxLog = artifacts.tmuxLogPath(ref);
    const promptFile = artifacts.promptFilePath(ref);

    yield* writeStopHookConfig(phase, worktree, sentinel);
    const rendered = yield* renderPrompt(phase, replacements);
    yield* Effect.tryPromise({
      try: () => writeFile(promptFile, rendered),
      catch: (cause) =>
        new WorkspaceError({ phase, operation: "write the prompt file", reason: String(cause) }),
    });
    // Clear any stale session of the same name from a crashed prior run.
    yield* killSession(session);

    const verdict = yield* Effect.acquireUseRelease(
      createSession(session, worktree),
      () =>
        Effect.gen(function* () {
          // Start the phase clock before booting claude — the TUI-readiness
          // wait counts against the budget, so the cap is a true wall-clock
          // bound on the whole session.
          const startedAt = Date.now();
          yield* bootClaudeSession({ session, tmuxLogPath: tmuxLog, promptFile });
          yield* Console.log(`  ↳ ${phase}: tmux attach -r -t ${session}   ·   tail -f ${tmuxLog}`);
          return yield* pollSentinel({ phase, sentinel, startedAt, timeoutMs });
        }),
      () => killSession(session),
    );

    const narrowed = expected.find((candidate) => candidate === verdict);
    if (narrowed === undefined) {
      return yield* Effect.fail(new UnexpectedVerdictError({ phase, verdict, expected }));
    }
    return narrowed;
  });
