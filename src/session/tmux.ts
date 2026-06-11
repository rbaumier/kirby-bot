/**
 * Session/tmux.ts — the tmux session lifecycle, as Effects.
 *
 * A phase runs inside a detached tmux session. The session is
 * created, a `claude` process is booted in it and the prompt
 * pasted, and the session is later killed. Each step is an Effect,
 * so the lifecycle composes cleanly into the `acquireUseRelease`
 * bracket in phase.ts.
 */
import { existsSync, rmSync } from "node:fs";
import { $ } from "bun";
import { Console, Duration, Effect } from "effect";
import { describeShellError, runShell } from "../shell";
import { TmuxError } from "./errors";
import { AGENT_READY_VAR } from "./sentinel-contract";

/**
 * Run one tmux command, failing {@link TmuxError} on a non-zero exit.
 *
 * For a real non-zero exit, `stderr` carries the trimmed process stderr
 * — preserves the legacy contract. The two non-process modes (spawn,
 * timeout) fall back to {@link describeShellError} as the reason.
 */
const tmuxStep = (
  step: string,
  build: () => ReturnType<typeof $>,
): Effect.Effect<void, TmuxError> =>
  runShell(build).pipe(
    Effect.mapError(
      (error) =>
        new TmuxError({
          step,
          stderr:
            error._tag === "ShellNonZeroExit" ? error.stderr.trim() : describeShellError(error),
        }),
    ),
    Effect.asVoid,
  );

/** Create a detached tmux session rooted at `worktree`. */
export const createSession = (session: string, worktree: string): Effect.Effect<void, TmuxError> =>
  tmuxStep("new-session", () => $`tmux new-session -d -s ${session} -c ${worktree}`);

/** Kill a tmux session. Best-effort — a missing session is not an error. */
export const killSession = (session: string): Effect.Effect<void> =>
  runShell(() => $`tmux kill-session -t ${session}`).pipe(Effect.ignore);

/**
 * One-line nudge sent to a session that stopped without emitting a verdict.
 * Single line, no newline — delivered as one keystroke string then Enter, so
 * the idle TUI receives it the same way the boot prompt's trailing Enter is
 * sent (no buffer paste needed for a short reminder).
 *
 * With `expected` known, the reminder spells out the exact accepted tokens:
 * the generic `VERDICT: TOKEN` wording let an agent that had drifted to an
 * invalid token (a live `implementation` session re-emitted `VERDICT: SUCCESS`
 * after the nudge) repeat the same mistake and stall the issue.
 */
