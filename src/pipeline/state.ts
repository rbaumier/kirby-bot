/**
 * Pipeline/state.ts — the orchestrator's state machine, as data.
 *
 * `State` is a discriminated union with one variant per pipeline node.
 * Each variant carries exactly the data that node needs, nothing more.
 * The type system proves a handler can never read a field that is not
 * there yet (no `pullRequestIid` before the PR is opened, for instance).
 *
 * Pure type declarations — no logic, no imports.
 */

/** A provider issue, reduced to what the pipeline actually uses. */
export type IssueRef = {
  /** The project-scoped issue number (shown as `#42`). */
  readonly iid: number;
  readonly title: string;
  /** The issue description, or the empty string if it had none. */
  readonly body: string;
};

/** A wall-clock instant (epoch milliseconds) past which an issue is over budget. */
export type Deadline = number;

/**
 * The data every node from `open_draft_mr` onward shares.
 * Includes the issue, branch, worktree, budget deadline, and PR iid.
 */
export type PipelineContext = {
  readonly issue: IssueRef;
  readonly branch: string;
  readonly worktree: string;
  readonly deadline: Deadline;
  readonly pullRequestIid: number;
};

/**
 * The fields every end-of-attempt state (`failed` / `stalled` / `interrupted`)
 * shares. Reconstructed from the current node by `endFieldsOf` — the seam routes
 * a `HandlerError` onto one of the three by its `fate` (ADR 0004).
 */
export type EndStateFields = {
  readonly issue: IssueRef;
  readonly branch: string | null;
  readonly worktree: string | null;
  readonly pullRequestIid: number | null;
  readonly fixCycles: number | null;
  readonly reason: string;
  /**
   * The typed `_tag` of the failure cause (`SessionTimedOut`, `ProviderHttpError`,
   * `TmuxError`, …), or `null` when the failure carried no typed cause. The
   * machine-readable companion to `reason`: the seam copies it off
   * `HandlerError.errorType` and `machine.ts` logs it on the `transition` event
   * so `run.jsonl` analytics can group failures by type without parsing prose.
   */
  readonly errorType: string | null;
};

/**
 * Every node of the pipeline.
 *
 * The machine starts at `fetch_queue` and terminates at `end`.
 * `failed` / `stalled` / `interrupted` are reachable from any node.
 * `done`, `failed`, `stalled`, and `interrupted` all loop back to `fetch_queue`.
 */
export type State =
  | { readonly kind: "fetch_queue" }
  | { readonly kind: "claim_issue"; readonly issue: IssueRef }
  | { readonly kind: "branch_create"; readonly issue: IssueRef }
  | {
      readonly kind: "branch_push";
      readonly issue: IssueRef;
      readonly branch: string;
      readonly worktree: string;
    }
  | {
      readonly kind: "plan";
      readonly issue: IssueRef;
      readonly branch: string;
      readonly worktree: string;
    }
  | {
      readonly kind: "implementation";
      readonly issue: IssueRef;
      readonly branch: string;
      readonly worktree: string;
      /**
       * The approach the `plan` phase vetted and the in-session reviewer
       * approved, threaded forward so the implementer follows the agreed plan
       * instead of re-planning from scratch (#75).
       */
      readonly plan: string;
    }
  | {
      readonly kind: "open_draft_mr";
      readonly issue: IssueRef;
      readonly branch: string;
      readonly worktree: string;
      readonly deadline: Deadline;
    }
  | ({ readonly kind: "review" } & PipelineContext & { readonly fixCycles: number })
  | ({ readonly kind: "evaluate" } & PipelineContext & { readonly fixCycles: number })
  | ({ readonly kind: "fix" } & PipelineContext & { readonly fixCycles: number })
  | ({ readonly kind: "qa" } & PipelineContext & { readonly fixCycles: number })
  | ({ readonly kind: "merge" } & PipelineContext)
  | {
      readonly kind: "done";
      readonly issue: IssueRef;
      readonly worktree: string;
      readonly pullRequestIid: number;
    }
  | ({ readonly kind: "failed" } & EndStateFields)
  | ({ readonly kind: "stalled" } & EndStateFields)
  | ({ readonly kind: "interrupted" } & EndStateFields & {
      /**
       * When this interruption was a Claude usage-limit hit, the captured
       * "resets <date> at <time> (<tz>)" substring; the orchestrator parses it
       * and backs off until the limit returns before the next `fetch_queue`
       * (#78). `null` for every other interruption cause. Populated by the seam
       * from `HandlerError.usageLimitResetText`, which #77's detection sets.
       */
      readonly usageLimitResetText: string | null;
    })
  | { readonly kind: "end" };
