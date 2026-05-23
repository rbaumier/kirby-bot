# Provider abstraction — vocabulary mapping & ADR

This file is the seam between the bot core and any forge (GitLab today, GitHub next). It documents:

1. The vocabulary every operation borrows from when crossing the seam.
2. The asymmetries between GitLab and GitHub the abstraction surfaces (not hides).
3. The interface shape we picked and why.

The interface itself lives in [`src/provider/provider.ts`](../src/provider/provider.ts); shared types in [`src/provider/types.ts`](../src/provider/types.ts). **No implementation lives behind this seam yet** — adapters arrive in issue #4 (GitLab) and issue #5 (GitHub).

## 1. Vocabulary

`iid` is the per-project numeric identifier exposed in the URL. GitLab calls it `iid`; GitHub calls it `number`. Both fit a JS `number`. The interface uses `iid` everywhere to avoid renaming the field every other call.

| Concept (interface)            | GitLab term                  | GitHub term                    | Notes                                                                                 |
| ------------------------------ | ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| Issue                          | Issue                        | Issue                          | Same shape.                                                                           |
| PullRequestRef                 | Merge Request                | Pull Request                   | Always abbreviated `PR` in code; `MR` only appears in GitLab-specific files.          |
| `iid`                          | `iid`                        | `number`                       | Per-repo numeric id, stable across renames.                                           |
| `sourceBranch` / `targetBranch`| `source_branch` / `target_branch` | `head` / `base`           | The interface keeps `source`/`target` (the GitLab pair) — adapters translate.         |
| Draft PR                       | title prefix `Draft:` / `WIP:` | `draft:true` boolean         | GitLab's REST signals draft via the title; GitHub via a boolean. Mark-ready (§2.1) and `isDraft` reflect the underlying mechanism. |
| Issue labels                   | labels (CSV in v4 list, array in show) | labels (array)        | GitLab list filter is comma-joined; GitHub filter is repeatable param.                |
| Issue note                     | note                         | issue comment                  | Single freeform comment on the issue timeline.                                        |
| Review thread / Discussion     | discussion (top-level)       | review thread (PR) + issue comments | The two providers differ deeply — see §2.                                       |
| Merge                          | `PUT /projects/.../merge`    | `PUT /repos/.../pulls/.../merge` | Both REST. Squash + auto-merge availability differs — see §2.                       |

The interface's word for a "thread you can resolve" is **discussion**. We borrow the GitLab term because GitHub has two overlapping concepts (issue comments + review threads) and "discussion" is the wider word — it's the abstraction's word for "a conversation pinned to a PR that can carry replies and be resolved". The adapter for each forge maps `discussion` to the right surface.

## 2. Asymmetries — surfaced, not hidden

The instinct when building a seam is to hide differences. Two of the differences below are too large for that — burying them either silently loses a feature or pretends a capability exists when it doesn't. We surface them in the interface contract rather than the type signature, so each adapter is forced to deal honestly.

### 2.1 — Marking a PR ready for review

- **GitLab**: `PUT /projects/:id/merge_requests/:iid` setting `title` with the `Draft:` / `WIP:` prefix stripped — the draft state is encoded in the title itself, not in a dedicated field. REST.
- **GitHub**: GraphQL mutation `markPullRequestReadyForReview`. The REST `PATCH /pulls/:number` accepts most fields but **not** flipping `draft`.

Adapter contract: `markPullRequestReady` returns `void` on success. GitHub adapter MUST use GraphQL; documenting this here keeps a future engineer from chasing the REST path.

### 2.2 — Resolving a thread

- **GitLab**: `PUT /projects/:id/merge_requests/:iid/discussions/:disc_id?resolved=true`. REST.
- **GitHub**: GraphQL mutation `resolveReviewThread` on a `pullRequestReviewThread` node id. No REST equivalent.

Adapter contract: `resolveDiscussion` returns `void` on success. The `discussionId` passed in is opaque — for GitLab it's the discussion id; for GitHub it's the GraphQL node id of the review thread. The bot never inspects it.

### 2.3 — Posting a thread

- **GitLab**: `POST /merge_requests/:iid/discussions` creates a top-level discussion (resolvable).
- **GitHub**: `POST /issues/:number/comments` creates an issue comment that lives in the PR timeline — but it is **not** a resolvable review thread. To create a *resolvable* thread the bot would have to attach to a diff position (line + commit sha + path) via the reviews API.

Adapter contract: `postDiscussion(pullRequestIid, body)` posts a top-level, line-detached note. On GitLab that note is resolvable; on GitHub it lands as an issue-comment-on-PR and is NOT resolvable. The bot's reviewer flow currently only resolves discussions it received from the other side, not the ones it created — so the asymmetry is tolerable. If we later need the bot to post resolvable threads, the interface gains a second method `postReviewThread(pullRequestIid, position, body)`; we don't pre-build it.

### 2.4 — Auto-merge

- **GitLab**: `PUT /merge_requests/:iid/merge` accepts `merge_when_pipeline_succeeds: true`.
- **GitHub**: REST merge has no auto-merge field. The GraphQL mutation `enablePullRequestAutoMerge` does, but the repo needs auto-merge enabled in settings.

Adapter contract: `mergePullRequest({ iid, shouldSquash, shouldAutoMerge })` either merges synchronously or schedules an auto-merge — the caller treats the returned `PullRequestRef` as the source of truth (state stays `opened` if it was queued, flips to `merged` if it went through). The GitHub adapter MUST re-fetch the PR after the GraphQL `enablePullRequestAutoMerge` mutation, which doesn't return the updated MR shape; GitLab's REST merge endpoint already returns the post-merge MR.

### 2.5 — Updating labels