export const verdictReminder = (expected: readonly string[]): string =>
  expected.length === 0
    ? "You stopped without a verdict. Emit it now as `VERDICT: TOKEN` on its own line, with nothing else on that line."
    : `You stopped without a valid verdict. Emit one now, alone on the final line, exactly one of: ${expected
        .map((token) => `\`VERDICT: ${token}\``)
        .join(" or ")}. No other token is accepted (SUCCESS, DONE, COMPLETE all fail the parser).`;

/** Bounded Enter re-sends confirmed by the submitted-marker before giving up. */
const REPROMPT_MAX_ATTEMPTS = 3;

/** Per-attempt cap polling for the submitted-marker before re-sending Enter. */
const REPROMPT_LAND_MAX_TICKS = 10;

/** Input for {@link repromptForVerdict}. */
type RepromptForVerdictInput = {
  readonly session: string;
  readonly submittedPath: string;
  /** Verdict tokens the phase accepts — spelled out in the reminder. */
  readonly expected?: readonly string[];
  /** The reminder-typing side effect, injected only by tests. */
  readonly typeReminder?: Effect.Effect<void, TmuxError>;
  /** The Enter-press side effect, injected only by tests. */
  readonly pressEnter?: Effect.Effect<void, TmuxError>;
  /**
   * The submitted-marker probe polled after each Enter, injected only by tests.
   * Defaults to an `existsSync` of `submittedPath` (yields "1" once the
   * `UserPromptSubmit` hook has written it).
   */
  readonly submittedMarker?: Effect.Effect<string>;
  /** Poll interval for the marker; tests pass a tiny value to avoid real sleeps. */
  readonly interval?: Duration.DurationInput;
};

/**
 * Re-prompt an idle session to emit its verdict (issue #26). The session must
 * already be sitting at the `claude` prompt; this types the reminder, submits
 * it, and confirms the submit actually took against the same `UserPromptSubmit`
 * marker ground truth as {@link deliverPrompt}, re-sending Enter while it stays
 * absent. The fire-and-forget `send-keys <text> Enter` this replaces lost its
 * Enter to the same TUI race as the boot paste (#30): the reminder sat
 * unsubmitted in the input box and three frozen Planners idled their full
 * budget to SessionTimedOut. The marker on disk was written by the INITIAL
 * prompt's submit and would read as instantly submitted, so it is cleared
 * here before anything is typed. Still best-effort on exhaustion: the
 * caller's re-poll times out into the same terminal NoVerdict, never worse.
 */
export const repromptForVerdict = (
  input: RepromptForVerdictInput,
): Effect.Effect<void, TmuxError> =>
  Effect.gen(function* () {
    const { session, submittedPath } = input;
    yield* Effect.try(() => rmSync(submittedPath, { force: true })).pipe(Effect.ignore);
    const reminder = verdictReminder(input.expected ?? []);
    const typeReminder =
      input.typeReminder ??
      tmuxStep("reprompt-verdict", () => $`tmux send-keys -t ${session} ${reminder}`);
    const pressEnter = input.pressEnter ?? sendEnter(session);
    const submittedMarker =
      input.submittedMarker ?? Effect.sync(() => (existsSync(submittedPath) ? "1" : ""));
    const interval = input.interval ?? "1 second";
    yield* typeReminder;
    for (let attempt = 1; attempt <= REPROMPT_MAX_ATTEMPTS; attempt++) {
      yield* pressEnter;
      const submitted = yield* pollPaneUntil(
        submittedMarker,
        (marker) => marker === "1",
        REPROMPT_LAND_MAX_TICKS,
        interval,
      );
      if (submitted) {
        return;
      }
      yield* Console.log(
        `[tmux ${session}] reprompt not submitted (attempt ${attempt}/${REPROMPT_MAX_ATTEMPTS})` +
          (attempt < REPROMPT_MAX_ATTEMPTS ? " — re-sending Enter" : " — proceeding anyway"),
      );
    }
  });

/**
 * Send a bare Enter to submit whatever is sitting in a session's input box — the
 * recovery keystroke {@link submitPastedPrompt} sends after a paste. When that
 * trailing Enter is dropped under tmux-server backlog (#30) and the prompt is
 * left unsubmitted, {@link deliverPrompt} catches it via the absent
 * `UserPromptSubmit` marker and re-drives the whole paste+Enter.
 */
export const sendEnter = (session: string): Effect.Effect<void, TmuxError> =>
  tmuxStep("send-enter", () => $`tmux send-keys -t ${session} Enter`);

/** Capture the visible content of a session's pane. Empty string on any failure. */
export const capturePane = (session: string): Effect.Effect<string> =>
  runShell(() => $`tmux capture-pane -p -t ${session}`).pipe(
    Effect.map((result) => result.stdout),
    Effect.catchAll(() => Effect.succeed("")),
  );

/**
 * Poll a pane once per `interval` until `ready(pane)` holds or `maxTicks`
 * elapse. Resolves to whether readiness was actually observed (`false` = the
 * cap was hit and the caller should proceed on a best-effort basis).
 *
 * `capture` is taken as an injected Effect — re-run each tick — so the loop is
 * unit-testable by feeding a scripted sequence of pane snapshots without a live
 * tmux server, and `interval` is a parameter so those tests need not sleep for
 * real seconds.
 */
export const pollPaneUntil = (
  capture: Effect.Effect<string>,
  ready: (pane: string) => boolean,
  maxTicks: number,
  interval: Duration.DurationInput = "1 second",
): Effect.Effect<boolean> =>
  Effect.iterate(
    { ticks: 0, ready: false },
    {
      while: (state) => state.ticks < maxTicks && !state.ready,
      body: (state) =>
        Effect.sleep(interval).pipe(
          Effect.flatMap(() => capture),
          Effect.map((pane) => ({ ticks: state.ticks + 1, ready: ready(pane) })),
        ),
    },
  ).pipe(Effect.map((state) => state.ready));

/** Bounded readiness poll before paste; on cap we proceed anyway (never hang). */
const READY_MAX_TICKS = 60;

/**
 * Wait for the `claude` TUI to be ready to accept input before pasting into it.
 *
 * Instead of screen-scraping the pane for a rendered prompt box — a cosmetic
 * heuristic that broke on any boot-time churn that redraws without the input
 * box (an "Update available" banner, a MOTD, a spinner, a relayout — issue #25)
 * — we trust a deterministic runtime signal: the `SessionStart` hook writes
 * `readyPath` once the interactive TUI is up and accepting keystrokes (issue
 * #76). We poll the filesystem for that marker by feeding the generic
 * {@link pollPaneUntil} primitive a file-existence Effect in place of
 * {@link capturePane}. On the cap it proceeds anyway rather than hang forever —
 * an absent marker degrades to the pre-#25 "proceed after cap" behaviour, never
 * worse, and the paste-delivery check in {@link loadAndPastePrompt} still guards
 * against pasting into a dead pane.
 */
export const waitForReadyMarker = (readyPath: string): Effect.Effect<void> =>
  pollPaneUntil(
    Effect.sync(() => (existsSync(readyPath) ? "1" : "")),
    (s) => s === "1",
    READY_MAX_TICKS,
  ).pipe(Effect.asVoid);

/**
 * Collapsed-paste marker the Claude TUI renders once a multi-line prompt has
 * landed in the input area (`[Pasted text #N +M lines]`). kirby-bot prompts
 * are always large and multi-line, so the TUI always collapses them — the
 * marker's presence is a reliable proxy for "the paste actually arrived",
 * which pane stability alone is NOT under tmux-server backlog (issue #30).
 */
export const TUI_PASTE_MARKER = "[Pasted text";

/** Whether the pane shows a delivered (collapsed) paste in the input area. */
export const paneShowsPaste = (pane: string): boolean => pane.includes(TUI_PASTE_MARKER);

/**
 * Bottom-of-dialog markers of the Claude usage-limit prompt (issue #77).
 *
 * We anchor on the option block, NOT the `You've hit your <kind> limit` header:
 * the header scrolls out of the captured region in ~15% of frozen sessions, but
 * the option block stays visible the whole time the dialog blocks. Both markers
 * are required so a stray mention of either phrase in normal agent output cannot
 * trip the predicate on its own.
 *
 * Deliberately free of any model name ("Sonnet"): the same predicate must catch
 * the per-model limit, the 5-hour `session` limit, and any future `Opus`/weekly
 * phrasing — only the bottom option block is invariant across all of them.
 */
export const USAGE_LIMIT_STOP_MARKER = "Stop and wait for limit to reset";
export const USAGE_LIMIT_CONFIRM_MARKER = "Enter to confirm";

/** Whether the pane shows the blocking Claude usage-limit dialog. */
export const paneShowsUsageLimit = (pane: string): boolean =>
  pane.includes(USAGE_LIMIT_STOP_MARKER) && pane.includes(USAGE_LIMIT_CONFIRM_MARKER);

/** Bounded load+paste attempts before falling through to Enter regardless. */
const PASTE_MAX_ATTEMPTS = 3;

/** Per-attempt cap polling for the paste to land before we re-check + retry. */
const PASTE_LAND_MAX_TICKS = 10;

/** Bounded Enter re-sends before we proceed regardless. */
const SUBMIT_MAX_ATTEMPTS = 3;

/** Per-attempt cap polling for the submit to take effect before re-sending. */
const SUBMIT_LAND_MAX_TICKS = 10;

/**
 * Load the prompt into the session's named buffer, paste it into the pane, and
 * verify the paste actually landed before returning. Retries up to
 * {@link PASTE_MAX_ATTEMPTS} times.
 *
 * Two races stack here:
 *
 *  1. **Global-buffer cross-paste.** Without `-b ${session}`, N concurrent
 *     `load-buffer` calls overwrite the same anonymous slot, so most sessions
 *     paste another agent's prompt (or an empty buffer). The named buffer
 *     (keyed by session) isolates each session's payload.
 *
 *  2. **Async delivery (issue #30).** `tmux paste-buffer` only *enqueues* the
 *     write with the tmux server, which drains its queue asynchronously. Under
 *     high concurrency (15+ sessions) the server backlogs: a naive settle-wait
 *     observes a visually-stable pane (still the empty-input placeholder) and
 *     returns before the bytes reach the application. The caller then sends
 *     Enter on an empty input and the session idles at 0% forever.
 *
 * After each paste we poll the pane for the collapsed-paste marker, returning as
 * soon as it appears (or on a bounded cap). Absent → re-load + re-paste. We
 * verify with the
 * positive marker (not placeholder-absence) so the check biases toward
 * retrying: a false "not delivered" costs at worst a benign double-paste (the
 * agent reads its prompt twice and still emits one verdict), whereas a false
 * "delivered" would send Enter on an empty input — the exact stuck-session
 * bug. If every attempt fails we fall through; the caller sends Enter and the
 * session degrades to the pre-fix NoVerdict path, never worse.
 */
const loadAndPastePrompt = (
  session: string,
  promptFile: string,
): Effect.Effect<void, TmuxError> =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= PASTE_MAX_ATTEMPTS; attempt++) {
      yield* tmuxStep("load-buffer", () => $`tmux load-buffer -b ${session} ${promptFile}`);
      yield* tmuxStep("paste-buffer", () => $`tmux paste-buffer -b ${session} -t ${session}`);
      yield* pollPaneUntil(capturePane(session), paneShowsPaste, PASTE_LAND_MAX_TICKS);
      const pane = yield* capturePane(session);
      if (paneShowsPaste(pane)) { return; }
      yield* Console.log(
        `[tmux ${session}] paste not delivered (attempt ${attempt}/${PASTE_MAX_ATTEMPTS})` +
          (attempt < PASTE_MAX_ATTEMPTS ? " — re-pasting" : " — sending Enter anyway"),
      );
    }
  });

