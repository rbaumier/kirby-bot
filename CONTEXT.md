# Project vocabulary

Living glossary. The architecture review skill (`matt-improve-codebase-architecture`) and any future grilling pass should use these exact terms; drift into "service", "component", "boundary" weakens the codebase's language.

Provider-specific vocabulary (Issue, PullRequestRef, Discussion, Adapter asymmetries) is documented separately in [`docs/provider-vocabulary.md`](docs/provider-vocabulary.md) — it stays there because it's also an ADR.

## Orchestrator concepts

### Phase

A unit of work the orchestrator drives through one state transition. Phases divide into two shapes:

- **Interactive Phase** — spawns a fresh `claude` tmux Session, runs a prompt, waits for a Verdict. Today: `run_impl`, `review`, `evaluate`, `fix`, `run_dogfood`. These are the load-bearing Phases — each is a candidate for a deep Module.
- **Script Phase** — pure shell work, no `claude` session. Today: `open_draft_mr`, `merge`. Also setup/cleanup transitions: `fetch_queue`, `claim_issue`, `branch_worktree`, `done`, `failed`. These remain inline in the orchestrator's state machine — extracting them as Modules would be uniformity for its own sake.

A Phase Module's interface is `Effect<State, HandlerError, R>` — it runs the Phase Session, narrows the Verdict to the expected set, and resolves the next `State` itself. Post-verdict policy that depends on Phase-internal data (the `MAX_FIX_CYCLES` cap in `evaluate`, the `fixCycles` increment in `fix`) stays cohesive with the Phase that owns it; the state machine's dispatcher only routes on `state.kind`.

### Verdict

A typed token emitted by an Interactive Phase to signal what happened. Captured by a Claude Code Stop hook, written to a per-phase sentinel file, read by the orchestrator as the last non-empty line matching `^VERDICT: TOKEN$`.

Known tokens: `READY_FOR_REVIEW`, `BLOCKER_SUSPECTED`, `REVIEW_DONE`, `CONVERGED`, `NEEDS_FIX`, `FIX_DONE`, `DOGFOOD_PASS`, `DOGFOOD_FAIL`. Each Phase declares the subset it can emit; the state machine routes on the Verdict.

### Session

The mechanism a Phase uses to run a single `claude` invocation in isolation: spawn a tmux session with the rendered prompt, register a Stop hook that writes the last assistant message to a sentinel, poll the sentinel, parse the Verdict, kill the tmux. The Session Module hides tmux/sentinel/verdict-parsing behind a small interface; the Phase only sees `run(prompt, timeout, allowedVerdicts) → Effect<Verdict, SessionError>`.

A Session is per-Phase — there is no long-lived Session across Phases. Each Phase mints one.

### RunArtifacts

The set of per-run filesystem paths: the run directory, per-phase sentinel files, tmux log files, prompt files, the `run.jsonl` log. Exposed as an Effect service so tests can route writes into a temp dir. Shallow by design (it's a path container); listed here because callers (Phase, Session, machine) reference it across multiple files.

### Provider

The seam between the orchestrator and a forge (GitLab today; the GitHub adapter is deferred). Defined in [`src/provider/provider.ts`](src/provider/provider.ts) as an Effect `Context.Tag`. Domain vocabulary (Issue, PullRequestRef, Discussion, DiscussionId, …) lives in [`src/provider/types.ts`](src/provider/types.ts) and is documented at length in [`docs/provider-vocabulary.md`](docs/provider-vocabulary.md). Tests inject a fake Provider via `Layer.succeed(GitProvider, fake)` — that's the seam's primary justification today (see ADR §3.2 + addendum).

## Architecture vocabulary

These are the words used to evaluate design — borrow them when discussing trade-offs:

- **Module** — anything with an interface and an implementation (function, class, package, slice).
- **Interface** — everything a caller must know to use the module: types, invariants, error modes, ordering, config.
- **Depth** — leverage at the interface: a lot of behaviour behind a small interface. Deep modules are the goal; shallow modules (interface ≈ implementation) are the smell.
- **Seam** — the place an interface lives; where behaviour can be altered without editing in place.
- **Adapter** — a concrete implementation at a Seam. The heuristic: *1 adapter = hypothetical seam, 2 adapters = real seam*. Documented exception: the Provider Seam pays its place today via the test path (see ADR §3.2 addendum).
- **Locality** — when one thing changes, one place changes.
- **Deletion test** — if I delete this module, does its complexity vanish (pass-through, drop it) or reappear concentrated in N callers (it was earning its keep)?
