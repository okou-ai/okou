import { describe, expect, it } from "vitest";

import {
  MODEL_PROVIDER_FIREWALL_CONFIGS,
  getModelProviderPiEndpoint,
} from "../model-provider-firewalls";

const PI_RESPONSES_ROUTES = [
  [
    "openrouter-codex",
    "https://openrouter.ai/api/v1",
    "https://openrouter.ai/api/v1/responses",
  ],
] as const;

function firewallAuthBases(provider: string): readonly string[] {
  const configs: Record<
    string,
    {
      apis: readonly {
        base: string;
        auth?: { headers?: Record<string, string> };
      }[];
    }
  > = MODEL_PROVIDER_FIREWALL_CONFIGS;
  return (configs[provider]?.apis ?? [])
    .filter((api) => {
      return Object.keys(api.auth?.headers ?? {}).length > 0;
    })
    .map((api) => {
      return api.base;
    });
}

describe("model provider firewall covers Pi Responses", () => {
  it.each(PI_RESPONSES_ROUTES)(
    "aligns %s with its exact Responses endpoint",
    (provider, baseUrl, inferenceUrl) => {
      expect(
        getModelProviderPiEndpoint(provider, "openai-responses"),
      ).toStrictEqual({ baseUrl, inferenceUrl });
      expect(inferenceUrl).toMatch(/\/responses$/);
      expect(firewallAuthBases(provider)).toContain(inferenceUrl);
    },
  );

  it("keeps credential injection scoped to inference paths", () => {
    for (const [provider] of PI_RESPONSES_ROUTES) {
      for (const base of firewallAuthBases(provider)) {
        expect(base).toMatch(/\/(chat\/completions|responses)$/);
      }
    }
  });
});

describe("non-Pi endpoint compatibility", () => {
  it("keeps unsupported providers and transports unavailable", () => {
    expect(
      getModelProviderPiEndpoint("claude-code-oauth-token", "openai-responses"),
    ).toBeUndefined();
    expect(
      getModelProviderPiEndpoint("openrouter-codex", "openai-codex-responses"),
    ).toBeUndefined();
  });

  it("leaves the ChatGPT Codex endpoint outside the PiLoop contract", () => {
    expect(
      getModelProviderPiEndpoint("codex-oauth-token", "openai-codex-responses"),
    ).toStrictEqual({
      baseUrl: "https://chatgpt.com/backend-api",
      inferenceUrl: "https://chatgpt.com/backend-api/codex/responses",
    });
  });
});