/**
 * Send Enter to submit the already-pasted prompt, verifying the submit actually
 * took before returning. Retries up to {@link SUBMIT_MAX_ATTEMPTS} times.
 *
 * The same tmux-server backlog that delays paste delivery (#30) can also drop
 * the trailing Enter: `send-keys Enter` is enqueued but the application never
 * processes it, leaving the collapsed paste sitting in the input box at 🧠 0%
 * forever — the session then idles to its full timeout and surfaces NoVerdict
 * even though the prompt was right there, unsubmitted. (Observed live: six
 * review agents plus a router frozen exactly this way.)
 *
 * {@link loadAndPastePrompt} polls for the collapsed-paste marker to APPEAR;
 * this is the mirror — we poll until it DISAPPEARS, which empirically only
 * happens once a real submit consumes the input (a frozen pane keeps showing
 * the marker). On the cap we re-send Enter; if every attempt fails we fall
 * through and the sentinel poll degrades to the pre-fix timeout, never worse.
 *
 * If the paste never landed (loadAndPastePrompt exhausted its retries), the
 * marker is already absent: the first predicate holds, we send a single Enter
 * and return — identical to the pre-fix single-Enter path. Note the budget here
 * (3 × {@link SUBMIT_LAND_MAX_TICKS}) stacks on loadAndPastePrompt's own, so a
 * doubly-backlogged boot can spend that much longer in setup — still bounded
 * and far below the phase cap.
 *
 * Re-sending Enter is safe, the same way loadAndPastePrompt's double-paste is:
 * we only re-send while the marker is STILL present (the prompt is unsubmitted,
 * so the input box is non-empty and the new Enter submits it). A late Enter
 * that races a just-landed submit lands on an empty input box, which the TUI
 * ignores — it never injects a stray turn into the now-active session.
 */
