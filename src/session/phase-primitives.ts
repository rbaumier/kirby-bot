/**
 * Session/phase-primitives.ts — building blocks for a single `claude` tmux
 * session, reused by both the single-prompt phase runner (`phase.ts`) and the
 * per-agent fan-out runner (`fanout.ts`).
 *
 * Three primitives:
 *
 *  - {@link writeStopHookConfig} — write the Claude Code Stop-hook config
 *    into a worktree's `.claude/`. The hook points at `stop-hook.ts` and the
 *    sentinel file the session is expected to produce.
 *
 *  - {@link pollSentinel} — poll a sentinel path until it appears or the
 *    budget elapses, returning the parsed verdict.
 *
 *  - {@link runOneClaudeSession} — the tmux acquire/use/release bracket: kill
 *    any stale session of the same name, create the session, boot `claude`,
 *    paste the prompt, poll the sentinel, kill the session on every exit.
 *
 * Every failure is one of the typed errors in `./errors`. The bracket keeps
 * the session-kill guarantee on verdict, timeout, defect, or interruption.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Clock, Console, Effect } from "effect";
import type { Phase } from "../config";
import { SENTINEL_POLL_MS } from "../config";
import { formatDuration } from "../duration";
import { RunArtifacts } from "../run-artifacts";
import type { TmuxError } from "./errors";
import { NoVerdict, SessionTimedOut, WorkspaceError } from "./errors";
import { AGENT_SENTINEL_VAR, stopHookSettings } from "./sentinel-contract";
import { bootClaudeSession, createSession, killSession, repromptForVerdict } from "./tmux";
import type { VerdictToken } from "./verdict";
import { parseVerdict } from "./verdict";

/**
 * Write the Claude Code Stop-hook config into a worktree's `.claude/`.
 *
 * The hook command reads its sentinel path from `$AGENT_SENTINEL` rather than
 * a hard-coded argument so a single shared `settings.local.json` is correct
 * for N parallel `claude` sessions in the same worktree (per-agent fan-out):
 * each session exports its own `AGENT_SENTINEL` before launching `claude`,
 * which propagates to the Stop hook subprocess via standard env inheritance.
 * Verified empirically that `--settings <file>` does NOT load Stop hooks —
 * only the cwd-discovered `.claude/settings.local.json` does — so env-var
 * dispatch is the only mechanism that scales to fan-out without per-agent
 * worktrees (which would break cwd-relative refs in agent prompts).
 *
 * On every Stop, the hook invokes our `stop-hook.ts` with that sentinel path.
 * The script reads the Stop payload on stdin, finds the last assistant entry
 * in the transcript JSONL, and either (a) writes the sentinel atomically when
 * `stop_reason === "end_turn"`, or (b) emits a `{"decision":"block"}`
 * response to ask Claude to resume the agent loop — see the script's header
 * for the full contract. Registered for both `Stop` and `StopFailure`.
 * Every path is double-quoted — the command runs through a shell and
 * worktree/sentinel paths may contain spaces.
 *
 * The config is **merged** into any existing `settings.local.json` rather than
 * overwriting it (issue #21): a preexisting file — a parent `.claude/`, default
 * permissions pre-installed in the worktree, or user-supplied hooks — keeps all
 * of its top-level keys (e.g. `permissions`) and any non-Stop hook events.
 *
 * Policy on the two keys we manage: we **own** `Stop` and `StopFailure` and
 * replace them outright rather than appending to them. `writeStopHookConfig`
 * runs once per phase and N times per worktree under fan-out, so replacing is
 * idempotent — appending would accumulate a duplicate hook entry every call.
 * The cost is that a Stop/StopFailure hook from another origin is discarded;
 * the orchestrator's verdict mechanism depends on this hook being the one that
 * runs, so it must win.
 */
export const writeStopHookConfig = (
  phase: Phase,
  worktree: string,
): Effect.Effect<void, WorkspaceError> =>
  Effect.tryPromise({
    try: async () => {
      const claudeDir = join(worktree, ".claude");
      await mkdir(claudeDir, { recursive: true });
      const settingsPath = join(claudeDir, "settings.local.json");
      // Read-merge-write: a malformed or absent file — or a non-object root
      // (array/scalar) — degrades to an empty base so we never throw on a
      // settings file we can't parse and never leak numeric keys; we rebuild it.
      const existing = await readFile(settingsPath, "utf8")
        .then((raw): Record<string, unknown> => {
          const parsed: unknown = JSON.parse(raw);
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
        })
        .catch((): Record<string, unknown> => ({}));
      const existingHooks =
        typeof existing.hooks === "object" && existing.hooks !== null ? existing.hooks : {};
      const merged = {
        ...existing,
        hooks: { ...existingHooks, ...stopHookSettings() },
      };
      await writeFile(settingsPath, JSON.stringify(merged, null, 2));
    },
    catch: (cause) =>
      new WorkspaceError({ phase, operation: "write the Stop-hook config", reason: String(cause) }),
  });

