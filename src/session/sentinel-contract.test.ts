/**
 * Sentinel-contract.test.ts — proves the two ends of the Verdict-capture
 * contract agree. The unit cases pin the shape of the merged hook fragment; the
 * round-trip case takes what {@link writeStopHookConfig} *writes* into
 * `settings.local.json`, runs that exact command through a shell with only
 * `$AGENT_SENTINEL` exported, and asserts the Stop hook *reads* the same path
 * and writes the Verdict there. Nothing else links config-write to hook-read —
 * before this test, a typo in the env-var name, the script path, or the argv
 * position would break capture silently.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, test } from "bun:test";
import { Effect } from "effect";
import { writeStopHookConfig } from "./phase-primitives";
import {
  AGENT_READY_VAR,
  AGENT_SENTINEL_VAR,
  AGENT_SUBMITTED_VAR,
  sessionStartHookCommand,
  sessionStartHookSettings,
  STOP_HOOK_EVENTS,
  STOP_HOOK_SCRIPT,
  stopHookCommand,
  stopHookSettings,
  userPromptSubmitHookCommand,
  userPromptSubmitHookSettings,
} from "./sentinel-contract";

describe("stopHookSettings / stopHookCommand", () => {
  it("registers the same handler for every owned event", () => {
    const settings = stopHookSettings();
    expect(Object.keys(settings).sort()).toEqual([...STOP_HOOK_EVENTS].sort());
    for (const event of STOP_HOOK_EVENTS) {
      expect(settings[event]?.[0]?.hooks?.[0]?.command).toBe(stopHookCommand());
    }
  });

  it("references the env-var name and the script path (no drift between wires)", () => {
    const command = stopHookCommand();
    expect(command).toContain(`"$${AGENT_SENTINEL_VAR}"`);
    expect(command).toContain(STOP_HOOK_SCRIPT);
  });
});

describe("sessionStartHookSettings / sessionStartHookCommand", () => {
  it("registers a single SessionStart event running the readiness command", () => {
    const settings = sessionStartHookSettings();
    expect(Object.keys(settings)).toEqual(["SessionStart"]);
    expect(settings.SessionStart?.[0]?.hooks?.[0]?.command).toBe(sessionStartHookCommand());
  });

  it("references the env-var name (no drift between wires)", () => {
    expect(sessionStartHookCommand()).toContain(`"$${AGENT_READY_VAR}"`);
  });
});

describe("userPromptSubmitHookSettings / userPromptSubmitHookCommand", () => {
  it("registers a single UserPromptSubmit event running the submitted-marker command", () => {
    const settings = userPromptSubmitHookSettings();
    expect(Object.keys(settings)).toEqual(["UserPromptSubmit"]);
    expect(settings.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe(userPromptSubmitHookCommand());
  });

  it("references the env-var name (no drift between wires)", () => {
    expect(userPromptSubmitHookCommand()).toContain(`"$${AGENT_SUBMITTED_VAR}"`);
  });
});

describe("round-trip: UserPromptSubmit command writes the submitted marker at $AGENT_SUBMITTED", () => {
  test("executing the command with AGENT_SUBMITTED set writes the marker at that path", () => {
    const run = mkdtempSync(join(tmpdir(), "kirby-submitted-roundtrip-"));
    try {
      const submittedPath = join(run, "sentinel.flag.submitted");
      // Run the command verbatim through a shell with only AGENT_SUBMITTED
      // exported — exactly how Claude Code invokes the UserPromptSubmit hook. If
      // the command's `$AGENT_SUBMITTED` reference drifted from the env-var name
      // we export, the marker stays absent and deliverPrompt's submit-confirmation
      // (#30) would mis-fire — this fails first.
      const result = spawnSync("sh", ["-c", userPromptSubmitHookCommand()], {
        encoding: "utf8",
        env: { ...process.env, [AGENT_SUBMITTED_VAR]: submittedPath },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(submittedPath, "utf8")).toBe("submitted");
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  });
});

describe("round-trip: SessionStart command writes the ready marker at $AGENT_READY", () => {
  test("executing the command with AGENT_READY set writes the marker at that path", () => {
    const run = mkdtempSync(join(tmpdir(), "kirby-ready-roundtrip-"));
    try {
      const readyPath = join(run, "sentinel.flag.ready");
      // Run the command verbatim through a shell with only AGENT_READY exported
      // — exactly how Claude Code invokes the SessionStart hook. If the
      // command's `$AGENT_READY` reference drifted from the env-var name we
      // export, the marker stays absent and this fails.
      const result = spawnSync("sh", ["-c", sessionStartHookCommand()], {
        encoding: "utf8",
        env: { ...process.env, [AGENT_READY_VAR]: readyPath },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(readyPath, "utf8")).toBe("ready");
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  });
});

describe("round-trip: config written ⇒ values read by the hook", () => {
  type Settings = {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  const readStopCommand = async (worktree: string): Promise<string> => {
    const raw = await readFile(join(worktree, ".claude", "settings.local.json"), "utf8");
    const settings = JSON.parse(raw) as Settings;
    const command = settings.hooks.Stop?.[0]?.hooks?.[0]?.command;
    if (command === undefined) {
      throw new Error("written settings has no Stop hook command");
    }
    return command;
  };

  test("the command writeStopHookConfig writes captures the Verdict at $AGENT_SENTINEL", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "kirby-roundtrip-"));
    const run = mkdtempSync(join(tmpdir(), "kirby-roundtrip-run-"));
    try {
      await Effect.runPromise(writeStopHookConfig("implementation", worktree));
      const command = await readStopCommand(worktree);

      // The hook reads the transcript pointed at by the Stop payload's
      // transcript_path; feed it one end_turn assistant message.
      const sentinel = join(run, "sentinel.flag");
      const transcript = join(run, "transcript.jsonl");
      const verdict = "VERDICT: READY_FOR_REVIEW";
      writeFileSync(
        transcript,
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: verdict }], stop_reason: "end_turn" },
        }),
      );
      const payload = JSON.stringify({ hook_event_name: "Stop", transcript_path: transcript });

      // Run the *written* command verbatim through a shell, with only
      // AGENT_SENTINEL exported — exactly how Claude Code invokes it. If the
      // command's `$AGENT_SENTINEL` reference, the script path, or the argv
      // position drifted from the env-var name we export, the sentinel stays
      // empty and this fails.
      const result = spawnSync("sh", ["-c", command], {
        input: payload,
        encoding: "utf8",
        env: { ...process.env, [AGENT_SENTINEL_VAR]: sentinel },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(sentinel, "utf8")).toBe(verdict);
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(run, { recursive: true, force: true });
    }
  });

  test("also registers the UserPromptSubmit submitted-marker hook (3 events merged, none clobbered)", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "kirby-roundtrip-ups-"));
    try {
      await Effect.runPromise(writeStopHookConfig("implementation", worktree));
      const raw = await readFile(join(worktree, ".claude", "settings.local.json"), "utf8");
      const settings = JSON.parse(raw) as Settings;
      expect(settings.hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toBe(
        userPromptSubmitHookCommand(),
      );
      // The pre-existing Stop / SessionStart events must survive the merge.
      expect(settings.hooks.Stop?.[0]?.hooks?.[0]?.command).toBe(stopHookCommand());
      expect(settings.hooks.SessionStart?.[0]?.hooks?.[0]?.command).toBe(sessionStartHookCommand());
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
