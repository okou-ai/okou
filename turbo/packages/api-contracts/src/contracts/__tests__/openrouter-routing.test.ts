import { describe, expect, it } from "vitest";
import {
  getOpenRouterBaseUrl,
  type OpenRouterApi,
} from "../openrouter-routing";
import {
  getModelProviderFirewall,
  getModelProviderPiEndpoint,
} from "../model-provider-firewalls";

const usRouted: readonly (readonly [OpenRouterApi, string])[] = [
  ["responses", "openai/gpt-6-astra"],
  ["responses", "openai/gpt-5.6-sol"],
  ["responses", "openai/gpt-5.6-luna"],
];

describe("platform OpenRouter regional selection", () => {
  it.each(usRouted)("routes product-approved US %s %s", (api, model) => {
    expect(getOpenRouterBaseUrl(api, { model })).toBe(
      "https://us.openrouter.ai/api/v1",
    );
  });

  it.each([
    ["chat/completions", "openai/gpt-6-luna"],
    ["responses", "deepseek/deepseek-v4.1-flash"],
    ["responses", "deepseek/deepseek-v4-flash"],
    ["responses", "deepseek/deepseek-v4-pro"],
    ["responses", "google/gemini-3.6-flash"],
    ["chat/completions", "google/gemini-3.8-flash"],
    ["responses", "new/unverified-model"],
  ] as const)("keeps non-US-routed %s %s global", (api, model) => {
    expect(getOpenRouterBaseUrl(api, { model })).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("binds US Responses auth to the exact selected path without migrating unverified Chat Completions", () => {
    const routing = { model: "openai/gpt-6-astra" } as const;
    const endpoint = getModelProviderPiEndpoint(
      "openrouter-codex",
      "openai-responses",
      routing,
    );
    expect(endpoint).toEqual({
      baseUrl: "https://us.openrouter.ai/api/v1",
      inferenceUrl: "https://us.openrouter.ai/api/v1/responses",
    });
    const firewall = getModelProviderFirewall("openrouter-codex", routing);
    expect(
      firewall?.apis
        .map((api) => {
          return api.base;
        })
        .sort(),
    ).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://us.openrouter.ai/api/v1/responses",
    ]);
    expect(
      firewall?.apis.find((api) => {
        return api.base === endpoint?.inferenceUrl;
      })?.auth?.headers,
    ).toEqual({ Authorization: "Bearer ${{ secrets.OPENROUTER_API_KEY }}" });
    expect(firewall?.placeholders).toEqual(
      getModelProviderFirewall("openrouter-codex")?.placeholders,
    );
    expect(
      getModelProviderPiEndpoint("openrouter-codex", "openai-responses")
        ?.baseUrl,
    ).toBe("https://openrouter.ai/api/v1");
  });
});
