import { describe, expect, it } from "vitest";
import { __test } from "./http";

const { parseRemoteUrl, parseTokenFromYaml } = __test;

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
