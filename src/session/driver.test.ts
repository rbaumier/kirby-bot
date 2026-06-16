import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ProviderConfigError } from "../provider/types";
import { selectDriver } from "./driver";

describe("selectDriver", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.KIRBY_DRIVER;
    delete process.env.KIRBY_DRIVER;
  });
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.KIRBY_DRIVER;
    } else {
      process.env.KIRBY_DRIVER = saved;
    }
  });

  it("defaults to headless when unset", () => {
    expect(selectDriver()).toBe("headless");
  });

  it("treats the empty string as unset (headless)", () => {
    process.env.KIRBY_DRIVER = "";
    expect(selectDriver()).toBe("headless");
  });

  it("returns headless for KIRBY_DRIVER=headless", () => {
    process.env.KIRBY_DRIVER = "headless";
    expect(selectDriver()).toBe("headless");
  });

  it("returns tmux for KIRBY_DRIVER=tmux", () => {
    process.env.KIRBY_DRIVER = "tmux";
    expect(selectDriver()).toBe("tmux");
  });

  it("throws ProviderConfigError on an unknown value (fail fast)", () => {
    process.env.KIRBY_DRIVER = "ssh";
    expect(() => selectDriver()).toThrow(ProviderConfigError);
  });
});
