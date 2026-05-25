import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "bun:test";
import { __test } from "./http";

const { parseRemoteUrl, parseTokenFromYaml, decodeBodyOrFail } = __test;

describe("parseRemoteUrl", () => {
  it("parses an ssh remote", () => {
    expect(parseRemoteUrl("git@gitlab.com:acme/widget.git")).toEqual({
      host: "gitlab.com",
      path: "acme/widget",
    });
  });

  it("parses an https remote without .git", () => {
    expect(parseRemoteUrl("https://gitlab.example.com/team/sub/repo")).toEqual({
      host: "gitlab.example.com",
      path: "team/sub/repo",
    });
  });

  it("parses an https remote with embedded credentials", () => {
    expect(parseRemoteUrl("https://oauth2:abc@gitlab.com/acme/widget.git")).toEqual({
      host: "gitlab.com",
      path: "acme/widget",
    });
  });

  it("returns null on an unparseable url", () => {
    expect(parseRemoteUrl("ftp://nope")).toBeNull();
  });
});

describe("parseTokenFromYaml", () => {
  it("reads the token from a hosts.<host>.token block", () => {
    const yaml = [
      "hosts:",
      "  gitlab.com:",
      '    token: "secret-value"',
      "    user: alice",
      "  gitlab.other.com:",
      "    token: other-token",
    ].join("\n");
    expect(parseTokenFromYaml(yaml, "gitlab.com")).toBe("secret-value");
    expect(parseTokenFromYaml(yaml, "gitlab.other.com")).toBe("other-token");
  });

  it("returns null when the host block is absent", () => {
    const yaml = "hosts:\n  gitlab.com:\n    token: x\n";
    expect(parseTokenFromYaml(yaml, "missing.example.com")).toBeNull();
  });

  it("returns null when the token field is absent", () => {
    const yaml = "hosts:\n  gitlab.com:\n    user: alice\n";
    expect(parseTokenFromYaml(yaml, "gitlab.com")).toBeNull();
  });
});

describe("decodeBodyOrFail", () => {
  const schema = Schema.Struct({ iid: Schema.Number });
  const request = { method: "GET", path: "projects/:id/issues/1" } as const;

  it("returns the decoded value on success", async () => {
    const value = await Effect.runPromise(decodeBodyOrFail(request, schema, { iid: 42 }));
    expect(value).toEqual({ iid: 42 });
  });

  it("maps a decode failure to a GitLabResponseError tagged with the request method/path", async () => {
    const either = await Effect.runPromise(
      Effect.either(decodeBodyOrFail(request, schema, { iid: "not-a-number" })),
    );
    expect(either).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "GitLabResponseError",
        method: "GET",
        path: "projects/:id/issues/1",
      },
    });
  });

  it("surfaces the offending field in the decode error detail", async () => {
    const either = await Effect.runPromise(
      Effect.either(decodeBodyOrFail(request, schema, { iid: "not-a-number" })),
    );
    const detail = Either.match(either, {
      onLeft: (error): string =>
        error._tag === "GitLabResponseError" ? error.detail : "",
      onRight: (): string => "",
    });
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.length).toBeLessThanOrEqual(800);
    expect(detail).toMatch(/iid/);
  });
});
