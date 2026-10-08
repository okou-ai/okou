import { describe, expect, it } from "vitest";

import { getModelRunOptions } from "../model-run-options";

describe("model run options", () => {
  it("keeps each subscription model's Fast usage multiplier", () => {
    expect(getModelRunOptions("gpt-6-astra").fast).toStrictEqual({
      chatGptUsageMultiplier: 2.5,
    });
    expect(getModelRunOptions("gpt-5.6-sol").fast).toStrictEqual({
      chatGptUsageMultiplier: 2.5,
    });
  });

  it("has no options for unknown models", () => {
    expect(getModelRunOptions("openai/gpt-6-luna")).toStrictEqual({});
    expect(getModelRunOptions("not-a-model")).toStrictEqual({});
    expect(getModelRunOptions(null)).toStrictEqual({});
  });
});
