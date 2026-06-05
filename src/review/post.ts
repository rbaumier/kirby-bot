/**
 * Review/post.ts — post one fan-out's review to the MR as resolvable
 * discussion threads.
 *
 * Contract preserved with the existing `evaluate` phase (and downstream
 * `fix`): each discussion's first note opens with the header
 * `severity: <severity> | <file>:<line>` so the evaluator can group findings
 * by file and dispatch one read-only subagent per group. Body format mirrors
 * the upstream `code-review` JSON envelope (title, analysis, fix prompt) in
 * Markdown.
 *
 * Prose findings (Funnel L1/L2, Matt Review, Materiality, Thermo-nuclear)
 * don't fit the per-file evaluator shape — they're collapsed into a single
 * `severity: suggestion | review-summary:0` discussion that the evaluator
 * will route to "left for a human". This intentionally avoids the noise of
 * one thread per prose finding while preserving them on the MR record.
 *
 * Line-anchored `suggestion` findings are similarly file-and-forget: they are
 * consolidated into a single non-resolvable MR note so the evaluator never
 * re-triages them (they are never blocking). Actionable severities
 * (`bug`, `security`, `performance`, `error_handling`) keep the resolvable
 * discussion path.
 *
 * Concurrency is bounded — both stale-resolution and posting run with
 * concurrency {@link POST_CONCURRENCY} so a hundred-finding review doesn't
 * hammer the GitLab API in lockstep.
 */
import { Console, Effect } from "effect";
import { GitProvider } from "../provider/provider";
import type { ProviderCallError } from "../provider/types";
import { RunArtifacts } from "../run-artifacts";
import type { AggregatedReview, LineAnchoredFinding, ProseFinding } from "./aggregate";
import { encodeFindingHeader, REVIEW_SUMMARY_LOCATION } from "./finding-header";

/** Parallel discussion-posts per request — keeps GitLab happy on big diffs. */
const POST_CONCURRENCY = 6;

/** Severities that go through the resolvable-discussion path and into the evaluate loop. */
const isActionable = (f: LineAnchoredFinding): boolean => f.severity !== "suggestion";

/**
 * Format one line-anchored finding into a discussion body. The first line is
 * the contract `evaluate.md` parses — preserve it verbatim.
 */
const formatLineAnchoredBody = (finding: LineAnchoredFinding): string => {
  const header = encodeFindingHeader({
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
  });
  const analysis = finding.analysisChain.length === 0
    ? "_(no analysis chain)_"
    : finding.analysisChain.map((line) => `- ${line}`).join("\n");
  return [
    header,
    "",
    `**${finding.title}** _(agent: ${finding.agent}, confidence: ${finding.confidence})_`,
    "",
    "### Analysis",
    analysis,
    "",
    "### Suggested fix",
    finding.fixPrompt === "" ? "_(no fix prompt provided)_" : finding.fixPrompt,
  ].join("\n");
};

/**
 * Group prose findings by emitting agent for legibility, then collapse into
 * one discussion body keyed with the synthetic `review-summary:0` location.
 */
const formatProseSummary = (findings: readonly ProseFinding[]): string => {
  const grouped = new Map<string, ProseFinding[]>();
  for (const finding of findings) {
    const list = grouped.get(finding.agent) ?? [];
    list.push(finding);
    grouped.set(finding.agent, list);
  }
  const sections = Array.from(grouped.entries(), ([agent, items]) =>
    [
      `### ${agent}`,
      ...items.map((item) => `- [${item.tag}] ${item.text}`),
    ].join("\n"),
  );
  return [
    encodeFindingHeader(REVIEW_SUMMARY_LOCATION),
    "",
    "## Prose findings (architectural / scope-level)",
    "",
    "These are emitted by structural review agents (Funnel L1/L2, Matt Review, Thermo-nuclear, Materiality). They don't anchor to a single line; the evaluator routes them to 'left for a human'.",
    "",
    ...sections,
  ].join("\n");
};

/**
 * Collapse line-anchored suggestion findings into one consolidated note body.
 * Mirrors `formatProseSummary`'s grouping approach — one section per agent.
 */
