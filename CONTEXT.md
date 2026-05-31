# Project vocabulary

Living glossary. The architecture review skill (`matt-improve-codebase-architecture`) and any future grilling pass should use these exact terms; drift into "service", "component", "boundary" weakens the codebase's language.

Provider-specific vocabulary (Issue, PullRequestRef, Discussion, Adapter asymmetries) is documented separately in [`docs/provider-vocabulary.md`](docs/provider-vocabulary.md) — it stays there because it's also an ADR.

## Orchestrator concepts

### Phase

A unit of work the orchestrator drives through one state transition. Phases divide into two shapes:

- **Interactive Phase** — spawns a fresh `claude` tmux Session, runs a prompt, waits for a Verdict. Today: `implementation`, `review`, `evaluate`, `fix`, `qa`. These are the load-bearing Phases — each is a candidate for a deep Module.
- **Script Phase** — pure shell work, no `claude` session. Today: `open_draft_mr`, `merge`. Also setup/cleanup transitions: `fetch_queue`, `claim_issue`, `branch_worktree`, `done`, `failed`. These remain inline in the orchestrator's state machine — extracting them as Modules would be uniformity for its own sake.

A Phase Module's interface is `Effect<State, HandlerError, R>` — it runs the Phase Session, narrows the Verdict to the expected set, and resolves the next `State` itself. Post-verdict policy that depends on Phase-internal data (the `MAX_FIX_CYCLES` cap in `evaluate`, the `fixCycles` increment in `fix`) stays cohesive with the Phase that owns it; the state machine's dispatcher only routes on `state.kind`.

### Verdict

A typed token emitted by an Interactive Phase to signal what happened. Captured by a Claude Code Stop hook, written to a per-phase sentinel file, read by the orchestrator as the last non-empty line matching `^VERDICT: TOKEN$`.

Known tokens: `READY_FOR_REVIEW`, `BLOCKER_SUSPECTED`, `REVIEW_DONE`, `CONVERGED`, `NEEDS_FIX`, `FIX_DONE`, `QA_PASS`, `QA_FAIL`. Each Phase declares the subset it can emit; the state machine routes on the Verdict.

### Finding

A single issue raised by a review Agent during the `review` Phase. Line-anchored Findings (file + line + severity + confidence + analysis chain + fix prompt) are each posted as one resolvable MR Discussion; prose Findings (architectural / scope-level) collapse into one summary thread. A Finding carries its emitting Agent in the discussion body.
_Avoid_: comment, remark, issue (an Issue is the upstream work item).

### Triage

The `evaluate` Phase's per-Finding judgment — one of `real`, `real-but-bloated-remedy`, `imagined`, or a punt (`severity: suggestion` Findings → "left for a human"). `real` / `real-but-bloated-remedy` leave the Discussion unresolved for `fix` (the Finding is *accepted*); `imagined` and suggestions are resolved. Distinct from **Verdict**: a Verdict is the phase-level outcome token, a Triage is per-Finding.
_Avoid_: verdict (reserved for phase tokens), adjudication, ruling, assessment.

A run that stops short of `done` lands in exactly one of three fates — **Interruption**, **Stall**, or **Failure**. The boundary that matters is *who/what stopped it*: an external cut-off (innocent issue), the work failing to converge within its own resources (possibly-poison issue), or the agent reaching a terminal judgment. Each gets a different recovery policy. (A `PromptError` — a missing/unresolvable prompt template — is none of these: it is a *deploy bug* that crashes the whole **run**, not a fate of the issue.)

### Interruption

A run stopped by an **external or environment cut-off** — the issue is innocent. Causes: SIGTERM / Ctrl-C, `kill -9` / OOM / host crash (the process dies mid-Phase), `TmuxError`, `WorkspaceError` (a filesystem fault in the worktree/run dir), a transient git/network/API error, and an unhandled defect (`Effect.die`) that crashes the run. An Interruption returns the issue to `ready-for-agent` and is retried **for free — uncapped**: an external cut-off carries no signal that the *issue* is unworkable (an environment fault that *persists* is bounded instead by the absolute re-pick backstop, not by this fate). Detected only by the startup sweep via a dead PID lockfile (mono-host) — there is no in-process signal finalizer (a graceful SIGTERM and a hard `kill -9` both reduce to "the next sweep finds a dead PID"). Distinct from a **Stall** (the work itself failed to converge) and a **Failure** (a judgment).
_Avoid_: stall, failure, crash, abort, error.

### Stall

