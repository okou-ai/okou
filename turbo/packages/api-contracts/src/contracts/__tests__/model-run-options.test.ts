import { describe, expect, it } from "vitest";

import {
  CODEX_FAST_MODE_MODELS,
  supportedRunModelSchema,
} from "../model-providers";
import { getModelRunOptions } from "../model-run-options";

describe("model run options", () => {
  it("configures Fast for exactly the models that support the Fast tier", () => {
    const configured = supportedRunModelSchema.options.filter((model) => {
      return getModelRunOptions(model).fast !== undefined;
    });
    expect([...configured].sort()).toStrictEqual(
      [...CODEX_FAST_MODE_MODELS].sort(),
    );
  });

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

  it("offers a default effort from each model's own effort list", () => {
    for (const model of supportedRunModelSchema.options) {
      const { efforts, defaultEffort } = getModelRunOptions(model);
      if (defaultEffort !== undefined) {
        expect(efforts).toContain(defaultEffort);
      }
    }
  });

  it("resolves OpenAI-prefixed ids and has no options for unknown models", () => {
    expect(getModelRunOptions("openai/gpt-6-luna")).toBe(
      getModelRunOptions("gpt-6-luna"),
    );
    expect(getModelRunOptions("not-a-model")).toStrictEqual({ efforts: [] });
    expect(getModelRunOptions(null)).toStrictEqual({ efforts: [] });
  });
});
