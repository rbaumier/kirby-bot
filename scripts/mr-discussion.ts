#!/usr/bin/env bun
/**
 * Mr-discussion.ts — a thin CLI over the selected provider's discussion ops.
 *
 * The phase prompts call this (`review` posts, `evaluate`/`fix` reply and
 * resolve). The logic lives behind the {@link GitProvider} seam, resolved via
 * `selectProvider()` (GitLab or GitHub per `$KIRBY_PROVIDER`); this file only
 * parses argv and prints the result. The `--mr` flag and every output string
 * are unchanged so the phase prompts work under either backend (`--mr` is a
 * PR/MR number either way).
 *
 *   post    --mr <iid> --body <text>
 *   list    --mr <iid>
 *   reply   --mr <iid> --discussion <id> --body <text>
 *   resolve --mr <iid> --discussion <id>.
 */
import { BunRuntime } from "@effect/platform-bun";
import { Console, Data, Effect } from "effect";
import { GitProvider } from "../src/provider/provider";
import { selectProvider } from "../src/provider/select";
import { DiscussionId } from "../src/provider/types";

/** The CLI was invoked with a missing or malformed argument. */
class UsageError extends Data.TaggedError("UsageError")<{ readonly message: string }> {}

type Args = {
  readonly command: string;
  readonly mr: string | null;
  readonly body: string | null;
  readonly discussion: string | null;
};

/** Parse `process.argv` into {@link Args}. Plain — the effectful work is below. */
function parseArgs(argv: readonly string[]): Args {
  const [command = "", ...rest] = argv;
  const KNOWN_FLAGS = new Set(["--mr", "--body", "--discussion"]);
  const flags = new Map<string, string>();
  for (const [index, flag] of rest.entries()) {
    if (KNOWN_FLAGS.has(flag)) {
      flags.set(flag, rest[index + 1] ?? "");
    }
  }
  return {
    command,
    mr: flags.get("--mr") ?? null,
    body: flags.get("--body") ?? null,
    discussion: flags.get("--discussion") ?? null,
  };
}

const NUMERIC_RE = /^\d+$/;

/** Require `--mr` to be a numeric MR iid. */
const requireMr = (value: string | null): Effect.Effect<number, UsageError> =>
  value !== null && NUMERIC_RE.test(value)
    ? Effect.succeed(Number(value))
    : Effect.fail(
        new UsageError({ message: `--mr must be a numeric MR iid (got ${JSON.stringify(value)})` }),
      );

/** Require a flag to be present and non-empty. */
const requireFlag = (value: string | null, name: string): Effect.Effect<string, UsageError> =>
  value !== null && value !== ""
    ? Effect.succeed(value)
    : Effect.fail(new UsageError({ message: `missing required flag --${name}` }));

const program = Effect.gen(function* () {
  const provider = yield* GitProvider;
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "list": {
      const mr = yield* requireMr(args.mr);
      const discussions = yield* provider.listDiscussions(mr);
      // Re-shape to the legacy `{ id, resolved, notes }` JSON the phase prompts
      // parse (the seam renamed `resolved`→`isResolved` and maps a missing
      // author to null; both are reversed here so the output is unchanged).
      const legacy = discussions.map((discussion) => ({
        id: discussion.id,
        resolved: discussion.isResolved,
        notes: discussion.notes.map((note) => ({ author: note.author ?? "unknown", body: note.body })),
      }));
      return JSON.stringify(legacy, null, 2);
    }
    case "post": {
      const mr = yield* requireMr(args.mr);
      const body = yield* requireFlag(args.body, "body");
      yield* provider.postDiscussion(mr, body);
      return `posted a discussion on !${mr}`;
    }
    case "reply": {
      const mr = yield* requireMr(args.mr);
      const discussion = yield* requireFlag(args.discussion, "discussion");
      const body = yield* requireFlag(args.body, "body");
      yield* provider.replyToDiscussion(mr, DiscussionId(discussion), body);
      return `replied on discussion ${discussion}`;
    }
    case "resolve": {
      const mr = yield* requireMr(args.mr);
      const discussion = yield* requireFlag(args.discussion, "discussion");
      yield* provider.resolveDiscussion(mr, DiscussionId(discussion));
      return `resolved discussion ${discussion}`;
    }
    default: {
      return yield* Effect.fail(
        new UsageError({
          message: `unknown subcommand ${JSON.stringify(args.command)} — expected post | list | resolve | reply`,
        }),
      );
    }
  }
}).pipe(
  Effect.flatMap((output) => Console.log(output)),
  Effect.provide(selectProvider()),
);

BunRuntime.runMain(program);
