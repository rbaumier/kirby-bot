/**
 * Pipeline/resume.ts — the two pure decisions behind Phase-resume (#73).
 *
 * `checkpointAfter` decides which resume checkpoint (if any) a transition should
 * persist; `resumeStateFor` maps a read-back checkpoint to the State a resumed
 * `open_draft_mr` re-enters. Both are pure — `machine.ts` and `onOpenDraftMr`
 * wrap them with the fs writes / reads and logging. Keeping the routing here
 * makes it testable without a RunStore or a provider (mirrors the
 * sidecar-policy / sidecar split).
 */
import type { Checkpoint } from "../recovery/checkpoint";
import type { PipelineContext, State } from "./state";

/**
 * The checkpoint a transition `from → next` should persist, or `null` to leave
 * the current one untouched.
 *
 * - `implementation → open_draft_mr` marks "implementation finished or salvaged"
 *   — the marker `onBranchPush` reads to skip re-implementation. The
 *   `branch_push → open_draft_mr` resume edge writes nothing: writing the marker
 *   there would downgrade a more-advanced checkpoint and misroute `onOpenDraftMr`.
 * - Entering an interactive Phase records that Phase plus its fix-cycle count
 *   (so the `review ⇄ fix` loop resumes with the right `MAX_FIX_CYCLES` budget).
 * - Every other `next` (queue / branch states, `merge`, terminal states) writes
 *   nothing: `merge` has no resumable checkpoint, and terminal states clear it.
 */
export const checkpointAfter = (from: State, next: State): Checkpoint | null => {
  switch (next.kind) {
    case "open_draft_mr": {
      return from.kind === "implementation" ? { phase: "open_draft_mr", fixCycles: 0 } : null;
    }
    case "review":
    case "evaluate":
    case "fix":
    case "qa": {
      return { phase: next.kind, fixCycles: next.fixCycles };
    }
    default: {
      return null;
    }
  }
};

/**
 * The State a resumed `open_draft_mr` re-enters, given the read-back checkpoint
 * and the reconstructed pipeline context. No checkpoint, or only the
 * "implementation finished" marker → start the review cycle from scratch
 * (`fixCycles: 0`). A Phase checkpoint → resume that Phase with its count.
 */
export const resumeStateFor = (
  checkpoint: Checkpoint | null,
  ctx: PipelineContext,
): State => {
  if (checkpoint === null || checkpoint.phase === "open_draft_mr") {
    return { kind: "review", ...ctx, fixCycles: 0 };
  }
  const { fixCycles } = checkpoint;
  switch (checkpoint.phase) {
    case "review": {
      return { kind: "review", ...ctx, fixCycles };
    }
    case "evaluate": {
      return { kind: "evaluate", ...ctx, fixCycles };
    }
    case "fix": {
      return { kind: "fix", ...ctx, fixCycles };
    }
    case "qa": {
      return { kind: "qa", ...ctx, fixCycles };
    }
  }
};