- **GitLab**: `PUT /projects/:id/issues/:iid` accepts `add_labels` and `remove_labels` as deltas — the API resolves them server-side.
- **GitHub**: `POST/DELETE /repos/:o/:r/issues/:n/labels` operate on the full label set, not deltas. The adapter computes deltas client-side; concurrent updates can race.

Adapter contract: `updateIssueLabels(iid, { add, remove })` is delta-shaped. Both arrays may be empty (no-op). The GitHub adapter implements the delta with a read-modify-write — callers who care about atomicity should know.

### 2.6 — Listing discussions

- **GitLab**: `GET /merge_requests/:iid/discussions` returns *all* discussions on the MR — top-level notes, review threads, system notes. Each carries `resolvable`/`resolved` flags.
- **GitHub**: review threads (resolvable) live behind GraphQL `pullRequestReviewThreads`; PR-level comments (not resolvable) live behind REST `GET /issues/:n/comments`. The two surfaces don't merge cleanly.

Adapter contract: `listDiscussions(pullRequestIid)` returns the union — every conversation pinned to the PR, with `isResolved` reflecting whether the underlying surface supports resolution AND has been resolved. GitHub adapter MUST fan out to both surfaces.

## 3. ADR — interface shape

### 3.1 — Candidates

We explored three concrete shapes before committing. All three move the same 13 operations across the seam; they differ in how a caller asks for one.

#### Candidate A — plain interface + record

```ts
export interface GitProvider {
  listIssuesByLabels(q: ListIssuesQuery): Effect.Effect<readonly Issue[], ProviderError>;
  // … 12 more
}

export const makeGitLabProvider = (env: GitLabEnv): GitProvider => ({ /* … */ });
```

Pros: zero Effect surface to learn, easy to mock in tests, idiomatic to a TypeScript-without-Effect codebase.
Cons: the value has to be threaded through every function that uses it — either as an extra arg, a closed-over capture, or a manual context object. The rest of the codebase already runs on Effect (Schedule, retry, tagged errors), so the rest of the request-handling layer would have to either accept the provider as a plain arg or wrap it back into Effect at every call site. Doable, but the cost is paid 13 times.

#### Candidate B — sum type + free functions

```ts
export type GitProvider =
  | { readonly kind: "gitlab"; readonly env: GitLabEnv }
  | { readonly kind: "github"; readonly env: GitHubEnv };

export const listIssuesByLabels = (p: GitProvider, q: ListIssuesQuery) =>
  p.kind === "gitlab"
    ? listIssuesByLabelsGitLab(p.env, q)
    : listIssuesByLabelsGitHub(p.env, q);
```

Pros: trivially serializable, no class hierarchy, very explicit.
Cons: every operation grows an `if/switch` on `kind`. With 13 operations × 2 providers that's 26 branches the runtime walks every call — and 13 dispatch functions the seam has to keep in sync. Adding a third provider means editing 13 files. The branching is exactly what an interface is built to remove.

#### Candidate C — Effect.Service / Context.Tag (chosen)

```ts
export class GitProvider extends Context.Tag("GitProvider")<
  GitProvider,
  { readonly listIssuesByLabels: (q: ListIssuesQuery) => Effect.Effect<readonly Issue[], ProviderCallError>; /* … */ }
>() {}

// caller:
Effect.gen(function* () {
  const provider = yield* GitProvider;
  const issues = yield* provider.listIssuesByLabels({ include: ["ready-for-agent"] });
});

// wiring (later, in adapters):
Layer.succeed(GitProvider, makeGitLabImpl(env))
```

Pros: matches the codebase's existing Effect-based plumbing (the existing GitLab client returns `Effect.Effect<_, GitLabError>`, retries via `Schedule`, fails via `Data.TaggedError`); no threading of a `provider` argument through the call graph; tests inject a fake provider with `Layer.succeed(GitProvider, fake)`; provider selection at boot is a single `Layer` swap; adding a third provider doesn't touch a single call site.
Cons: the Effect Context model has a learning curve for engineers not already using it, and the type errors from a missing `Layer` are obtuse the first time.

### 3.2 — Decision

**Candidate C.** The cons listed for it are real but bounded: the codebase already commits to Effect — every existing operation returns `Effect.Effect<_, GitLabError>` and is retried with `Schedule.exponential`. A plain interface (A) would create a second style next to the existing one (Effect everywhere else, raw promise here) and pay the threading cost on every call. A sum type (B) would push the dispatch into 13 hand-maintained switches.

The deciding factor is the test path. The bot's reviewer/maintainer loops are pure orchestration — the only thing that should change between unit tests and a real run is the provider. With `Context.Tag`, the test layer is one line:

```ts
Layer.succeed(GitProvider, { listIssuesByLabels: () => Effect.succeed(fixtures), /* … */ })
```

That property — adapter swap as a single Layer — is what we're paying the Effect surface for.

### 3.3 — What this MR ships

- The `GitProvider` `Context.Tag` with 13 operation signatures (the 11 the spec called for plus `viewIssue` and `viewPullRequest`, used by the maintainer loop to refresh state after side effects).
- The shared error union: `ProviderCallError` (HTTP / network / response — the per-operation error channel) plus `ProviderConfigError` for boot-time wiring failures. `ProviderError = ProviderCallError | ProviderConfigError` stays exported as the umbrella; per-call signatures only fail with `ProviderCallError`.
- The value types (`Issue`, `PullRequestRef`, `DiscussionSummary`, `DiscussionId`, etc.).
- This document (vocabulary + asymmetries + ADR).

What this MR does **not** ship: any adapter, any `Layer`, any change to the existing GitLab client. The next two issues (#4 GitLab, #5 GitHub) wire the seam to actual code.