const formatSuggestionNote = (findings: readonly LineAnchoredFinding[]): string => {
  const grouped = new Map<string, LineAnchoredFinding[]>();
  for (const finding of findings) {
    const list = grouped.get(finding.agent) ?? [];
    list.push(finding);
    grouped.set(finding.agent, list);
  }
  const sections = Array.from(grouped.entries(), ([agent, items]) =>
    [
      `### ${agent}`,
      ...items.map(
        (f) => `- [${f.file}:${f.line}] **${f.title}** _(confidence: ${f.confidence})_`,
      ),
    ].join("\n"),
  );
  return [
    "## Suggestion findings (filed for later grooming)",
    "",
    "These are `severity: suggestion` findings from the code-review pass. They are not blocking — the evaluator will not re-triage them.",
    "",
    ...sections,
  ].join("\n");
};

/**
 * Collapse findings the line resolver could not anchor (their verbatim snippet
 * matched no line in the diff) into one consolidated note. We don't drop them —
 * a mispositioned finding is still a finding (*findings over > under*) — but we
 * also can't post a resolvable thread on a line that isn't in the diff, so they
 * land here as a non-anchored note. The line is omitted: it's the unreliable
 * Agent-reported value the resolver rejected.
 */
const formatUnanchoredNote = (findings: readonly LineAnchoredFinding[]): string => {
  const grouped = new Map<string, LineAnchoredFinding[]>();
  for (const finding of findings) {
    const list = grouped.get(finding.agent) ?? [];
    list.push(finding);
    grouped.set(finding.agent, list);
  }
  const sections = Array.from(grouped.entries(), ([agent, items]) =>
    [
      `### ${agent}`,
      // The reported line is unreliable (it's what the resolver rejected), so we
      // surface the verbatim snippet instead — it's the only locator a human can
      // grep the file for.
      ...items.flatMap((f) => {
        const head = `- [${f.file}] **${f.title}** _(severity: ${f.severity}, confidence: ${f.confidence})_`;
        const snippet = f.analysisChain[0];
        return snippet === undefined ? [head] : [head, `  ${snippet}`];
      }),
    ].join("\n"),
  );
  return [
    "## Unanchored findings (snippet not found in diff)",
    "",
    "These findings could not be positioned: their verbatim snippet matched no line in the diff (out-of-diff code, or a drifted line count). They are filed here rather than dropped — a human may still want to act on them.",
    "",
    ...sections,
  ].join("\n");
};

/** Collapse prose findings into per-Agent counts for the `review_findings` event. */
const countByAgent = (
  findings: readonly ProseFinding[],
): { agent: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.agent, (counts.get(finding.agent) ?? 0) + 1);
  }
  return Array.from(counts.entries(), ([agent, count]) => ({ agent, count }));
};

/** Input for {@link postReviewToMr}. */
export type PostReviewToMrInput = {
  readonly mrIid: number;
  readonly review: AggregatedReview;
  /** The issue + review iteration this post belongs to — tags `review_findings`. */
  readonly issueIid: number;
  readonly iteration: number;
};

/** Result — how many discussions were posted. */
export type PostReviewToMrResult = {
  readonly posted: number;
  readonly resolvedStale: number;
};

/**
 * `postReviewToMr` — clear stale unresolved threads, post one discussion per
 * line-anchored finding, post one summary thread if any prose finding exists.
 *
 * Best-effort posting failures (one finding out of N) are NOT swallowed here
 * — the caller decides whether to surface them or move on. Stale-thread
 * resolution failures ARE swallowed (one unresolved leftover is preferable
 * to aborting the phase).
 */
