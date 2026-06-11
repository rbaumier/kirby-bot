import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { Effect, Fiber, Option, Ref, TestClock, TestContext } from "effect";
import {
  buildClaudeCmd,
  deliverPrompt,
  ENV_KEY_RE,
  MODEL_ALIAS_RE,
  paneShowsPaste,
  paneShowsUsageLimit,
  pollPaneUntil,
  repromptForVerdict,
  sqEscape,
  verdictReminder,
  TUI_PASTE_MARKER,
  USAGE_LIMIT_CONFIRM_MARKER,
  USAGE_LIMIT_STOP_MARKER,
  waitForReadyMarker,
} from "./tmux";

/** The ready-marker existence predicate `waitForReadyMarker` polls with. */
const markerReady = (s: string): boolean => s === "1";

describe("sqEscape", () => {
  it("wraps a normal string in single quotes", () => {
    expect(sqEscape("normal")).toBe("'normal'");
  });

  it("escapes an embedded single quote via '\\''", () => {
    expect(sqEscape("it's")).toBe("'it'\\''s'");
  });

  it("escapes two consecutive embedded single quotes", () => {
    expect(sqEscape("''")).toBe("''\\'''\\'''");
  });

  it("preserves spaces in paths without escaping them", () => {
    expect(sqEscape("/tmp/path with spaces/sentinel.flag")).toBe(
      "'/tmp/path with spaces/sentinel.flag'",
    );
  });

  it("round-trips an empty string as two single quotes", () => {
    expect(sqEscape("")).toBe("''");
  });
});

