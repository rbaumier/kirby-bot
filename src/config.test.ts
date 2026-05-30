import { describe, expect, test } from "bun:test";
import { maxModel, REVIEW_ESCALATION_DIFF_BYTES, selectReviewModel } from "./config";

describe("selectReviewModel", () => {
  test("first pass on a small diff stays on haiku", () => {
    expect(selectReviewModel(0, 1_024)).toBe("haiku");
  });

  test("re-review escalates to sonnet regardless of size", () => {
    expect(selectReviewModel(1, 0)).toBe("sonnet");
    expect(selectReviewModel(2, 1_024)).toBe("sonnet");
  });

  test("first pass at the threshold stays on haiku", () => {
    expect(selectReviewModel(0, REVIEW_ESCALATION_DIFF_BYTES)).toBe("haiku");
  });

  test("first pass one byte over the threshold escalates to sonnet", () => {
    expect(selectReviewModel(0, REVIEW_ESCALATION_DIFF_BYTES + 1)).toBe("sonnet");
  });
});

describe("maxModel", () => {
  test("returns the more capable tier", () => {
    expect(maxModel("haiku", "sonnet")).toBe("sonnet");
    expect(maxModel("sonnet", "haiku")).toBe("sonnet");
    expect(maxModel("sonnet", "opus")).toBe("opus");
  });

  test("never downgrades an already-higher agent tier", () => {
    expect(maxModel("opus", "sonnet")).toBe("opus");
    expect(maxModel("sonnet", "sonnet")).toBe("sonnet");
  });
});