export const postReviewToMr = (
  input: PostReviewToMrInput,
): Effect.Effect<PostReviewToMrResult, ProviderCallError, GitProvider | RunArtifacts> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    const artifacts = yield* RunArtifacts;

    // 1. Resolve any unresolved discussion from a prior iteration — old
    //    threads would otherwise confuse the evaluator into re-judging them.
    const existing = yield* provider.listDiscussions(input.mrIid);
    const stale = existing.filter((discussion) => !discussion.isResolved);
    yield* Effect.forEach(
      stale,
      (discussion) =>
        provider.resolveDiscussion(input.mrIid, discussion.id).pipe(
          Effect.catchAll((error) =>
            Console.error(`[review] could not resolve stale ${discussion.id}: ${error._tag}`),
          ),
        ),
      { concurrency: POST_CONCURRENCY },
    );

    // 2. Split line-anchored findings. First peel off the findings the line
    //    resolver could not anchor (snippet absent from the diff): posting them
    //    as resolvable threads would anchor on the wrong line or fail entirely,
    //    so they go to a consolidated note instead of being dropped. Of the
    //    anchored remainder, actionable severities become resolvable discussions
    //    and suggestions go to a single note the evaluator never re-triages.
    const anchoredFindings = input.review.lineAnchoredFindings.filter((f) => f.anchored);
    const unanchoredFindings = input.review.lineAnchoredFindings.filter((f) => !f.anchored);
    const actionableFindings = anchoredFindings.filter(isActionable);
    const suggestionFindings = anchoredFindings.filter((f) => !isActionable(f));

    // 3. Post each actionable finding as its own resolvable thread, keeping
    //    the finding object so the returned thread id stays attributed to its
    //    emitting Agent (forEach preserves input order).
    const postedLine = yield* Effect.forEach(
      actionableFindings,
      (finding) =>
        provider
          .postDiscussion(input.mrIid, formatLineAnchoredBody(finding), {
            file: finding.file,
            line: finding.line,
          })
          .pipe(Effect.map((discussionId) => ({ discussionId, finding }))),
      { concurrency: POST_CONCURRENCY },
    );

    // 4. Consolidate suggestion findings into one non-resolvable note (if any).
    if (suggestionFindings.length > 0) {
      yield* provider.postMrNote(input.mrIid, formatSuggestionNote(suggestionFindings));
    }

    // 4b. File the unanchorable findings as their own consolidated note so the
    //     resolver never silently swallows a finding it couldn't position.
    if (unanchoredFindings.length > 0) {
      yield* provider.postMrNote(input.mrIid, formatUnanchoredNote(unanchoredFindings));
    }

    // 5. Collapse prose findings into one summary thread (if any).
    const proseFindings = input.review.proseFindings;
    const proseDiscussionId =
      proseFindings.length > 0
        ? yield* provider.postDiscussion(input.mrIid, formatProseSummary(proseFindings))
        : undefined;

    // 6. Log review_findings — only actionable findings carry a discussionId
    //    joinable to triage_results; suggestion findings are omitted because
    //    they are never triaged.
    yield* artifacts.logEvent({
      event: "review_findings",
      issueIid: input.issueIid,
      iteration: input.iteration,
      findings: postedLine.map(({ discussionId, finding }) => ({
        discussionId,
        agent: finding.agent,
        file: finding.file,
        line: finding.line,
        severity: finding.severity,
      })),
      ...(proseDiscussionId === undefined
        ? {}
        : { prose: { discussionId: proseDiscussionId, byAgent: countByAgent(proseFindings) } }),
      ...(suggestionFindings.length === 0 ? {} : { suggestions: { count: suggestionFindings.length } }),
      ...(unanchoredFindings.length === 0 ? {} : { unanchored: { count: unanchoredFindings.length } }),
    });

    const summaryPosted = proseDiscussionId !== undefined;
    const posted = postedLine.length + (summaryPosted ? 1 : 0);
    yield* Console.log(
      `[review] !${input.mrIid}: posted ${posted} discussions (${postedLine.length} line-anchored + ${summaryPosted ? 1 : 0} prose summary)` +
        (suggestionFindings.length > 0 ? `, ${suggestionFindings.length} suggestions filed as note` : "") +
        (unanchoredFindings.length > 0 ? `, ${unanchoredFindings.length} unanchored filed as note` : "") +
        `, resolved ${stale.length} stale`,
    );

    return { posted, resolvedStale: stale.length };
  });

