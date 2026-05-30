import { describe, expect, it } from "bun:test";
import { REVIEW_ESCALATION_DIFF_BYTES, pickReviewModel } from "./config";

describe("pickReviewModel", () => {
  it("iteration 0, small diff → haiku", () => {
    expect(pickReviewModel(0, REVIEW_ESCALATION_DIFF_BYTES - 1)).toBe("haiku");
  });

  it("iteration 1 → sonnet", () => {
    expect(pickReviewModel(1, 0)).toBe("sonnet");
  });

  it("iteration 2 → sonnet", () => {
    expect(pickReviewModel(2, 0)).toBe("sonnet");
  });

  it("large diff at iteration 0, at threshold → sonnet", () => {
    expect(pickReviewModel(0, REVIEW_ESCALATION_DIFF_BYTES)).toBe("sonnet");
  });

  it("large diff at iteration 0, just below threshold → haiku", () => {
    expect(pickReviewModel(0, REVIEW_ESCALATION_DIFF_BYTES - 1)).toBe("haiku");
  });
});