const submitPastedPrompt = (session: string): Effect.Effect<void, TmuxError> =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt++) {
      yield* sendEnter(session);
      yield* pollPaneUntil(capturePane(session), (pane) => !paneShowsPaste(pane), SUBMIT_LAND_MAX_TICKS);
      const pane = yield* capturePane(session);
      if (!paneShowsPaste(pane)) { return; }
      yield* Console.log(
        `[tmux ${session}] submit not delivered (attempt ${attempt}/${SUBMIT_MAX_ATTEMPTS})` +
          (attempt < SUBMIT_MAX_ATTEMPTS ? " — re-sending Enter" : " — proceeding anyway"),
      );
    }
  });

/** Bounded paste+submit attempts confirmed by the submitted-marker before failing fast. */
const DELIVER_MAX_ATTEMPTS = 2;

/** Per-attempt cap polling for the submitted-marker before re-driving the paste. */
const SUBMITTED_LAND_MAX_TICKS = 10;

/** Input for {@link deliverPrompt}. */
type DeliverPromptInput = {
  readonly session: string;
  readonly promptFile: string;
  readonly submittedPath: string;
  /**
   * The paste-then-submit side effect, injected only by tests. Defaults to the
   * live-tmux {@link loadAndPastePrompt} followed by {@link submitPastedPrompt}.
   */
  readonly drive?: Effect.Effect<void, TmuxError>;
  /**
   * The submitted-marker probe polled after each drive, injected only by tests.
   * Defaults to an `existsSync` of `submittedPath` (yields "1" once the
   * `UserPromptSubmit` hook has written it).
   */
  readonly submittedMarker?: Effect.Effect<string>;
  /** Poll interval for the marker; tests pass a tiny value to avoid real sleeps. */
  readonly interval?: Duration.DurationInput;
};

