import { describe, expect, it } from "vitest";
import {
  getOpenRouterBaseUrl,
  type OpenRouterApi,
} from "../openrouter-routing";
import {
  getModelProviderFirewall,
  getModelProviderPiEndpoint,
} from "../model-provider-firewalls";

const verified: readonly (readonly [OpenRouterApi, string])[] = [
  ["messages", "anthropic/claude-opus-5"],
  ["messages", "anthropic/claude-opus-4.8"],
  ["messages", "anthropic/claude-sonnet-5"],
  ["messages", "anthropic/claude-sonnet-4.6"],
  ["responses", "deepseek/deepseek-v4.1-flash"],
  ["responses", "deepseek/deepseek-v4-flash"],
  ["responses", "deepseek/deepseek-v4-pro"],
  ["responses", "openai/gpt-6-astra"],
  ["responses", "openai/gpt-5.6-sol"],
  ["responses", "openai/gpt-5.6-terra"],
  ["responses", "openai/gpt-5.6-luna"],
];

describe("platform OpenRouter regional selection", () => {
  it.each(verified)(
    "gates verified %s %s by switch and credential ownership",
    (api, model) => {
      const path = api === "messages" ? "/api" : "/api/v1";
      for (const credentialOwner of [
        "builtin",
        "organization",
        "member",
      ] as const) {
        for (const usRoutingEnabled of [false, true]) {
          expect(
            getOpenRouterBaseUrl(api, {
              model,
              credentialOwner,
              usRoutingEnabled,
            }),
          ).toBe(
            `https://${credentialOwner === "builtin" && usRoutingEnabled ? "us." : ""}openrouter.ai${path}`,
          );
        }
      }
    },
  );

  it.each([
    ["messages", "anthropic/claude-fable-5.1"],
    ["chat/completions", "openai/gpt-5.6-terra"],
    ["responses", "google/gemini-3.6-flash"],
    ["chat/completions", "google/gemini-3.8-flash"],
    ["audio/transcriptions", "openai/gpt-4o-transcribe"],
    ["responses", "new/unverified-model"],
  ] as const)("keeps unverified %s %s global when enabled", (api, model) => {
    expect(
      getOpenRouterBaseUrl(api, {
        model,
        credentialOwner: "builtin",
        usRoutingEnabled: true,
      }),
    ).toBe(`https://openrouter.ai${api === "messages" ? "/api" : "/api/v1"}`);
  });

  it("binds US Responses auth to the exact selected path without migrating unverified Chat Completions", () => {
    const routing = {
      model: "openai/gpt-5.6-terra",
      credentialOwner: "builtin",
      usRoutingEnabled: true,
    } as const;
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
    expect(
      getModelProviderFirewall("openrouter-codex", {
        ...routing,
        credentialOwner: "organization",
      }),
    ).toEqual(getModelProviderFirewall("openrouter-codex"));
  });

  it("binds US Messages auth to /api/v1/messages and leaves direct providers unchanged", () => {
    const routing = {
      model: "anthropic/claude-sonnet-4.6",
      credentialOwner: "builtin",
      usRoutingEnabled: true,
    } as const;
    expect(
      getModelProviderFirewall("openrouter-api-key", routing)?.apis,
    ).toEqual([
      expect.objectContaining({
        base: "https://us.openrouter.ai/api/v1/messages",
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.OPENROUTER_API_KEY }}",
          },
        },
      }),
    ]);
    expect(getModelProviderFirewall("anthropic-api-key", routing)).toEqual(
      getModelProviderFirewall("anthropic-api-key"),
    );
  });
});
