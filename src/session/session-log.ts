/**
 * Session/session-log.ts — the shared log shape for one `claude` phase session.
 *
 * Both session drivers — the tmux runner in `phase-primitives.ts` and the
 * headless runner in `headless.ts` — emit the same `session_starting` /
 * `session_verdict` / `session_failed` JSONL events and the same stdout prefix,
 * so a live `tail -f run.jsonl` and the human watching the terminal read
 * identically whichever driver is selected. The literals live here, in one
 * place, so the two drivers cannot drift the event shape apart.
 */
import type { Phase } from "../config";

/**
 * Caller-supplied context for log enrichment. Lets the JSONL log and stdout
 * lines carry the issue / iteration / agent a session is part of, without
 * coupling the drivers to the pipeline's state shape. `agent` is populated only
 * in fan-out — single-prompt phases leave it undefined and the prefix omits the
 * `/agent` tag.
 */
export type SessionLogContext = {
  readonly issueIid: number;
  readonly iteration: number;
  readonly agent?: string;
};

/** `[#42 review/correctness[2]]` — concise prefix for stdout session events. */
export const logPrefix = (phase: Phase, ctx: SessionLogContext): string => {
  const agentTag = ctx.agent === undefined ? "" : `/${ctx.agent}`;
  return `[#${ctx.issueIid} ${phase}${agentTag}[${ctx.iteration}]]`;
};

/** Common fields stamped into every JSONL session event for grep/jq replay. */
export const baseEventFields = (
  phase: Phase,
  ctx: SessionLogContext,
): Record<string, string | number> => ({
  phase,
  iteration: ctx.iteration,
  issueIid: ctx.issueIid,
  ...(ctx.agent === undefined ? {} : { agent: ctx.agent }),
});