/**
 * Drive the prompt into the session and confirm it was *actually submitted*,
 * re-driving the whole paste+Enter sequence if not — then fail fast.
 *
 * {@link loadAndPastePrompt} and {@link submitPastedPrompt} each retry against
 * the collapsed-paste marker, which is blind whenever a paste lands expanded and
 * cannot tell a never-delivered paste (a dead / "Not connected" pane, issue #43)
 * from a delivered one. The `UserPromptSubmit` marker is the deterministic
 * ground truth: it appears iff a prompt was submitted, in any presentation. We
 * poll it after each full paste+submit; while it stays absent the bytes never
 * reached the application, so we re-load + re-paste + re-Enter. If it never
 * appears we fail with a {@link TmuxError} in seconds — instead of letting the
 * caller idle the entire phase budget on a boot we already know is dead (the
 * 15-min silent SessionTimedOut of #43). A successful first attempt returns
 * before any re-drive, so the healthy path never double-pastes.
 */
export const deliverPrompt = (input: DeliverPromptInput): Effect.Effect<void, TmuxError> =>
  Effect.gen(function* () {
    const { session, promptFile, submittedPath } = input;
    const drive =
      input.drive ??
      loadAndPastePrompt(session, promptFile).pipe(
        Effect.flatMap(() => submitPastedPrompt(session)),
      );
    const submittedMarker =
      input.submittedMarker ?? Effect.sync(() => (existsSync(submittedPath) ? "1" : ""));
    const interval = input.interval ?? "1 second";
    for (let attempt = 1; attempt <= DELIVER_MAX_ATTEMPTS; attempt++) {
      yield* drive;
      const submitted = yield* pollPaneUntil(
        submittedMarker,
        (s) => s === "1",
        SUBMITTED_LAND_MAX_TICKS,
        interval,
      );
      if (submitted) {
        return;
      }
      yield* Console.log(
        `[tmux ${session}] prompt not submitted (attempt ${attempt}/${DELIVER_MAX_ATTEMPTS})` +
          (attempt < DELIVER_MAX_ATTEMPTS ? " — re-driving paste" : " — boot dead, failing fast"),
      );
    }
    return yield* Effect.fail(
      new TmuxError({
        step: "deliver-prompt",
        stderr: `prompt never submitted after ${DELIVER_MAX_ATTEMPTS} paste attempts — the bytes never reached the TUI (dead or disconnected pane, #43)`,
      }),
    );
  });

/** Input for {@link bootClaudeSession}. */
type BootClaudeSessionInput = {
  readonly session: string;
  readonly tmuxLogPath: string;
  readonly promptFile: string;
  /**
   * Per-session ready-marker path. Exported into the tmux shell as
   * `AGENT_READY` so the `SessionStart` hook writes it once the TUI is up, and
   * polled by {@link waitForReadyMarker} to gate the paste — the deterministic
   * replacement for the old pane-scrape readiness heuristic (issue #76).
   */
  readonly readyPath: string;
  /**
   * Per-session submitted-marker path. Exported into the tmux shell as
   * `AGENT_SUBMITTED` so the `UserPromptSubmit` hook writes it the instant a
   * prompt is actually submitted, and polled by {@link deliverPrompt} to confirm
   * the paste reached the TUI — the deterministic delivery signal that re-drives
   * a lost paste and fails fast on a dead pane (issue #43) instead of idling the
   * whole phase budget.
   */
  readonly submittedPath: string;
  /**
   * Env vars to export into the tmux shell *before* `claude` launches. Read by
   * the Stop-hook subprocess via standard inheritance — used to dispatch to a
   * per-session sentinel path when N parallel sessions share one
   * `settings.local.json`. Single-quoted in the `export` line so spaces and
   * shell metacharacters in values are preserved verbatim.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Model alias for the `claude --model <alias>` flag. The CLI accepts
   * `haiku` / `sonnet` / `opus` — the upstream Code-Review skill warns that
   * omitting this means the session inherits the orchestrator's model, so a
   * "haiku" agent silently runs on Opus. Per-agent fan-out always sets this.
   * Optional for backward compat with the single-prompt phase runner.
   */
  readonly model?: string;
  /**
   * Absolute path to a JSON MCP config file. When set, `--strict-mcp-config`
   * and `--mcp-config <path>` are appended so the session ignores the
   * operator's global MCP config and boots only the servers in this file.
   * Omit to inherit the global config (legacy behaviour).
   */
  readonly mcpConfigPath?: string;
};

