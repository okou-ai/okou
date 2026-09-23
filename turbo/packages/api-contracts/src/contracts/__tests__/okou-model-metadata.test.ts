import { describe, expect, it } from "vitest";
import { OKOU_MODEL_METADATA } from "../okou-model-metadata";

describe("Okou model metadata", () => {
  it.each([
    ["okou-1.0", "gpt-6-luna", "@preset/okou-1-0", "max", 3],
    ["okou-1.0-pro", "gpt-6-sol", "@preset/okou-1-0-pro", "low", 2],
    ["okou-1.0-max", "gpt-6-sol", "@preset/okou-1-0-max", "high", 2],
  ] as const)(
    "%s uses its backing model's runtime capabilities",
    (model, backingModel, presetModel, reasoningEffort, codexPriority) => {
      expect(OKOU_MODEL_METADATA[model]).toMatchObject({
        backingModel,
        presetModel,
        reasoningEffort,
        pi: {
          contextWindow: 1_050_000,
          maxTokens: 128_000,
        },
        codex: {
          contextWindow: 272_000,
          maxContextWindow: 872_000,
          priority: codexPriority,
        },
      });
    },
  );
});