describe("ENV_KEY_RE", () => {
  it("accepts a valid POSIX identifier", () => {
    expect(ENV_KEY_RE.test("AGENT_SENTINEL")).toBe(true);
  });

  it("rejects a key containing shell metacharacters", () => {
    expect(ENV_KEY_RE.test("FOO=bar; echo hax")).toBe(false);
  });

  it("rejects a key starting with a digit", () => {
    expect(ENV_KEY_RE.test("1FOO")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(ENV_KEY_RE.test("")).toBe(false);
  });
});

describe("MODEL_ALIAS_RE", () => {
  it("accepts the three CLI aliases", () => {
    expect(MODEL_ALIAS_RE.test("haiku")).toBe(true);
    expect(MODEL_ALIAS_RE.test("sonnet")).toBe(true);
    expect(MODEL_ALIAS_RE.test("opus")).toBe(true);
  });

  it("accepts a full model identifier with hyphens", () => {
    expect(MODEL_ALIAS_RE.test("claude-haiku-4-5-20251001")).toBe(true);
  });

  it("rejects shell metacharacters", () => {
    expect(MODEL_ALIAS_RE.test("haiku; echo pwned")).toBe(false);
    expect(MODEL_ALIAS_RE.test("haiku && rm")).toBe(false);
    expect(MODEL_ALIAS_RE.test("haiku$(whoami)")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(MODEL_ALIAS_RE.test("")).toBe(false);
  });
});

describe("buildClaudeCmd", () => {
  it("returns base command when no model or mcpConfigPath", () => {
    expect(buildClaudeCmd()).toBe("claude --dangerously-skip-permissions");
  });

  it("appends --model flag when model is provided", () => {
    expect(buildClaudeCmd("haiku")).toBe("claude --dangerously-skip-permissions --model haiku");
  });

  it("appends --strict-mcp-config and --mcp-config when mcpConfigPath is provided", () => {
    const cmd = buildClaudeCmd(undefined, "/assets/mcp/phase.json");
    expect(cmd).toContain("--strict-mcp-config");
    expect(cmd).toContain("--mcp-config");
    expect(cmd).toContain("/assets/mcp/phase.json");
  });

  it("includes both model and mcp flags together", () => {
    const cmd = buildClaudeCmd("haiku", "/assets/mcp/phase.json");
    expect(cmd).toContain("--model haiku");
    expect(cmd).toContain("--strict-mcp-config");
    expect(cmd).toContain("--mcp-config");
    expect(cmd).toContain("/assets/mcp/phase.json");
  });

  it("single-quotes paths with spaces in mcp-config", () => {
    const cmd = buildClaudeCmd(undefined, "/path with spaces/phase.json");
    expect(cmd).toContain("--mcp-config '/path with spaces/phase.json'");
  });

  it("throws for an invalid model alias (shell metacharacters)", () => {
    expect(() => buildClaudeCmd("haiku; echo pwned")).toThrow("invalid model alias");
  });

  it("throws for an empty model alias", () => {
    expect(() => buildClaudeCmd("")).toThrow("invalid model alias");
  });
});

describe("paneShowsPaste", () => {
  it("detects a collapsed paste marker", () => {
    const pane = [
      "╭─────────────────────────────────╮",
      "│ > [Pasted text #1 +312 lines]   │",
      "╰─────────────────────────────────╯",
    ].join("\n");
    expect(paneShowsPaste(pane)).toBe(true);
  });

  it("returns false for an empty input area showing the placeholder", () => {
    const pane = [
      "╭─────────────────────────────────╮",
      '│ > Try "fix typecheck errors"    │',
      "╰─────────────────────────────────╯",
    ].join("\n");
    expect(paneShowsPaste(pane)).toBe(false);
  });

  it("returns false for an empty pane (capture failure)", () => {
    expect(paneShowsPaste("")).toBe(false);
  });

  it("keys off the exported marker constant", () => {
    expect(paneShowsPaste(`prefix ${TUI_PASTE_MARKER} #2 +9 lines] suffix`)).toBe(true);
  });
});

describe("paneShowsUsageLimit", () => {
  /** A captured per-model (`Sonnet`) usage-limit dialog, header still in frame. */
  const sonnetLimitDialog = [
    "⎿  You've hit your Sonnet limit · resets Jun 1 at 2am (Europe/Paris)",
    "   What do you want to do?",
    " ❯ 1. Stop and wait for limit to reset",
    "   2. Switch to usage credits",
    "   3. Switch to Team plan",
    " Enter to confirm · Esc to cancel",
  ].join("\n");

  /** The 5-hour rolling-window (`session`) variant — different header wording. */
  const sessionLimitDialog = [
    "⎿  You've hit your session limit · resets Jun 1 at 2am (Europe/Paris)",
    "   What do you want to do?",
    " ❯ 1. Stop and wait for limit to reset",
    "   2. Switch to usage credits",
    "   3. Switch to Team plan",
    " Enter to confirm · Esc to cancel",
  ].join("\n");

  /** The option block with the header scrolled out (~15% of frozen captures). */
  const headerlessDialog = [
    " ❯ 1. Stop and wait for limit to reset",
    "   2. Switch to usage credits",
    "   3. Switch to Team plan",
    " Enter to confirm · Esc to cancel",
  ].join("\n");

  it("detects the per-model (Sonnet) limit dialog", () => {
    expect(paneShowsUsageLimit(sonnetLimitDialog)).toBe(true);
  });

  it("detects the 5-hour session limit dialog (not keyed on a model name)", () => {
    expect(paneShowsUsageLimit(sessionLimitDialog)).toBe(true);
  });

  it("detects the dialog even when the header has scrolled out", () => {
    expect(paneShowsUsageLimit(headerlessDialog)).toBe(true);
  });

  it("returns false for the ready prompt", () => {
    const pane = [
      "╭─────────────────────────────────╮",
      '│ > Try "fix typecheck errors"    │',
      "╰─────────────────────────────────╯",
    ].join("\n");
    expect(paneShowsUsageLimit(pane)).toBe(false);
  });

  it("returns false for a delivered paste marker", () => {
    expect(paneShowsUsageLimit(`│ > ${TUI_PASTE_MARKER} #1 +312 lines]   │`)).toBe(false);
  });

  it("returns false for normal agent output", () => {
    expect(paneShowsUsageLimit("Running tests… 42 pass, 0 fail")).toBe(false);
  });

  it("returns false for an empty pane (capture failure)", () => {
    expect(paneShowsUsageLimit("")).toBe(false);
  });

  it("requires BOTH option markers, not either alone", () => {
    expect(paneShowsUsageLimit(USAGE_LIMIT_STOP_MARKER)).toBe(false);
    expect(paneShowsUsageLimit(USAGE_LIMIT_CONFIRM_MARKER)).toBe(false);
    expect(
      paneShowsUsageLimit(`${USAGE_LIMIT_STOP_MARKER}\n${USAGE_LIMIT_CONFIRM_MARKER}`),
    ).toBe(true);
  });
});

describe("pollPaneUntil", () => {
  /** Build a capture Effect that replays `frames` one per tick (last sticks). */
  const scriptedCapture = (frames: readonly string[]) =>
    Ref.make(0).pipe(
      Effect.map((cursor) =>
        Ref.getAndUpdate(cursor, (i) => Math.min(i + 1, frames.length - 1)).pipe(
          Effect.map((i) => frames[i] ?? ""),
        ),
      ),
    );

  it("returns ready once the marker appears after absent frames", async () => {
    const ready = await Effect.runPromise(
      scriptedCapture(["", "", "", "1"]).pipe(
        Effect.flatMap((capture) => pollPaneUntil(capture, markerReady, 20, "1 millis")),
      ),
    );
    expect(ready).toBe(true);
  });

  it("stops polling at the marker frame, not before or after", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const frames = ["", "", "1", "1"];
        const capture = Ref.getAndUpdate(calls, (n) => n + 1).pipe(
          Effect.map((n) => frames[Math.min(n, frames.length - 1)] ?? ""),
        );
        const ready = yield* pollPaneUntil(capture, markerReady, 20, "1 millis");
        return { ready, ticks: yield* Ref.get(calls) };
      }),
    );
    expect(result.ready).toBe(true);
    expect(result.ticks).toBe(3); // two absent ticks + the marker frame, then stop
  });

  it("caps out (best-effort fallback) when the marker never appears", async () => {
    const ready = await Effect.runPromise(
      scriptedCapture(["", "", ""]).pipe(
        Effect.flatMap((capture) => pollPaneUntil(capture, markerReady, 5, "1 millis")),
      ),
    );
    expect(ready).toBe(false);
  });
});

