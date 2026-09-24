import { describe, expect, it } from "vitest";
import { isPiExecutionRoute } from "../pi-execution";

describe("DeepSeek Pi admission", () => {
  it.each([
    ["built-in", "deepseek", true],
    ["built-in", "openrouter-codex", true],
    ["custom-openai-responses", "custom-openai-responses", true],
    ["openrouter-codex", "openrouter-codex", true],
    ["deepseek", "deepseek", false],
    ["built-in", "openai-api-key", false],
    ["openai-api-key", "openai-api-key", false],
    ["vercel-ai-gateway-codex", "vercel-ai-gateway-codex", false],
    ["custom-anthropic-messages", "custom-anthropic-messages", false],
  ] as const)(
    "keeps V4.1 policy for %s via %s",
    (modelProviderType, runtimeProviderType, supported) => {
      expect(
        isPiExecutionRoute({
          selectedModel: "deepseek-v4.1-flash",
          modelProviderType,
          runtimeProviderType,
          codexServiceTier: undefined,
        }),
      ).toBe(supported);
    },
  );

  it.each(["deepseek-v4-flash"] as const)(
    "preserves existing routes for %s",
    (selectedModel) => {
      for (const modelProviderType of [
        "built-in",
        "deepseek",
        "openrouter-codex",
        "custom-openai-responses",
      ]) {
        expect(
          isPiExecutionRoute({
            selectedModel,
            modelProviderType,
            runtimeProviderType: "deepseek",
            codexServiceTier: undefined,
          }),
        ).toBe(true);
      }
    },
  );

  it.each(["deepseek-v4.2-flash", "deepseek-v4-unknown", "deepseek-flash"])(
    "rejects an unauthorized logical model %s",
    (selectedModel) => {
      expect(
        isPiExecutionRoute({
          selectedModel,
          modelProviderType: "built-in",
          runtimeProviderType: "deepseek",
          codexServiceTier: undefined,
        }),
      ).toBe(false);
    },
  );
});

describe("Okou preset Pi admission", () => {
  it.each(["okou-1.0", "okou-1.0-pro", "okou-1.0-max"] as const)(
    "admits %s only on the built-in OpenRouter route",
    (selectedModel) => {
      expect(
        isPiExecutionRoute({
          selectedModel,
          modelProviderType: "built-in",
          runtimeProviderType: "openrouter-codex",
          codexServiceTier: undefined,
        }),
      ).toBe(true);
      for (const rejected of [
        {
          modelProviderType: "openrouter-codex",
          runtimeProviderType: "openrouter-codex",
          codexServiceTier: undefined,
        },
        {
          modelProviderType: "built-in",
          runtimeProviderType: "openai-api-key",
          codexServiceTier: undefined,
        },
        {
          modelProviderType: "built-in",
          runtimeProviderType: "openrouter-codex",
          codexServiceTier: "fast" as const,
        },
      ]) {
        expect(
          isPiExecutionRoute({
            selectedModel,
            ...rejected,
          }),
        ).toBe(false);
      }
    },
  );
});
