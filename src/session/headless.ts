/**
 * Session/headless.ts — the `claude -p` headless subprocess driver.
 *
 * The default session backend (see `driver.ts`). One `claude -p` subprocess per
 * phase: the rendered prompt is piped on stdin, the `--output-format stream-json`
 * events stream into the phase log (for live `tail -f`), and the verdict is
 * parsed from the final `result` event's text. No tmux — so none of the paste /
 * submit / ready-marker machinery (and its #30/#43 races) applies; a dropped
 * keystroke is impossible when the prompt is a single stdin write.
 *
 * Verdict capture differs from the tmux driver on purpose. `claude -p` does NOT
 * resume the agent loop when a Stop hook returns `{"decision":"block"}` (verified
 * against the Claude Code headless docs + a live smoke run, 2026-06), so the
 * Stop-hook sentinel is not a reliable verdict wire here. Instead we read the
 * `result.result` text the CLI prints as its official final output and run the
 * same {@link parseVerdict} over it. A first run that ends without a clean
 * verdict is re-prompted exactly once via `--resume <session_id>` — the headless
 * analogue of the tmux driver's single no-verdict nudge (#26) — so the agent
 * keeps its built-up context, within the session's remaining wall-clock budget.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Clock, Console, Effect } from "effect";
import type { Phase } from "../config";
import { SENTINEL_POLL_MS } from "../config";
import { formatDuration } from "../duration";
import { RunArtifacts } from "../run-artifacts";
import { NoVerdict, SessionTimedOut, WorkspaceError } from "./errors";
import type { RunOneClaudeSessionInput } from "./phase-primitives";
import {
  AGENT_READY_VAR,
  AGENT_SENTINEL_VAR,
  AGENT_SUBMITTED_VAR,
} from "./sentinel-contract";
import { baseEventFields, logPrefix } from "./session-log";
import { MODEL_ALIAS_RE, verdictReminder } from "./tmux";
import type { VerdictToken } from "./verdict";
import { parseVerdict } from "./verdict";

/**
 * The fixed `claude -p` flags every headless run carries. `--verbose` is
 * mandatory for `--output-format stream-json` in print mode (the CLI rejects the
 * combination without it).
 */
const HEADLESS_BASE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--dangerously-skip-permissions",
] as const;

/**
 * Build the `claude` argv (everything after the binary) for a headless run.
 * Handed to `spawn` as a real argv array — no shell — so `model` /
 * `mcpConfigPath` need no quoting; `model` is still validated against
 * {@link MODEL_ALIAS_RE} so a malformed alias fails with a clear error here
 * rather than as an opaque CLI usage error.
 */
export const buildHeadlessArgs = (model?: string, mcpConfigPath?: string): string[] => {
  if (model !== undefined && !MODEL_ALIAS_RE.test(model)) {
    throw new Error(`invalid model alias: ${model}`);
  }
  return [
    ...HEADLESS_BASE_ARGS,
    ...(model === undefined ? [] : ["--model", model]),
    ...(mcpConfigPath === undefined ? [] : ["--strict-mcp-config", "--mcp-config", mcpConfigPath]),
  ];
};

/** The verdict-relevant fields the driver needs from a `claude -p` run's stdout. */
export type HeadlessResult = {
  /** `session_id` carried by every event — needed to `--resume` a re-prompt. */
  readonly sessionId: string | null;
  /** The final `result` event's text, or `null` if no result event was printed. */
  readonly finalText: string | null;
};

/**
 * Parse the verdict-relevant fields out of a `claude -p --output-format
 * stream-json` stdout. Tolerant of interleaved non-JSON lines and of partial
 * output from a killed subprocess: every parseable object refreshes `sessionId`,
 * and the `result` object supplies `finalText`. Pure — unit-tested.
 */
