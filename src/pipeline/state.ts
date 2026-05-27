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
 * Every node of the pipeline.
 *
 * The machine starts at `fetch_queue` and terminates at `end`.
 * `failed` is reachable from any node.
 * Both `done` and `failed` loop back to `fetch_queue`.
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
      readonly kind: "implementation";
      readonly issue: IssueRef;
      readonly branch: string;
      readonly worktree: string;
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
  | {
      readonly kind: "failed";
      readonly issue: IssueRef;
      readonly branch: string | null;
      readonly worktree: string | null;
      readonly pullRequestIid: number | null;
      readonly fixCycles: number | null;
      readonly reason: string;
    }
  | { readonly kind: "end" };
