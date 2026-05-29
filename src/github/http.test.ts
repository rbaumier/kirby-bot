import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "bun:test";
import { __test } from "./http";
import { PullRequestSchema } from "./schema";
import { describeProviderError } from "../provider/types";

const { decodeBody } = __test;

describe("decodeBody", () => {
  const schema = Schema.Struct({ iid: Schema.Number });
  const request = { method: "GET", path: "repos/:owner/:repo/issues/1" } as const;

  it("returns the decoded value on success", async () => {
    const value = await Effect.runPromise(decodeBody(request, schema, { iid: 42 }));
    expect(value).toEqual({ iid: 42 });
  });

  it("maps a decode failure to a ProviderResponseError tagged with the request method/path", async () => {
    const either = await Effect.runPromise(
      Effect.either(decodeBody(request, schema, { iid: "not-a-number" })),
    );
    expect(either).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "ProviderResponseError",
        method: "GET",
        path: "repos/:owner/:repo/issues/1",
      },
    });
  });

  it("surfaces the offending field in the decode error detail, capped at 800 chars", async () => {
    const either = await Effect.runPromise(
      Effect.either(decodeBody(request, schema, { iid: "not-a-number" })),
    );
    const detail = Either.match(either, {
      onLeft: (error): string => (error._tag === "ProviderResponseError" ? error.detail : ""),
      onRight: (): string => "",
    });
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.length).toBeLessThanOrEqual(800);
    expect(detail).toMatch(/iid/);
  });

  // An unknown PR `state` (e.g. a future GitHub value) must fail the read rather
  // than coerce to "open" — otherwise the orchestrator could act on a misread
  // lifecycle state. The boundary turns it into the ProviderError the pipeline
  // routes to `failed`, and the failure reason must name the value.
  it("fails a PR read on an unknown state, naming the offending value", async () => {
    const prRequest = { method: "GET", path: "repos/:owner/:repo/pulls/7" } as const;
    const either = await Effect.runPromise(
      Effect.either(
        decodeBody(prRequest, PullRequestSchema, {
          number: 7,
          state: "merging",
          node_id: "PR_x",
          head: { sha: "abc" },
        }),
      ),
    );
    expect(either).toMatchObject({ _tag: "Left", left: { _tag: "ProviderResponseError" } });
    const reason = Either.match(either, {
      onLeft: (error): string => describeProviderError(error),
      onRight: (): string => "",
    });
    expect(reason).toMatch(/merging/);
  });
});
