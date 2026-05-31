/**
 * Notify/discord.ts — best-effort Discord push for end-of-attempt fates.
 *
 * Opt-in via `$KIRBY_DISCORD_WEBHOOK_URL`: unset → every call is a silent
 * no-op (no network, no service requirement). The orchestrator is an AFK tool,
 * so a terminal fate (a merge, a give-up, a re-queue) is worth a phone ping —
 * but a notification must never alter a run, so the POST runs exactly once
 * (a webhook is non-idempotent: a retry would double-post), and any failure is
 * logged, never raised. The returned Effect's `never` error channel and `never`
 * requirement let it compose into any handler without widening its services.
 */
import { Console, Effect } from "effect";
import { formatDuration } from "../duration";

/** The webhook env var. Optional: unset disables Discord notifications entirely. */
const WEBHOOK_ENV = "KIRBY_DISCORD_WEBHOOK_URL";

/** A hung webhook must not stall the run; abandon the POST past this. */
const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * How a finished attempt reads to a human. `failure` parks the issue for a
 * human; `requeued` is a Stall/Interruption returned to the queue; `success`
 * is a merge. Drives the embed colour and emoji.
 */
export type NotificationCategory = "success" | "failure" | "requeued";

/** Everything one end-of-attempt notification carries. */
export type IssueEndNotification = {
  readonly category: NotificationCategory;
  /** Human header (e.g. `**AFK failed**`, `merged`); markdown is stripped. */
  readonly headline: string;
  readonly issue: { readonly iid: number; readonly title: string };
  readonly branch?: string | null;
  readonly pullRequestIid?: number | null;
  readonly fixCycles?: number | null;
  readonly reason?: string | null;
  /**
   * Which orchestrator sent this — surfaced as the webhook `username` so several
   * concurrent kirby processes sharing one channel stay distinguishable. The
   * `runId` disambiguates even two runs on the same repo.
   */
  readonly source?: { readonly repo: string; readonly runId: string };
};

/** Discord embed colours (decimal RGB), by category. */
const COLOR: Record<NotificationCategory, number> = {
  success: 0x2ecc71,
  failure: 0xe74c3c,
  requeued: 0xf39c12,
};

/** Leading glyph per category — the at-a-glance signal in a phone notification. */
const EMOJI: Record<NotificationCategory, string> = {
  success: "✅",
  failure: "❌",
  requeued: "🔁",
};

/** Discord caps embed descriptions at 4096 chars; keep reasons comfortably under. */
const REASON_MAX = 1500;

/** Discord caps the webhook `username` override at 80 chars. */
const USERNAME_MAX = 80;

/** Strip the markdown bold the issue notes use — Discord embeds render plain. */
const plain = (text: string): string => text.replace(/\*\*/g, "");

/** One Discord embed field; omitted entirely when its source value is absent. */
type EmbedField = { readonly name: string; readonly value: string; readonly inline?: boolean };

/**
 * Build the Discord webhook payload from a notification. Pure (no env, no I/O)
 * so the embed shape is unit-testable. Null/absent fields are dropped rather
 * than rendered as empty rows.
 */
export const buildDiscordPayload = (n: IssueEndNotification): Record<string, unknown> => {
  const fields: EmbedField[] = [{ name: "Issue", value: `#${n.issue.iid} — ${n.issue.title}` }];
  if (n.branch != null && n.branch !== "") {
    fields.push({ name: "Branch", value: n.branch, inline: true });
  }
  if (n.pullRequestIid != null) {
    fields.push({ name: "PR", value: `#${n.pullRequestIid}`, inline: true });
  }
  if (n.fixCycles != null) {
    fields.push({ name: "Fix cycles", value: String(n.fixCycles), inline: true });
  }
  const description =
    n.reason != null && n.reason !== "" ? plain(n.reason).slice(0, REASON_MAX) : undefined;
  const embed = {
    title: `${EMOJI[n.category]} #${n.issue.iid} — ${plain(n.headline)}`.slice(0, 256),
    color: COLOR[n.category],
    fields,
    ...(description !== undefined ? { description } : {}),
  };
  const username = n.source && `kirby · ${n.source.repo} · ${n.source.runId}`.slice(0, USERNAME_MAX);
  return { embeds: [embed], ...(username ? { username } : {}) };
};

/**
 * POST a prebuilt payload to the webhook, best-effort.
 *
 * No-op when `$KIRBY_DISCORD_WEBHOOK_URL` is unset. Otherwise POSTs once (no
 * retry — a webhook is non-idempotent) and swallows every failure (timeout,
 * non-2xx, network) into a logged warning keyed by `label`, so the run is
 * never affected. The `never` error/requirement channels let it compose
 * anywhere.
 */
