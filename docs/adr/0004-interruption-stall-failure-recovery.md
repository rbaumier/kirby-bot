# ADR 0004 — Interruption / Stall / Failure: a three-fate recovery model

**Status:** accepted
**Date:** 2026-05-31

## Context

Every run that stops short of `done` collapses today into one of two ill-fitting
sinks:

- A **`failed` state** (`src/pipeline/step.ts`) catches *every* `HandlerError`
  and routes it to `failed-by-agent` — a terminal "needs a human" label the
  queue read filters out forever (`onFetchQueue` excludes it). But that same
  sink swallows a Claude-usage-exhausted `NoVerdict`, a `SessionTimedOut`, a
  `TmuxError`, and a transient git push failure — none of which a human can
  act on. The issue is parked permanently for a transient cause and is never
  retried (#35 fixed the *claim* leak, not this).
- A **stranded `picked-by-agent` claim** when the process dies mid-Phase
  (SIGTERM, `kill -9`, OOM). No finalizer releases it. The only recovery is the
  startup sweep (`src/recovery/sweep.ts`), and its staleness heuristic is the
  issue's `updated_at` age past `STALE_CLAIM_MS` (`ISSUE_BUDGET_MS + 30 min` =
  4h30, `src/config.ts`). For an AFK orchestrator whose runs rarely last 4h30,
  the orphan effectively never reaps: the claim "stays" with no live agent
  behind it.

