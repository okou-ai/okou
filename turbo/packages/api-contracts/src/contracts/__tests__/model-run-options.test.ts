import { describe, expect, it } from "vitest";

import { getModelRunOptions } from "../model-run-options";

describe("model run options", () => {
  it("keeps each model's Fast speed and cost multipliers", () => {
    expect(getModelRunOptions("gpt-6-astra").fast).toStrictEqual({
      builtInCreditMultiplier: 2,
      chatGptUsageMultiplier: 2.5,
      chatGptSpeedMultiplier: 2,
      apiCostMultiplier: 2,
    });
    expect(getModelRunOptions("gpt-5.6-sol").fast).toStrictEqual({
      builtInCreditMultiplier: 2,
      chatGptUsageMultiplier: 2.5,
      chatGptSpeedMultiplier: 1.5,
      apiCostMultiplier: 2,
      apiSpeedMultiplier: 2.5,
    });
    expect(
      getModelRunOptions("gpt-6-luna").fast?.chatGptSpeedMultiplier,
    ).toBeUndefined();
  });

  it("resolves OpenAI-prefixed ids and has no options for unknown models", () => {
    expect(getModelRunOptions("openai/gpt-6-luna")).toBe(
      getModelRunOptions("gpt-6-luna"),
    );
    expect(getModelRunOptions("not-a-model")).toStrictEqual({});
    expect(getModelRunOptions(null)).toStrictEqual({});
  });
});