describe("waitForReadyMarker under a virtual clock", () => {
  it("keeps polling while the marker is absent, then resolves once it appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kirby-ready-"));
    const readyPath = join(dir, "sentinel.flag.ready");
    try {
      const keptPolling = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(waitForReadyMarker(readyPath));
          // A few ticks with the marker absent: the poll must NOT have resolved.
          yield* TestClock.adjust("3 seconds");
          const stillRunning = Option.isNone(yield* Fiber.poll(fiber));
          // The SessionStart hook writes the marker; the next tick observes it.
          writeFileSync(readyPath, "ready");
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(fiber);
          return stillRunning;
        }).pipe(Effect.provide(TestContext.TestContext)),
      );
      expect(keptPolling).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns (does not hang) when the marker never appears within the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kirby-ready-"));
    const readyPath = join(dir, "never.ready");
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(waitForReadyMarker(readyPath));
          // Advance to the 60-tick cap; the poll must terminate on its own.
          yield* TestClock.adjust("60 seconds");
          return yield* Fiber.join(fiber);
        }).pipe(Effect.provide(TestContext.TestContext)),
      );
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deliverPrompt", () => {
  /**
   * Inject a drive spy that counts paste+submit invocations and a marker probe
   * that yields "1" (submitted) only once the paste has been driven `landsOn`
   * times — modelling a lost paste that the Nth re-drive finally lands.
   */
  const spied = (landsOn: number) =>
    Ref.make(0).pipe(
      Effect.map((drives) => ({
        drives,
        drive: Ref.update(drives, (n) => n + 1),
        submittedMarker: Ref.get(drives).pipe(Effect.map((n) => (n >= landsOn ? "1" : ""))),
      })),
    );

  const run = (landsOn: number) =>
    spied(landsOn).pipe(
      Effect.flatMap((spy) =>
        deliverPrompt({
          session: "s",
          promptFile: "/tmp/p",
          submittedPath: "/tmp/p.submitted",
          drive: spy.drive,
          submittedMarker: spy.submittedMarker,
          interval: "1 millis",
        }).pipe(
          Effect.either,
          Effect.flatMap((result) =>
            Ref.get(spy.drives).pipe(Effect.map((drives) => ({ result, drives }))),
          ),
        ),
      ),
    );

  it("returns without re-driving when the marker appears on the first attempt", async () => {
    const { result, drives } = await Effect.runPromise(run(1));
    expect(result._tag).toBe("Right");
    expect(drives).toBe(1);
  });

  it("re-drives the paste and succeeds once the marker then appears", async () => {
    const { result, drives } = await Effect.runPromise(run(2));
    expect(result._tag).toBe("Right");
    expect(drives).toBe(2);
  });

  it("fails fast with a deliver-prompt TmuxError when the marker never appears", async () => {
    // landsOn is unreachable (> DELIVER_MAX_ATTEMPTS), so every poll caps out absent.
    const { result, drives } = await Effect.runPromise(run(99));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.step).toBe("deliver-prompt");
    }
    expect(drives).toBe(2); // DELIVER_MAX_ATTEMPTS — bounded, no infinite re-drive
  });
});