const postToDiscord = (
  payload: Record<string, unknown>,
  label: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const url = process.env[WEBHOOK_ENV];
    if (url === undefined || url === "") {
      return;
    }
    const body = JSON.stringify(payload);
    yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        }),
      catch: (error): Error => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.void
          : Effect.fail(new Error(`Discord webhook returned ${response.status}`)),
      ),
      Effect.catchAll((error) =>
        Console.error(`  ⚠ ${label}: Discord notification failed — ${error.message}`),
      ),
    );
  });

/**
 * Push one end-of-attempt notification to Discord, best-effort.
 *
 * No-op when `$KIRBY_DISCORD_WEBHOOK_URL` is unset. Otherwise POSTs once and
 * swallows every failure — the run is never affected.
 */
export const notifyIssueEnd = (n: IssueEndNotification): Effect.Effect<void> =>
  postToDiscord(buildDiscordPayload(n), `#${n.issue.iid}`);

/** Per-fate issue counts for one run. */
export type RunDigestCounts = {
  readonly done: number;
  readonly failed: number;
  readonly stalled: number;
  readonly interrupted: number;
  readonly incomplete: number;
};

/** The single run-level digest pushed once at run_end (#72). */
export type RunDigestNotification = {
  readonly source: { readonly repo: string; readonly runId: string };
  readonly durationMs: number | null;
  readonly counts: RunDigestCounts;
  readonly totalCostUsd: number | null;
  /** Issues needing a human (failed / stalled / interrupted) — surfaced first. */
  readonly actionable: readonly {
    readonly iid: number;
    readonly title: string;
    readonly fate: string;
  }[];
  /** Merged issues, with their PR/MR iid when known. */
  readonly merged: readonly {
    readonly iid: number;
    readonly title: string;
    readonly pullRequestIid: number | null;
  }[];
};

/** Discord caps embed field values at 1024 chars; keep lists comfortably under. */
const FIELD_MAX = 1000;

/** Join lines into one field value, truncating with a "+N more" tail. */
const cappedList = (lines: readonly string[]): string => {
  const kept: string[] = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > FIELD_MAX) {
      kept.push(`… +${lines.length - kept.length} more`);
      break;
    }
    kept.push(line);
    len += line.length + 1;
  }
  return kept.join("\n");
};

/** The category a run reads as: any failure → failure, else any requeue → requeued. */
const digestCategory = (c: RunDigestCounts): NotificationCategory =>
  c.failed > 0 ? "failure" : c.stalled + c.interrupted > 0 ? "requeued" : "success";

/**
 * Build the run-digest webhook payload. Pure (no env, no I/O). Actionable
 * fates lead; merged issues follow with their PR iid. Empty sections are
 * dropped rather than rendered blank.
 */
export const buildRunDigestPayload = (n: RunDigestNotification): Record<string, unknown> => {
  const c = n.counts;
  const total = c.done + c.failed + c.stalled + c.interrupted + c.incomplete;
  const requeued = c.stalled + c.interrupted;
  const meta = [
    n.durationMs !== null ? `⏱ ${formatDuration(n.durationMs)}` : undefined,
    n.totalCostUsd !== null ? `💰 $${n.totalCostUsd.toFixed(2)}` : undefined,
  ].filter((part): part is string => part !== undefined);
  const description = [
    `**${total} issue(s)** · ✅ ${c.done} · ❌ ${c.failed} · 🔁 ${requeued} · … ${c.incomplete}`,
    ...(meta.length > 0 ? [meta.join(" · ")] : []),
  ].join("\n");

  const fields: EmbedField[] = [];
  if (n.actionable.length > 0) {
    fields.push({
      name: "⚠️ Needs attention",
      value: cappedList(n.actionable.map((i) => `#${i.iid} — ${i.title} (${i.fate})`)),
    });
  }
  if (n.merged.length > 0) {
    fields.push({
      name: "✅ Merged",
      value: cappedList(
        n.merged.map(
          (i) => `#${i.iid} — ${i.title}${i.pullRequestIid != null ? ` (PR #${i.pullRequestIid})` : ""}`,
        ),
      ),
    });
  }

  const category = digestCategory(c);
  const embed = {
    title: `${EMOJI[category]} Run finished — ${n.source.repo}`.slice(0, 256),
    color: COLOR[category],
    description,
    ...(fields.length > 0 ? { fields } : {}),
  };
  const username = `kirby · ${n.source.repo} · ${n.source.runId}`.slice(0, USERNAME_MAX);
  return { embeds: [embed], username };
};

/**
 * Push the single run-level digest to Discord, best-effort.
 *
 * No-op when `$KIRBY_DISCORD_WEBHOOK_URL` is unset. Otherwise POSTs once and
 * swallows every failure — the run is never affected.
 */
export const notifyRunDigest = (n: RunDigestNotification): Effect.Effect<void> =>
  postToDiscord(buildRunDigestPayload(n), `run ${n.source.runId}`);
