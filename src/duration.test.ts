import { describe, expect, it } from "bun:test";
import { formatDuration } from "./duration";

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [999, "999ms"],
    [850, "850ms"],
    [1000, "1.0s"],
    [4200, "4.2s"],
    [59999, "60.0s"],
    [60000, "1m00s"],
    [65000, "1m05s"],
    [3600000, "60m00s"],
    [3661000, "61m01s"],
  ] as const)("formatDuration(%i) === %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