/** Shell-quote a value for safe inclusion in a single-quoted `export`. */
export const sqEscape = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Valid POSIX environment-variable identifier: letter/underscore start, alphanumeric/underscore rest. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Valid `claude --model` alias. The CLI's documented aliases are exactly
 * `haiku`, `sonnet`, `opus`; we accept the same lowercase ASCII subset to
 * prevent shell-injection through this knob. A full model identifier (e.g.
 * `claude-haiku-4-5-20251001`) also matches the regex — useful when a future
 * caller pins a specific revision.
 */
export const MODEL_ALIAS_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Build the `claude` command string for a tmux session.
 *
 * Validates `model` against {@link MODEL_ALIAS_RE}; throws if invalid so the
 * caller gets an early, clear error rather than a silent shell-injection path.
 * `mcpConfigPath` is single-quoted via {@link sqEscape} — it is a fixed asset
 * path so the extra quoting is purely defensive.
 */
export const buildClaudeCmd = (model?: string, mcpConfigPath?: string): string => {
  if (model !== undefined && !MODEL_ALIAS_RE.test(model)) {
    throw new Error(`invalid model alias: ${model}`);
  }
  const modelFlag = model !== undefined ? ` --model ${model}` : "";
  const mcpFlags =
    mcpConfigPath !== undefined
      ? ` --strict-mcp-config --mcp-config ${sqEscape(mcpConfigPath)}`
      : "";
  return `claude --dangerously-skip-permissions${modelFlag}${mcpFlags}`;
};

/**
 * Boot `claude` inside an already-created session and paste the prompt.
 * The session must already exist (see {@link createSession}); this only
 * drives it.
 */
export const bootClaudeSession = (input: BootClaudeSessionInput): Effect.Effect<void, TmuxError> =>
  Effect.gen(function* () {
    // Mirror the pane into a log file for live tailing. The path is quoted —
    // tmux runs this string through a shell, and the path may contain spaces.
    yield* tmuxStep(
      "pipe-pane",
      () => $`tmux pipe-pane -t ${input.session} -O ${`cat >> "${input.tmuxLogPath}"`}`,
    );
    // Fold AGENT_READY into the exported env so the SessionStart hook subprocess
    // inherits the per-session ready-marker path, exactly like AGENT_SENTINEL.
    // readyPath is always present, so an export line always runs.
    const env = { ...input.env, [AGENT_READY_VAR]: input.readyPath };
    for (const key of Object.keys(env)) {
      if (!ENV_KEY_RE.test(key)) {
        yield* Effect.fail(
          new TmuxError({ step: "export-env", stderr: `invalid env key: ${key}` }),
        );
      }
    }
    const exports = Object.entries(env)
      .map(([key, value]) => `export ${key}=${sqEscape(value)}`)
      .join(" && ");
    yield* tmuxStep(
      "export-env",
      () => $`tmux send-keys -t ${input.session} ${exports} Enter`,
    );
    let claudeCmd: string;
    try {
      claudeCmd = buildClaudeCmd(input.model, input.mcpConfigPath);
    } catch (err) {
      yield* Effect.fail(new TmuxError({ step: "start-claude", stderr: String(err) }));
      return;
    }
    yield* tmuxStep(
      "start-claude",
      () => $`tmux send-keys -t ${input.session} ${claudeCmd} Enter`,
    );
    yield* waitForReadyMarker(input.readyPath);
    // Load + paste the prompt and submit it, then CONFIRM via the deterministic
    // UserPromptSubmit marker that it was actually submitted — re-driving the
    // paste on a lost delivery and failing fast on a dead pane (#43) instead of
    // idling the whole phase budget. See {@link deliverPrompt}.
    yield* deliverPrompt({
      session: input.session,
      promptFile: input.promptFile,
      submittedPath: input.submittedPath,
    });
  });