A run where **the work itself consumed its session without producing a verdict** — `SessionTimedOut`, `NoVerdict`, `BudgetExhausted`, an implementation that timed out with no commits to salvage, **and the agent/diff-correlated emission glitches** (`UnexpectedVerdictError`, a review router malformed twice). Unlike an **Interruption**, the issue is *not* innocent: a Stall is a weak signal the issue may be unworkable (too large, perpetual Claude-usage starvation, a diff the router keeps choking on). The classification rule is *re-runnability*: a cause that **recurs when the same work resumes** is a Stall (must be capped), not an Interruption. A Stall returns the issue to `ready-for-agent` but is **capped** — after the Nth consecutive Stall (counted in a local sidecar, mono-host) it converts to a **Failure**. The cap rations the only real waste: re-minting a fresh per-issue budget over and over (each resume mints a new `deadline`) on an issue that never converges.
_Avoid_: interruption (an external cut-off, never capped), timeout (only one of its causes).

### Failure

A run reaching a **terminal outcome the pipeline cannot resolve without a human** — either the agent *judged* and gave up (a suspected blocker `BLOCKER_SUSPECTED`, `MAX_FIX_CYCLES` exhausted, `QA_FAIL` after fixes) or a *safety refusal* (a branch reclaim refused on a #24 name collision — not a judgment, but equally terminal). Also the terminal landing of a capped **Stall**. A Failure carries `failed-by-agent`, needs a human, and is **never** retried automatically. A human re-queue (`failed-by-agent` → `ready-for-agent`) clears the Stall count and starts fresh.
_Avoid_: interruption, stall (both recoverable; Failure is terminal).

### Session

The mechanism a Phase uses to run a single `claude` invocation in isolation: spawn a tmux session with the rendered prompt, register a Stop hook (`src/session/stop-hook.ts`) that writes the last assistant message to a sentinel **iff `stop_reason === "end_turn"`** (or the event is `StopFailure`), poll the sentinel, parse the Verdict, kill the tmux. On any other `stop_reason` the hook emits `{"decision":"block"}` on stdout so Claude Code resumes the agent loop instead of stopping prematurely — that branch is what catches mid-turn Stops while subagents or `tool_use` rounds are still in flight (see #29). The Session Module hides tmux/sentinel/verdict-parsing behind a small interface; the Phase only sees `runPhaseSession(input, expected) → Effect<V, PhaseError, RunArtifacts>`, where `V extends VerdictToken` is narrowed to the expected set and an off-set verdict fails with `UnexpectedVerdictError`.

A Session is per-Phase — there is no long-lived Session across Phases. Each Phase mints one.

### RunArtifacts

The set of per-run filesystem paths: the run directory, per-phase sentinel files, tmux log files, prompt files, the `run.jsonl` log. Exposed as an Effect service so tests can route writes into a temp dir. Shallow by design (it's a path container); listed here because callers (Phase, Session, machine) reference it across multiple files.

### Provider

The seam between the orchestrator and a forge (GitLab today; the GitHub adapter is deferred). Defined in [`src/provider/provider.ts`](src/provider/provider.ts) as an Effect `Context.Tag`. Domain vocabulary (Issue, PullRequestRef, Discussion, DiscussionId, …) lives in [`src/provider/types.ts`](src/provider/types.ts) and is documented at length in [`docs/provider-vocabulary.md`](docs/provider-vocabulary.md). Tests inject a fake Provider via `Layer.succeed(GitProvider, fake)` — that's the seam's primary justification today (see ADR §3.2 + addendum).

### Position

The provider-neutral anchor a line-anchored Finding rides on when posted: `{ file, line }` on the new side of the diff. `postDiscussion` carries it as an optional argument; each Adapter resolves the forge-specific payload internally — GitLab fetches the MR's `diff_refs` (`base/head/start_sha`, a net-new read, memoized per IID), GitHub uses the head commit. A forge that rejects the anchor (the line is outside the diff) falls back to a general resolvable Discussion with `file:line` kept in the body. SHAs never cross the seam — `start_sha` is GitLab-only and meaningless to GitHub (see ADR 0003).
_Avoid_: anchor, location, coordinates, side.

## Architecture vocabulary

These are the words used to evaluate design — borrow them when discussing trade-offs:

- **Module** — anything with an interface and an implementation (function, class, package, slice).
- **Interface** — everything a caller must know to use the module: types, invariants, error modes, ordering, config.
- **Depth** — leverage at the interface: a lot of behaviour behind a small interface. Deep modules are the goal; shallow modules (interface ≈ implementation) are the smell.
- **Seam** — the place an interface lives; where behaviour can be altered without editing in place.
- **Adapter** — a concrete implementation at a Seam. The heuristic: *1 adapter = hypothetical seam, 2 adapters = real seam*. Documented exception: the Provider Seam pays its place today via the test path (see ADR §3.2 addendum).
- **Locality** — when one thing changes, one place changes.
- **Deletion test** — if I delete this module, does its complexity vanish (pass-through, drop it) or reappear concentrated in N callers (it was earning its keep)?