The root error is conflation. "The run stopped" is not one thing. The signal
that matters is **what stopped it**, and there are three distinct answers, each
warranting a different recovery policy. The pipeline's own commit discipline
already makes recovery cheap: `implementation.md` and `fix.md` both *commit
incrementally and push after every commit*, `implementationPhase` already
salvages pushed work on timeout (#51), and `onOpenDraftMr` already reuses an
open MR idempotently — so work is durable on `origin/<branch>` continuously.
The only thing that throws it away is the re-pick path
(`dropStaleRemoteAgentBranch` deleting `origin/<branch>` + `branch_create`
rebuilding from `origin/<defaultBranch>`), whose doc comment states the now-
reversed stance: *"every run redoes the issue from scratch."*

## Decision

Replace the binary with **three issue fates** — Interruption, Stall, Failure
(defined in `CONTEXT.md`). Classification is an **allowlist for the terminal
kinds; everything else defaults to recoverable**, so a new, unanticipated error
retries (bounded) rather than parking an issue for a human forever.

**The classifier needs a typed channel.** Today the discriminating tag is *gone*
by the time an error reaches the `step.ts` seam: `phaseHandlerError`
(`phases/runner.ts`) collapses every `PhaseError` into `HandlerError({ reason:
string })` via `describePhaseError`, and verdict-based terminals
(`BLOCKER_SUSPECTED`, `MAX_FIX_CYCLES`) are built as bare reason strings inline.
A classifier switching on a fate cannot regex those strings — exactly the
fragile inference this ADR rejects for G2. So **`HandlerError` gains a `fate:
"interruption" | "stall" | "failure"` field, set at every construction site**
(`phaseHandlerError`, `providerHandlerError`, and each inline `new HandlerError`
in `implementation.ts` / `pr.ts` / `queue.ts` / `reclaim-branch.ts` /
**`rebase-branch.ts`** / `review.ts` / `runner.ts`). Making `fate` required turns
any missed site into a *compile error* — but the compiler only guarantees a fate
is *present*, not *correct*; correctness is a per-site obligation:

- **Most sites carry a constant** — they know their own cause. `BLOCKER_SUSPECTED`
  → `failure`, a `SessionTimedOut` mapped by `phaseHandlerError` → `stall`, a
  `TmuxError` → `interruption`. `phaseHandlerError` therefore maps each
  `PhaseError` *tag* (not its reason string) to a fate — structured, not regex.
- **`providerHandlerError` cannot use a constant** — it is one shared wrapper over
  an opaque `ProviderCallError` feeding many callers (claim, open_draft_mr, merge,
  …). Its fate is a **typed function of the error**, `fateOfProviderError(error)`:
  a transport/5xx/429/timeout (`ProviderHttpError.status >= 500`, network,
  rate-limit) → `interruption`; an auth/config 401/403 → run-fatal (a bad token is
  a deploy bug, like `PromptError`); any other 4xx → `failure` (a 404/422 the
  retry will only re-hit). This is structured classification on the *typed* error
  at the point it is still typed — the opposite of regexing a flattened reason
  downstream. The `status` is already read this way elsewhere
  (`isBranchOutOfDate`, `pr.ts:82`).

This upstream change — `HandlerError.fate` + the `fateOfProviderError` /
per-tag mappers, not a clever `step.ts` seam — is the bulk of the work.

**Two non-`HandlerError` channels reach an end state and bypass the classifier**,
by design, both landing as Interruptions: (a) `onFetchQueue`'s `ProviderCallError`
(the deliberate run terminator, `step.ts`) and (b) an unhandled **defect**
(`Effect.die` / a thrown exception inside an `Effect.gen`) anywhere in a phase.
Neither is a typed `HandlerError`; both crash the run with the claim still held,
and the next run's PID sweep recovers the claim as an Interruption. This is the
correct outcome (a crash *is* an external cut-off), but the fate model is not
exhaustive over defects — the PID sweep is the catch-all beneath it.

1. **Failure (allowlist) → `failed-by-agent`, terminal.** The agent *judged* and
   gave up (`BLOCKER_SUSPECTED`, `MAX_FIX_CYCLES` exhausted, `QA_FAIL` — note `qa`
   is a pass-through stub today, `qa.ts`, so `QA_FAIL` is a documented-but-dormant
   cause until QA is re-enabled) or a *safety refusal* fired (the refused branch
   reclaim on a #24 name collision — terminal but not a judgment). Never retried;
   a human re-queue clears the Stall count.

2. **Stall → `ready-for-agent`, capped.** The work consumed its own session
   without a verdict, *or the cause recurs when the same work resumes*:
   `SessionTimedOut`, `NoVerdict`, `BudgetExhausted`,
   implementation-timed-out-with-no-commits, **and the agent/diff-correlated
   glitches `UnexpectedVerdictError` and the twice-malformed review router**. The
   discriminator from Interruption is *re-runnability*: an error the resumed run
   will hit again on the same diff must be capped, or it loops (below). A **local
   sidecar counter** (mono-host, `~/.afk-state/<repo>/`) increments; at the 3rd
   consecutive Stall it converts to a Failure.

3. **Interruption → `ready-for-agent`, free (uncapped).** A *true external or
   environment* cut-off, the issue innocent: SIGTERM / Ctrl-C, `kill -9` / OOM /
   host crash, `TmuxError`, `WorkspaceError` (a worktree/run-dir fs fault),
   transient git/network/API errors, and unhandled defects. Uncapped because an
   external cut-off carries no signal the *issue* is unworkable — this is what
   makes the
   AFK workflow safe (Ctrl-C mid-issue is the normal way to stop kirby and must
   not count against an innocent issue). Residual exposure: a resumed
   Interruption re-mints a fresh `deadline` (below), so a *persistently* recurring
   external cause could loop while re-minting budget. Bounded by an **absolute
   re-pick backstop** in the same sidecar — an issue re-picked more than K times
   by *any* fate (e.g. 10) converts to Failure. The diff-correlated loops (the
   real risk) are already closed by filing those causes as Stalls.

**Where the fate is acted on.** The `step.ts` catchAll stays pure: it reads
`error.fate` and the `failedFieldsOf(current)` fields and constructs *one of three
terminal-ish states* — `failed` (today's), plus new **`stalled`** and
**`interrupted`** variants carrying the same fields. Each gets a handler mirroring
`onFailed`, and the sidecar IO lives in the *handlers* (which already hold
`GitProvider` + `RunArtifacts`), not in the pure catchAll:

- **`onInterrupted`** — post the audit note, set `ready-for-agent`, **reset** the
  issue's consecutive-Stall count, bump the total re-pick count (→ Failure past
  K), loop to `fetch_queue`.
- **`onStalled`** — **increment** the consecutive-Stall count; if it reaches the
  cap (or the total re-pick backstop fires) behave exactly like `onFailed`
  (`failed-by-agent`, clear the sidecar); else set `ready-for-agent`, audit note,
  loop to `fetch_queue`.
- **`onFailed`** — unchanged except it also clears the sidecar entry.

So the "increment → check cap → route failed-vs-ready" the prior reviews could not
locate lives in `onStalled`, a single new handler — not smeared across phases. The
`State` union and `failedFieldsOf` gain the two variants; the exhaustive switches
force the wiring.

**Resume where it left off — `branch_create` gains a resume path.**
`onBranchCreate` (`queue.ts:115`) today is a fixed scratch sequence — `worktree
remove` → `fetch origin <default>` → `reclaimAgentBranch` (deletes the local
branch *iff* contained in `origin/<default>`, else **refuses**) →
`dropStaleRemoteAgentBranch` (deletes `origin/<branch>`) → `worktree add -b
<branch> … origin/<default>`. Three of those steps actively fight a resume, so
the resume path is **not** a one-line conditional:

1. **Detect.** After also fetching the branch (`git fetch origin <default>
   <branch>` — today only `<default>` is fetched), probe `origin/<branch>`:
   present and ahead of `origin/<default>`? → resume; else → the scratch sequence,
   unchanged.
2. **`reclaimAgentBranch` is skipped on resume.** Its refuse-if-not-contained
   guard (`reclaim-branch.ts:80`) exists to protect a *human's* colliding branch;
   on resume we have already confirmed `origin/<branch>` is *our* afk branch and
   it holds the work, so the local ref is freely disposable. Skipping it is what
   stops "every resume of unmerged work becomes a Failure."
3. **Rebuild from the branch, not default.** `worktree add -b` *creates* a branch
   and errors if the ref exists — so on resume, drop the local ref unconditionally
   (`git branch -D <branch>`, safe: `origin/<branch>` preserves the work) then
   `git worktree add -b <branch> <worktree> origin/<branch>`. Local now tracks
   `origin/<branch>` exactly.
4. **`dropStaleRemoteAgentBranch` is skipped on resume** (it would delete the very
   commits we are resuming).
5. **`branch_push`** (`push -u origin <branch>`) is then a **no-op** — local == the
   remote tip we built from — so a prior `--force-with-lease` from the salvage /
   rebase path cannot make it a non-fast-forward reject.

Past `branch_create` the existing handlers carry everything; there is no new "skip
to phase X" machinery:

- `implementation` re-runs, but its prompt is told to *continue any partial work
  and emit `READY_FOR_REVIEW` immediately if it is already complete* — a cheap
  confirm pass when the work was done, real completion when the #51 salvage left
  it half-built. We deliberately **always re-enter `implementation`** rather than
  gate a skip on "has a review run?": a review hunts diff bugs, not
  spec-completeness, so the only safe place to decide "is this feature finished?"
  is the implementer itself. This is the G1 shape (re-enter implementation, lean
  on the prompt to short-circuit) — chosen over a discussion-gated skip because
  the skip *re-invents idempotency that already exists one state downstream* (see
  Options). **Caveat, stated plainly:** the implementer runs a fresh session with
  the implementation prompt and *no MR context* — it does not see the prior
  attempt's open review threads (`previous-findings` feeds *review*, not
  implementation). So "don't redo / don't conflict" is a **prompt-only guarantee
  on the heaviest phase, with no code guardrail.** Accepted, but it is the softest
  part of the design — not "the existing handlers carry everything".
- `open_draft_mr` already reuses an open MR idempotently
  (`onOpenDraftMr`/`findOpenPullRequestBySource`, `pr.ts:37-51`) and jumps to
  `review` with `fixCycles = 0` — no change needed.
- `review`'s first iteration already **resolves** the prior attempt's open
  threads (`postReviewToMr`, `post.ts:160`); `previous-findings.ts` then feeds
  those resolved findings to the next review as *context* by design. There is
  nothing to "wipe" (the `Provider` seam has no delete — only `resolveDiscussion`),
  and nothing to add.

Because resume re-enters at `implementation`, `deadline` is minted exactly as
today (`implementation.ts:32`, `now + ISSUE_BUDGET_MS`) — the earlier "mint a
fresh deadline at a `review` seam" problem dissolves. A resumed issue still gets
a fresh full budget (hence the Stall cap and the absolute re-pick backstop bound
total compute), but no new minting site is needed.

**Liveness backstop = PID lockfile only (mono-host).** A live run writes one
lockfile per run dir holding `{ pid, startTime, claimedIssueIid }`. The
`startTime` (from `ps -o lstart=` / `/proc/<pid>/stat` btime) is **load-bearing,
not decorative**: a bare PID is unsound on a single host, where the kernel
recycles PIDs aggressively — a recycled PID belonging to an unrelated live process
would make `kill -0` succeed, the sweep would think the claim is live, and the
orphan would never be reaped (until the 4h30 age sweep, i.e. effectively never for
short runs). So the sweep reaps when **the PID is dead *or* its start-time no
longer matches** the lockfile. The startup sweep maps a stale `picked-by-agent`
claim → its worktree (`worktreePathsForIssue`, already in `stale.ts`) → the
lockfile — recovery in seconds, covering `kill -9` *and* SIGTERM, at zero API cost
— posting the audit note (worktree link) as it returns the issue to
`ready-for-agent` as an Interruption. **There is no in-process SIGTERM
finalizer** (see Options): it was dropped because `kill -9` / OOM bypass it
anyway and the PID sweep already covers every case, so a finalizer is net-new
`acquireRelease` complexity for only "claim released one run earlier" on the
graceful path. A crash *before* `branch_create` leaves a claim with no worktree
and no lockfile; that rare case falls through to the demoted age sweep (kept as a
last-ditch backstop, no longer the primary signal).

**`PromptError` is not an issue fate.** A missing or unresolvable prompt template
is a *deploy bug* affecting every issue. It crashes the **run** (a fourth,
run-fatal channel — loud, so the operator fixes the deploy), rather than parking
the innocent issue.

## Considered Options

- **Auto-retry `failed-by-agent` wholesale** (the original instinct) — rejected:
  re-running a genuine Failure (`MAX_FIX_CYCLES`, `QA_FAIL`) just re-reaches the
  same verdict, burning a 4h budget per round. The right split is *interrupted /
  stalled vs judged*, not *failed vs not*.
- **Two fates (Interruption vs Failure), folding Stalls into Interruption** —
  rejected during grilling: it would either cap SIGTERM (parking issues the
  operator merely stopped) or leave Stalls uncapped (a too-large issue retrying
  forever). Stalls consume budget and carry a weak poison signal; Interruptions
  do neither. They need different policies, hence a third concept.
- **Forge-visible Stall counter** (count `<!-- afk:interrupted -->` notes on the
  issue) — rejected: the `Provider` seam has no read-notes method, so it costs a
  new method across both the GitLab and GitHub Adapters, plus note-parsing.
  Mono-host makes a local sidecar sufficient; the audit note is posted anyway
  and decoupled from counting. The counter is *consecutive* Stalls, so it resets
  on **every non-Stall outcome** — a success (`onDone`), an Interruption, or a
  human re-queue — not only on terminal fates; otherwise "3 consecutive" silently
  becomes "3 lifetime".
- **Heartbeat liveness** (live run bumps a forge heartbeat; sweep reaps stale
  ones) — rejected for now: needed only cross-host, which kirby is not. It also
  fights the `STALE_CLAIM_MS` design (which uses `updated_at` as claim *age*,
  bumped only at claim time). PID liveness is exact, instant, and API-free on a
  single host.
- **G2 — reconstruct the exact phase + `fixCycles` from MR discussions** —
  rejected: fragile full state inference (or a persisted checkpoint that can lie).
  Resume re-enters `implementation` and lets the *existing* idempotent
  `open_draft_mr` carry it to `review` — no reconstruction at all.
- **Discussion-gated skip of `implementation`** (read `listDiscussions(MR)`; if a
  review already ran, jump straight to `review`) — rejected: it re-invents the
  idempotency that `onOpenDraftMr` (`pr.ts:37-51`) *already* provides one state
  downstream, adds a second source of truth for "review or implement?", and needs
  a `listDiscussions` read the existing path does not. Always re-entering
  `implementation` (with a prompt that short-circuits when complete) is simpler
  and strictly safer for the #51 half-built-salvage case.
- **Regex the `failed` reason string to classify** — rejected: the fate must be
  decided where the error is *born* (it knows its own cause), not parsed back out
  of a human-readable string downstream. Hence the `fate` field on `HandlerError`.
- **"Wipe" prior discussions on resume** — rejected as impossible *and*
  unnecessary: the `Provider` seam has no delete (only `resolveDiscussion`), and
  `postReviewToMr` (`post.ts:160`) already resolves prior open threads on each
  review iteration while `previous-findings.ts` intentionally feeds the resolved
  ones back as context. Nothing to wipe.
- **In-process SIGTERM finalizer** (`acquireRelease` around issue ownership,
  releasing the claim + posting the note during shutdown) — rejected: `kill -9`
  / OOM bypass it and the PID sweep already recovers every case, so it is net-new
  complexity (provider mutations under a bounded grace window) for only "claim
  released one run earlier" on the graceful path. The sweep posts the audit note
  instead.

## Consequences

- The change is **upstream of `step.ts`, not in it**: `HandlerError` carries a
  `fate` — a constant at most sites, a typed `fateOfProviderError(error)` at the
  shared `providerHandlerError` wrapper, a per-tag map in `phaseHandlerError`. The
  pure `step.ts` catchAll routes on `fate` into the `failed` / `stalled` /
  `interrupted` states, with `PromptError` short-circuiting to a run-fatal
  channel; the sidecar IO lives in the new `onStalled` / `onInterrupted` handlers
  (peers of `onFailed`). The `State` union and `failedFieldsOf` gain the two
  variants; the exhaustive switches force every error site and every handler row.
- The documented *"every run redoes from scratch"* stance is reversed for
  resumable issues. `dropStaleRemoteAgentBranch` (#36) and `branch_create`'s
  worktree rebuild must branch on "is this a resume?" — a real behaviour change,
  and the reason this ADR exists. **Their doc comments must be rewritten, not just
  their call sites** (`reclaim-branch.ts:98-106` and `queue.ts:131-136` both
  assert the redo-from-scratch rationale); otherwise a future reader trusts the
  stale comment and "fixes" the resume logic back to scratch. The #24
  human-collision guard stays: a non-afk branch whose tip isn't upstream is still
  refused.
- `STALE_CLAIM_MS` (4h30) is no longer the primary recovery signal — the PID
  lockfile is. The age sweep can remain as a last-ditch backstop for a lockfile
  that was never written (e.g. a crash before the first write), but it is no
  longer what makes orphan recovery timely.
- A Stall cap of 3 means a genuinely unworkable issue burns up to ~3 fresh
  budgets before parking — accepted as the price of never parking a
  transiently-stalled issue. The absolute re-pick backstop (K≈10, any fate)
  bounds the uncapped-Interruption tail (an issue Ctrl-C'd in `implementation`
  every time is otherwise up to K×`ISSUE_BUDGET` of fresh budgets). The sidecar
  holds, per issue iid, the consecutive-Stall count and the total re-pick count;
  nothing GCs entries for iids that never terminate (negligible — a few bytes
  each). **Concurrency caveat:** the count is a read-modify-write; an atomic
  `rename` makes each *write* atomic but does **not** serialize RMW, so two
  same-host instances picking the same iid can lose an update and *under*-count
  (cap fires late, never early). Bounded — the random pick in `onClaimIssue`
  makes concurrent same-iid rare — and best-effort by choice; an advisory `flock`
  around the RMW closes it if it ever bites. It is never *over*-counted, so no
  innocent issue is parked early by the race.
- The sidecar reset (consecutive-Stall → 0 on every non-Stall outcome) touches
  **four code locations, one of them cross-process**: the in-band classifier, the
  PID sweep, and `onDone`. The sweep (`sweep.ts`) runs in a *later process* and
  today knows nothing of the sidecar — it **must be taught to reset** the entry
  for a claim it recovers as an Interruption, or a sweep-recovered run leaves the
  count stale and "3 consecutive" drifts toward "3 lifetime". And `onDone`'s clear
  must not ride the same swallowed-`catchAll` path as its other best-effort writes
  (`pr.ts:156`), or a swallowed fs error silently preserves the count.
- Resume re-enters `implementation`, so `deadline` is minted normally — no new
  seam. Each attempt still gets a fresh full `deadline`, so wall-clock budget is
  *per attempt*: total compute on a flaky issue is `attempts × ISSUE_BUDGET`,
  bounded by the two caps. The cost of always re-entering `implementation` (a
  confirm pass when the work was already complete) is accepted in exchange for
  deleting the discussion-gated-skip machinery and the (impossible) discussion
  wipe.

## References

- `src/pipeline/errors.ts` — `HandlerError` gains the `fate` field.
- `src/pipeline/step.ts` — the `failed` seam routes on `fate` into failed / stall / interruption.
- `src/phases/runner.ts` — `phaseHandlerError` / `providerHandlerError` / `toFixUnlessCapped` set `fate`.
- `src/pipeline/handlers/queue.ts` — `branch_create` resume branch (don't-wipe + worktree from `origin/<branch>`); `onFetchQueue` exclusion.
- `src/pipeline/handlers/reclaim-branch.ts`, `src/pipeline/handlers/rebase-branch.ts` — `HandlerError` sites; `dropStaleRemoteAgentBranch` conditional on resume.
- `src/pipeline/handlers/pr.ts` — `onOpenDraftMr` idempotency (reused, not re-invented); `onDone` clears the sidecar.
- `src/review/post.ts`, `src/review/previous-findings.ts` — prior threads resolved (not wiped) and fed back as context — already built.
- `src/recovery/sweep.ts`, `src/recovery/stale.ts` — PID-lockfile liveness backstop; sweep also resets the Stall sidecar.
- `src/session/errors.ts` — the `PhaseError` union whose members partition into Stall / Interruption / run-fatal.
- `src/config.ts` — `STALE_CLAIM_MS` demoted; Stall cap + absolute re-pick backstop added.
- `CONTEXT.md` — **Interruption**, **Stall**, **Failure**.
