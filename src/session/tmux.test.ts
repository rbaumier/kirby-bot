import { describe, expect, it } from "bun:test";
import { ENV_KEY_RE, sqEscape } from "./tmux";

describe("sqEscape", () => {
  it("wraps a normal string in single quotes", () => {
    expect(sqEscape("normal")).toBe("'normal'");
  });

  it("escapes an embedded single quote via '\\''", () => {
    expect(sqEscape("it's")).toBe("'it'\\''s'");
  });

  it("escapes two consecutive embedded single quotes", () => {
    expect(sqEscape("''")).toBe("''\\'''\\'''");
  });

  it("preserves spaces in paths without escaping them", () => {
    expect(sqEscape("/tmp/path with spaces/sentinel.flag")).toBe(
      "'/tmp/path with spaces/sentinel.flag'",
    );
  });

  it("round-trips an empty string as two single quotes", () => {
    expect(sqEscape("")).toBe("''");
  });
});

describe("ENV_KEY_RE", () => {
  it("accepts a valid POSIX identifier", () => {
    expect(ENV_KEY_RE.test("AGENT_SENTINEL")).toBe(true);
  });

  it("rejects a key containing shell metacharacters", () => {
    expect(ENV_KEY_RE.test("FOO=bar; echo hax")).toBe(false);
  });

  it("rejects a key starting with a digit", () => {
    expect(ENV_KEY_RE.test("1FOO")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(ENV_KEY_RE.test("")).toBe(false);
  });
});
