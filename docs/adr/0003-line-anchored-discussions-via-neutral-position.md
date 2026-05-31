# ADR 0003 — Line-anchored discussions via a provider-neutral Position

**Status:** accepted
**Date:** 2026-05-31

## Context

A review Finding carries a `file:line`. We want it posted as a thread **on
that line** of the merge/pull request, not as a wall of general comments at
the top of the MR.

GitHub already does this: `postDiscussion` parses the `severity: <sev> |
<file>:<line>` header out of the body (`parseFindingHeader`), posts a review
comment anchored to the diff line, and falls back to a plain PR comment on a
422 ("line not in diff"). **GitLab — the default backend — does not**:
`postDiscussion(iid, body)` posts every Finding as a *general* resolvable
discussion (`src/gitlab/discussion.ts`). The `Provider` seam carries no
position at all; the location is smuggled inside the body text.

The resolve/reason flow (`evaluate` replies + resolves `imagined`/punt, `fix`
replies "fixed in `<sha>`" + resolves) and the agent attribution in each
Finding body already exist and are unaffected — the only real gap is GitLab
anchoring.

## Decision

Add a **provider-neutral `position`** to the seam:

    postDiscussion(iid, body, position?: { file, line })

`position` is the new side of the diff. `src/review/post.ts` passes
`finding.{file, line}` — values it already holds in `LineAnchoredFinding` —
for actionable line Findings; prose / summary Findings (and the
`mr-discussion.ts post` CLI) pass **none**, and the `position === undefined`
branch posts a general/plain discussion exactly as today. There is no
`side` discriminator: only the new side is ever emitted, so adding `old`
later is a one-field change, not a reason to carry it now.

Each Adapter resolves the forge-specific payload **internally**:

- **GitLab** fetches the MR's `diff_refs` and POSTs a positioned discussion:
  `position[position_type]=text`, the three SHAs (`base_sha`, `head_sha`,
  `start_sha`), and `new_path`=`old_path`=`file` + `new_line`=`line`. The
  `diff_refs` read is net-new (`MergeRequestSchema` does not decode it) and is
  **memoized once per MR** (`Effect.cachedFunction` in the Layer) so an
  N-finding review does not refetch N times. A line GitLab will not anchor
  (a context/unchanged line needs `old_line` too, an out-of-diff line is
  unknown) comes back **HTTP 400** — caught by a predicate that matches
  `status === 400` with a `line`/`position` body marker (not a blanket 400, so
  a genuinely malformed payload still surfaces) → fall back to a general
  resolvable discussion with `file:line` in the body.
- **GitHub** consumes the same `position` directly, **deleting**
  `parseFindingHeader` and the body-parsing path. The 422 fallback to a plain
  comment is unchanged.

The `severity: <sev> | <file>:<line>` header **stays in the body** — `evaluate`
and `fix` read it to learn severity and location (`evaluate.md`, `fix.md`),
and both it and `position` derive from the same `finding`, so they cannot
diverge. What changes is that anchoring no longer *depends* on parsing it.

## Considered Options

- **Position carrying the SHAs through the interface** — rejected: leaks
  GitLab vocabulary (`start_sha` is meaningless to GitHub) into the caller and
  the seam. SHAs are an implementation detail of the GitLab Adapter.
- **Minimal GitLab-only fix: parse the body header inside the GitLab Adapter**
  (mirroring today's GitHub) — rejected: it duplicates the fragile header
  parsing across two Adapters. With the structured field already present in
  `post.ts`, two parsers is the smell, not the fix (`CONTEXT.md` **Position**).
- **Anchor to the old side too** (`old_line`/LEFT for deleted code) — deferred:
  a review critiques *added* code; commenting on removed lines is marginal.
  Re-add a `side` field when it is actually built — no seam churn until then.

## Consequences

- `postDiscussion`'s signature gains an optional third argument across the
  Provider seam; the `mr-discussion.ts` CLI `post` and the test fakes pick up
  the optional param (default = general discussion, so old callers are
  unchanged). The CLI's `post` therefore never anchors — acceptable because
  `evaluate`/`fix` only ever `reply`/`resolve`; the review path posts through
  `post.ts`, which does pass a position.
- A Finding on a context/unchanged line still posts — as a general discussion —
  so no Finding is lost (consistent with the "findings: over > under" stance).
  The trade-off: if the GitLab `diff_refs` are wrong, *every* anchor 400s and
  silently degrades to general discussions. The fix-line predicate is therefore
  narrow (400 + `line`/`position` marker, never a blanket 400) and unit-tested
  (`gitlab/discussion.test.ts`, via the `__test` export — the repo's pattern,
  as it mocks no `fetch`); the caller wiring (position passed for line Findings,
  none for the prose summary) is covered in `review/post.test.ts`.
- `parseFindingHeader` and its tests are removed; GitHub anchoring is driven by
  data, not prose. GitHub keeps its existing per-call `viewPullRequest` for the
  head SHA — out of scope to memoize here.

## References

- `src/provider/provider.ts` — the seam gaining `position`.
- `src/gitlab/discussion.ts` — new positioned-discussion path + diff_refs fetch.
- `src/github/discussion.ts` — drops `parseFindingHeader`, consumes `position`.
- `src/review/post.ts` — passes `finding.{file, line}` as the position.
- `CONTEXT.md` — **Position** (provider-neutral anchor), **Provider**.