export const parseHeadlessResult = (stdout: string): HeadlessResult => {
  let sessionId: string | null = null;
  let finalText: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) {
      continue;
    }
    const record = event as Record<string, unknown>;
    if (typeof record.session_id === "string") {
      sessionId = record.session_id;
    }
    if (record.type === "result" && typeof record.result === "string") {
      finalText = record.result;
    }
  }
  return { sessionId, finalText };
};

/** One completed (or killed) `claude -p` subprocess. */
type HeadlessRun = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
};

/** Parameters for a single `claude -p` spawn. */
export type SpawnHeadlessInput = {
  readonly phase: Phase;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly promptText: string;
  readonly logPath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
};

/**
 * The injectable seam: run one `claude -p` subprocess to completion. Defaults to
 * {@link spawnHeadless}; tests pass a fake that returns scripted stdout so the
 * verdict / re-prompt logic runs without a real subprocess.
 */
export type RunHeadless = (
  input: SpawnHeadlessInput,
) => Effect.Effect<HeadlessRun, WorkspaceError | SessionTimedOut>;

/**
 * Spawn `claude -p`, pipe `promptText` on stdin, mirror stdout + stderr into the
 * phase log while capturing stdout for parsing, and resolve once the process
 * closes. Past `timeoutMs` the process is killed and the run fails
 * {@link SessionTimedOut}; an interruption (Ctrl-C) kills it too — the
 * `Effect.async` cleanup guarantees no orphaned `claude` outlives the fiber.
 */
const spawnHeadless: RunHeadless = (input) =>
  Effect.async<HeadlessRun, WorkspaceError | SessionTimedOut>((resume) => {
    const log = createWriteStream(input.logPath, { flags: "a" });
    const child = spawn("claude", [...input.args], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (effect: Effect.Effect<HeadlessRun, WorkspaceError | SessionTimedOut>): void => {
      if (settled) {
        return;
      }
      settled = true;
      log.end();
      resume(effect);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      log.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      log.write(chunk);
    });
    child.on("error", (error) => {
      finish(
        Effect.fail(
          new WorkspaceError({
            phase: input.phase,
            operation: "spawn claude -p",
            reason: String(error),
          }),
        ),
      );
    });
    child.on("close", (code) => {
      finish(Effect.succeed({ stdout, stderr, exitCode: code }));
    });
    // A stdin EPIPE (the child exited before reading the prompt) is reported via
    // the close/error handlers; swallow the write-side error so it isn't an
    // unhandled 'error' event that crashes the process.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input.promptText);
    return Effect.sync(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        log.end();
      }
    });
  }).pipe(
    Effect.timeoutFail({
      duration: `${input.timeoutMs} millis`,
      onTimeout: (): SessionTimedOut =>
        new SessionTimedOut({ phase: input.phase, elapsedMs: input.timeoutMs }),
    }),
  );

/**
 * Run one phase as a `claude -p` headless subprocess and return its verdict.
 *
 * Mirrors the tmux runner's contract — same {@link RunOneClaudeSessionInput},
 * same JSONL events (`session_starting` / `session_verdict` / `session_failed`),
 * an error channel that is a subset of it — so the dispatcher in
 * `phase-primitives.ts` picks either driver transparently. The single
 * no-verdict re-prompt resumes the same `claude` session rather than starting
 * fresh, so the agent keeps its context.
 *
 * `runClaude` is injected only by tests; production uses {@link spawnHeadless}.
 */