/** Input for {@link pollSentinel}. */
export type PollSentinelInput = {
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
 * in {@link runOneClaudeSession} owns the session and kills it on every exit.
 */
export const pollSentinel = (
  input: PollSentinelInput,
): Effect.Effect<VerdictToken, SessionTimedOut | NoVerdict | WorkspaceError> =>
  Effect.gen(function* () {
    const { phase, sentinel, startedAt, timeoutMs } = input;

    // Stack-safe poll loop: sleep one interval per tick until the
    // sentinel appears or the timeout elapses. The interruptible
    // sleep also lets a Ctrl-C unwind the wait promptly. The loop
    // carries the current time as its state — read from `Clock`, not
    // `Date.now()` — so a virtual clock controls both the sleep and
    // the elapsed-time predicate together.
    const lastNow = yield* Effect.iterate(yield* Clock.currentTimeMillis, {
      while: (now) => !existsSync(sentinel) && now - startedAt <= timeoutMs,
      body: () =>
        Effect.gen(function* () {
          yield* Effect.sleep(`${SENTINEL_POLL_MS} millis`);
          return yield* Clock.currentTimeMillis;
        }),
    });

    if (!existsSync(sentinel)) {
      return yield* Effect.fail(new SessionTimedOut({ phase, elapsedMs: lastNow - startedAt }));
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

/**
 * Give a session that stopped without a clean verdict exactly one more chance
 * (issue #26): on the first {@link NoVerdict}, run `reprompt` (nudge the live
 * session, having cleared the stale sentinel) and poll once more. A second
 * NoVerdict — or a timeout while waiting — surfaces as before, so the recovery
 * is bounded to a single retry within the session's existing wall-clock budget.
 *
 * `poll` is re-run as a value, so it must be the lazy `pollSentinel(...)`
 * Effect (re-checking the sentinel from scratch), not an already-forced result.
 */
export const recoverNoVerdictOnce = <R, RP>(
  poll: Effect.Effect<VerdictToken, SessionTimedOut | NoVerdict | WorkspaceError, R>,
  reprompt: Effect.Effect<void, TmuxError | WorkspaceError, RP>,
): Effect.Effect<VerdictToken, SessionTimedOut | NoVerdict | WorkspaceError | TmuxError, R | RP> =>
  poll.pipe(Effect.catchTag("NoVerdict", () => reprompt.pipe(Effect.zipRight(poll))));

/**
 * Caller-supplied context for log enrichment. Lets the JSONL log and stdout
 * lines emitted by {@link runOneClaudeSession} carry the issue / iteration /
 * agent the session is part of, without coupling primitives to the pipeline's
 * state shape. `agent` is populated only in fan-out — single-prompt phases
 * leave it undefined and the prefix omits the `/agent` tag.
 */
export type SessionLogContext = {
  readonly issueIid: number;
  readonly iteration: number;
  readonly agent?: string;
};

/** Input for {@link runOneClaudeSession}. */
export type RunOneClaudeSessionInput = {
  readonly phase: Phase;
  readonly worktree: string;
  readonly session: string;
  readonly tmuxLogPath: string;
  readonly promptFile: string;
  readonly sentinel: string;
  readonly timeoutMs: number;
  readonly logContext: SessionLogContext;
  /**
   * `claude --model <alias>` for this session. Required for fan-out so each
   * agent runs on its assigned tier; omit on single-prompt phases (the CLI
   * then inherits the orchestrator's model).
   */
  readonly model?: string;
  /**
   * Absolute path to a minimal MCP config JSON. Passed as
   * `--strict-mcp-config --mcp-config <path>` so the session ignores the
   * operator's global MCP config. Omit to inherit the global config.
   */
  readonly mcpConfigPath?: string;
};

/** `[#42 review/correctness[2]]` — concise prefix for stdout session events. */
const logPrefix = (phase: Phase, ctx: SessionLogContext): string => {
  const agentTag = ctx.agent === undefined ? "" : `/${ctx.agent}`;
  return `[#${ctx.issueIid} ${phase}${agentTag}[${ctx.iteration}]]`;
};

/** Common fields stamped into every JSONL session event for grep/jq replay. */
const baseEventFields = (
  phase: Phase,
  ctx: SessionLogContext,
): Record<string, string | number> => ({
  phase,
  iteration: ctx.iteration,
  issueIid: ctx.issueIid,
  ...(ctx.agent === undefined ? {} : { agent: ctx.agent }),
});

/**
 * Run one `claude` tmux session end-to-end: kill any stale session of the same
 * name, create the session, boot `claude`, paste the prompt, poll the sentinel
 * until a verdict appears. The session is always killed on every exit
 * (verdict returned, timeout, defect, or interruption).
 *
 * Emits structured JSONL events (`session_starting`, `session_boot_complete`,
 * `session_verdict`) into {@link RunArtifacts} and matching one-line stdout
 * updates so a live `tail -f run.jsonl` and the human watching the terminal
 * both see boot duration, verdict, and total wall-clock per session. With
 * `logContext.agent` set, every event carries the agent name — that is how
 * per-agent timing in fan-out surfaces uniformly.
 *
 * The caller is responsible for everything upstream of the session: writing
 * the prompt file, writing the Stop-hook config, choosing the timeout.
 */
export const runOneClaudeSession = (
  input: RunOneClaudeSessionInput,
): Effect.Effect<
  VerdictToken,
  TmuxError | SessionTimedOut | NoVerdict | WorkspaceError,
  RunArtifacts
> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    const { phase, worktree, session, tmuxLogPath, promptFile, sentinel, timeoutMs, logContext } =
      input;
    const prefix = logPrefix(phase, logContext);
    const baseEvent = baseEventFields(phase, logContext);

    yield* artifacts.logEvent({ event: "session_starting", ...baseEvent, session, timeoutMs });
    yield* Console.log(`${prefix} session starting (budget ${formatDuration(timeoutMs)})`);

    // Clear any stale session of the same name from a crashed prior run.
    yield* killSession(session);

    let startedAt = 0;

    return yield* Effect.acquireUseRelease(
      createSession(session, worktree),
      () =>
        Effect.gen(function* () {
          // Start the phase clock before booting claude — the TUI-readiness
          // wait counts against the budget, so the cap is a true wall-clock
          // bound on the whole session.
          startedAt = yield* Clock.currentTimeMillis;
          yield* bootClaudeSession({
            session,
            tmuxLogPath,
            promptFile,
            // The Stop hook reads AGENT_SENTINEL — single-session phases get
            // the same env var as fan-out, each with one value.
            env: { [AGENT_SENTINEL_VAR]: sentinel },
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.mcpConfigPath === undefined ? {} : { mcpConfigPath: input.mcpConfigPath }),
          });
          const bootMs = (yield* Clock.currentTimeMillis) - startedAt;
          yield* artifacts.logEvent({
            event: "session_boot_complete",
            ...baseEvent,
            session,
            bootMs,
          });
          yield* Console.log(
            `${prefix} boot ${formatDuration(bootMs)}  ·  tmux attach -r -t ${session}  ·  tail -f ${tmuxLogPath}`,
          );

          // On a stop without a clean verdict, nudge the still-idle session
          // once for an explicit verdict and re-poll within the same budget
          // (#26) — clearing the stale sentinel so the next Stop-hook write is
          // the one we read. A second miss falls through to NoVerdict as before.
          const reprompt = Effect.gen(function* () {
            yield* artifacts.logEvent({ event: "verdict_reprompt", ...baseEvent, session });
            yield* Console.log(`${prefix} stopped without a verdict — re-prompting once`);
            yield* Effect.tryPromise({
              try: () => rm(sentinel, { force: true }),
              catch: (cause) =>
                new WorkspaceError({ phase, operation: "clear the sentinel", reason: String(cause) }),
            });
            yield* repromptForVerdict(session);
          });
          const verdict = yield* recoverNoVerdictOnce(
            pollSentinel({ phase, sentinel, startedAt, timeoutMs }),
            reprompt,
          );
          const totalMs = (yield* Clock.currentTimeMillis) - startedAt;
          yield* artifacts.logEvent({
            event: "session_verdict",
            ...baseEvent,
            session,
            verdict,
            totalMs,
          });
          yield* Console.log(`${prefix} verdict ${verdict} in ${formatDuration(totalMs)}`);

          return verdict;
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              const totalMs = (yield* Clock.currentTimeMillis) - startedAt;
              yield* artifacts.logEvent({
                event: "session_failed",
                ...baseEvent,
                session,
                totalMs,
                error_tag: error._tag,
              });
            }),
          ),
        ),
      () => killSession(session),
    );
  });
