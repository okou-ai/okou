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
      for (const piEnabled of [false, true]) {
        expect(
          isPiExecutionRoute({
            selectedModel: "deepseek-v4.1-flash",
            modelProviderType,
            runtimeProviderType,
            piEnabled,
            codexServiceTier: undefined,
            codexFastModeEnabled: false,
          }),
        ).toBe(piEnabled && supported);
      }
    },
  );

  it.each(["deepseek-v4-flash", "deepseek-v4-pro"] as const)(
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
            piEnabled: true,
            codexServiceTier: undefined,
            codexFastModeEnabled: false,
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
          piEnabled: true,
          codexServiceTier: undefined,
          codexFastModeEnabled: false,
        }),
      ).toBe(false);
    },
  );
});