export const runOneHeadlessSession = (
  input: RunOneClaudeSessionInput,
  runClaude: RunHeadless = spawnHeadless,
): Effect.Effect<VerdictToken, SessionTimedOut | NoVerdict | WorkspaceError, RunArtifacts> =>
  Effect.gen(function* () {
    const artifacts = yield* RunArtifacts;
    const { phase, worktree, session, tmuxLogPath, promptFile, sentinel, timeoutMs, logContext } =
      input;
    const prefix = logPrefix(phase, logContext);
    const baseEvent = baseEventFields(phase, logContext);

    const promptText = yield* Effect.tryPromise({
      try: () => readFile(promptFile, "utf8"),
      catch: (cause) =>
        new WorkspaceError({ phase, operation: "read the prompt file", reason: String(cause) }),
    });
    const args = yield* Effect.try({
      try: () => buildHeadlessArgs(input.model, input.mcpConfigPath),
      catch: (cause) =>
        new WorkspaceError({ phase, operation: "build claude -p args", reason: String(cause) }),
    });

    // Hand any Stop / SessionStart / UserPromptSubmit hooks the worktree's config
    // installed (by the caller) the same per-session marker paths a tmux session
    // would, so they write to valid paths instead of an unset env var. The
    // markers are unused here — the verdict comes from stdout — but a worktree
    // hook firing on garbage paths would be the only harm, and this removes it.
    const env = {
      [AGENT_SENTINEL_VAR]: sentinel,
      [AGENT_READY_VAR]: `${sentinel}.ready`,
      [AGENT_SUBMITTED_VAR]: `${sentinel}.submitted`,
    };

    yield* artifacts.logEvent({ event: "session_starting", ...baseEvent, session, timeoutMs });
    yield* Console.log(
      `${prefix} headless session starting (budget ${formatDuration(timeoutMs)})  ·  tail -f ${tmuxLogPath}`,
    );
    const startedAt = yield* Clock.currentTimeMillis;

    return yield* Effect.gen(function* () {
      const first = yield* runClaude({
        phase,
        args,
        cwd: worktree,
        promptText,
        logPath: tmuxLogPath,
        env,
        timeoutMs,
      });
      // A non-zero exit is a CLI-level failure (bad flags, stdin over the 10 MB
      // cap) — not the agent's fault. Surface it with stderr rather than letting
      // the empty stdout degrade to a bare NoVerdict.
      if (first.exitCode !== 0 && first.exitCode !== null) {
        return yield* Effect.fail(
          new WorkspaceError({
            phase,
            operation: "run claude -p",
            reason: `exited ${first.exitCode}: ${first.stderr.trim().slice(0, 200) || "<no stderr>"}`,
          }),
        );
      }
      const firstParsed = parseHeadlessResult(first.stdout);
      let verdict = firstParsed.finalText === null ? null : parseVerdict(firstParsed.finalText);
      let captured = firstParsed.finalText ?? "";

      // One no-verdict re-prompt (#26 analogue): resume the same session with an
      // explicit reminder of the accepted tokens, within the remaining budget. A
      // missing session_id means there is nothing to resume — fall through to
      // NoVerdict rather than start a fresh, context-less run.
      if (verdict === null && firstParsed.sessionId !== null) {
        yield* artifacts.logEvent({ event: "verdict_reprompt", ...baseEvent, session });
        yield* Console.log(`${prefix} stopped without a verdict — re-prompting once (resume)`);
        const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
        const remaining = Math.max(SENTINEL_POLL_MS, timeoutMs - elapsed);
        const second = yield* runClaude({
          phase,
          args: [...args, "--resume", firstParsed.sessionId],
          cwd: worktree,
          promptText: verdictReminder(input.expectedVerdicts ?? []),
          logPath: tmuxLogPath,
          env,
          timeoutMs: remaining,
        });
        const secondParsed = parseHeadlessResult(second.stdout);
        verdict = secondParsed.finalText === null ? null : parseVerdict(secondParsed.finalText);
        captured = secondParsed.finalText ?? captured;
      }

      if (verdict === null) {
        return yield* Effect.fail(
          new NoVerdict({ phase, captured: captured.trim().replaceAll("\n", " ") }),
        );
      }

      const totalMs = (yield* Clock.currentTimeMillis) - startedAt;
      yield* artifacts.logEvent({ event: "session_verdict", ...baseEvent, session, verdict, totalMs });
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
    );
  });