describe("verdictReminder", () => {
  it("spells out every expected token as a full verdict line", () => {
    // A live implementation session re-emitted `VERDICT: SUCCESS` after the
    // generic nudge — the reminder must name the accepted tokens explicitly.
    const reminder = verdictReminder(["READY_FOR_REVIEW", "BLOCKER_SUSPECTED"]);
    expect(reminder).toContain("`VERDICT: READY_FOR_REVIEW`");
    expect(reminder).toContain("`VERDICT: BLOCKER_SUSPECTED`");
    expect(reminder).not.toContain("\n"); // single keystroke string, no newline
  });

  it("falls back to the generic wording when no expected set is known", () => {
    expect(verdictReminder([])).toContain("`VERDICT: TOKEN`");
  });
});

describe("repromptForVerdict", () => {
  /**
   * Count Enter presses and yield the submitted-marker only once `landsOn`
   * presses have been sent — modelling the dropped-Enter race (#30) that left
   * three Planners' reminders sitting unsubmitted for their whole budget.
   */
  const run = (landsOn: number) =>
    Ref.make(0).pipe(
      Effect.flatMap((enters) =>
        repromptForVerdict({
          session: "s",
          submittedPath: "/tmp/never.submitted",
          typeReminder: Effect.void,
          pressEnter: Ref.update(enters, (n) => n + 1),
          submittedMarker: Ref.get(enters).pipe(Effect.map((n) => (n >= landsOn ? "1" : ""))),
          interval: "1 millis",
        }).pipe(Effect.flatMap(() => Ref.get(enters))),
      ),
    );

  it("returns after a single Enter when the marker appears", async () => {
    expect(await Effect.runPromise(run(1))).toBe(1);
  });

  it("re-sends Enter until the marker confirms the submit", async () => {
    expect(await Effect.runPromise(run(2))).toBe(2);
  });

  it("gives up best-effort after the bounded attempts when the marker never appears", async () => {
    // landsOn is unreachable; the caller's sentinel re-poll handles the rest.
    expect(await Effect.runPromise(run(99))).toBe(3); // REPROMPT_MAX_ATTEMPTS
  });

  it("clears the initial prompt's stale marker instead of reading it as submitted", async () => {
    // The marker on disk was written when the INITIAL prompt was submitted. If
    // the reprompt trusted it, the confirmation would pass instantly on a
    // dropped Enter — the exact freeze this function exists to prevent. With
    // the stale file cleared and no hook to rewrite it, all bounded attempts
    // must run (default existsSync probe, real fs).
    const dir = mkdtempSync(join(tmpdir(), "kirby-reprompt-"));
    const submittedPath = join(dir, "sentinel.flag.submitted");
    writeFileSync(submittedPath, "submitted");
    try {
      const enters = await Effect.runPromise(
        Ref.make(0).pipe(
          Effect.flatMap((count) =>
            repromptForVerdict({
              session: "s",
              submittedPath,
              typeReminder: Effect.void,
              pressEnter: Ref.update(count, (n) => n + 1),
              interval: "1 millis",
            }).pipe(Effect.flatMap(() => Ref.get(count))),
          ),
        ),
      );
      expect(enters).toBe(3); // stale marker ignored — every attempt ran
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
