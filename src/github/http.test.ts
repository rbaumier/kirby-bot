import { Effect, Either, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { __test } from "./http";
import { PullRequestSchema } from "./schema";
import { describeProviderError } from "../provider/types";

const { decodeBody, decodeGraphQL, graphqlUrlFor, computeConfig } = __test;

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

describe("graphqlUrlFor", () => {
  it("appends /graphql for the default api.github.com host", () => {
    expect(graphqlUrlFor("https://api.github.com")).toBe("https://api.github.com/graphql");
  });

  it("maps a GitHub Enterprise /api/v3 base to its /api/graphql sibling", () => {
    expect(graphqlUrlFor("https://gh.corp.example/api/v3")).toBe(
      "https://gh.corp.example/api/graphql",
    );
  });
});

describe("computeConfig", () => {
  const ENV_KEYS = ["KIRBY_GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_HOST"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("resolves owner/repo, token and the default host + GraphQL URL", () => {
    process.env.KIRBY_GITHUB_TOKEN = "tok";
    process.env.GITHUB_REPO = "rbaumier/kirby-bot";
    const config = computeConfig();
    expect(config).toMatchObject({
      baseUrl: "https://api.github.com",
      graphqlUrl: "https://api.github.com/graphql",
      token: "tok",
      owner: "rbaumier",
      repo: "kirby-bot",
    });
  });

  it("derives the Enterprise GraphQL URL from a custom /api/v3 host", () => {
    process.env.KIRBY_GITHUB_TOKEN = "tok";
    process.env.GITHUB_REPO = "o/r";
    process.env.GITHUB_HOST = "https://gh.corp.example/api/v3";
    expect(computeConfig().graphqlUrl).toBe("https://gh.corp.example/api/graphql");
  });

  // ProviderConfigError carries its text in `detail` (not `.message`), so assert
  // on the thrown error's fields rather than the Error message.
  const detailOfThrow = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      const tagged = error as { _tag?: unknown; detail?: unknown };
      return tagged._tag === "ProviderConfigError"
        ? String(tagged.detail)
        : `wrong error: ${String(error)}`;
    }
    return "did not throw";
  };

  it("fails with a ProviderConfigError when GITHUB_REPO is missing", () => {
    process.env.KIRBY_GITHUB_TOKEN = "tok";
    expect(detailOfThrow(computeConfig)).toMatch(/GITHUB_REPO is not set/);
  });

  it("rejects a malformed GITHUB_REPO that is not exactly owner/repo", () => {
    process.env.KIRBY_GITHUB_TOKEN = "tok";
    process.env.GITHUB_REPO = "owner/repo/extra";
    expect(detailOfThrow(computeConfig)).toMatch(/owner\/repo/);
  });
});

describe("decodeGraphQL", () => {
  const schema = Schema.Struct({ ok: Schema.Boolean });

  it("decodes the data payload against the schema on success", async () => {
    const value = await Effect.runPromise(decodeGraphQL(schema, { data: { ok: true } }));
    expect(value).toEqual({ ok: true });
  });

  // GraphQL signals failure with HTTP 200 + a top-level `errors` array; the
  // boundary must lift it into a ProviderResponseError rather than try to decode
  // the (absent) data — and the reason must carry the GraphQL message.
  it("lifts a top-level errors array into a ProviderResponseError naming the message", async () => {
    const either = await Effect.runPromise(
      Effect.either(decodeGraphQL(schema, { errors: [{ message: "Field 'foo' doesn't exist" }] })),
    );
    expect(either).toMatchObject({ _tag: "Left", left: { _tag: "ProviderResponseError" } });
    const reason = Either.match(either, {
      onLeft: (error): string => describeProviderError(error),
      onRight: (): string => "",
    });
    expect(reason).toMatch(/Field 'foo' doesn't exist/);
  });
});
