import { describe, expect, it } from "vitest";
import {
  isPiExecutionRoute,
  piCatalogModel,
  piRouteCatalogIdentities,
} from "../pi-execution";
import { SEEDED_MODEL_CATALOG } from "./seeded-model-catalog";

describe("Auto and personal-subscription Pi execution", () => {
  it("runs Auto through OpenRouter without a model catalog", () => {
    const args = {
      catalogModel: piCatalogModel(null, "okou-1.0"),
      modelProviderType: "built-in",
      runtimeProviderType: "openrouter-codex",
      codexServiceTier: undefined,
    } as const;
    expect(isPiExecutionRoute(args)).toBe(true);
    expect(args.catalogModel?.builtIn).toStrictEqual([
      {
        concreteProviderType: "openrouter-codex",
        upstreamModel: "@preset/okou-1-0",
        serviceTiers: [],
      },
    ]);
    expect(piRouteCatalogIdentities(args)).toStrictEqual([
      { provider: "openrouter", model: "okou-1.0" },
    ]);
  });

  it.each(["built-in", "anthropic-api-key", "openai-api-key", "deepseek"])(
    "does not offer old platform GPT models through %s",
    (provider) => {
      expect(
        isPiExecutionRoute({
          catalogModel: piCatalogModel(SEEDED_MODEL_CATALOG, "gpt-6-luna"),
          modelProviderType: provider,
          runtimeProviderType: provider,
          codexServiceTier: undefined,
        }),
      ).toBe(false);
    },
  );

  it("retains personally connected Codex model choice and Fast", () => {
    for (const tier of [undefined, "fast"] as const) {
      expect(
        isPiExecutionRoute({
          catalogModel: piCatalogModel(SEEDED_MODEL_CATALOG, "gpt-6-luna"),
          modelProviderType: "codex-oauth-token",
          runtimeProviderType: "codex-oauth-token",
          codexServiceTier: tier,
        }),
      ).toBe(true);
    }
  });

  it("keeps personal Claude subscriptions on the vendor harness", () => {
    expect(
      isPiExecutionRoute({
        catalogModel: piCatalogModel(SEEDED_MODEL_CATALOG, "claude-opus-5-5"),
        modelProviderType: "claude-code-oauth-token",
        runtimeProviderType: "claude-code-oauth-token",
        codexServiceTier: undefined,
      }),
    ).toBe(false);
  });

  it.each(["fast", "ultrafast"] as const)(
    "does not carry %s on the fixed Auto route",
    (tier) => {
      expect(
        isPiExecutionRoute({
          catalogModel: piCatalogModel(null, "okou-1.0"),
          modelProviderType: "built-in",
          runtimeProviderType: "openrouter-codex",
          codexServiceTier: tier,
        }),
      ).toBe(false);
    },
  );

  it.each([
    "openai-api-key",
    "custom-openai-responses",
    "custom-anthropic-messages",
  ])("rejects the retired %s source even for Auto", (provider) => {
    expect(
      isPiExecutionRoute({
        catalogModel: piCatalogModel(null, "okou-1.0"),
        modelProviderType: provider,
        runtimeProviderType: provider,
        codexServiceTier: undefined,
      }),
    ).toBe(false);
  });

  it("refuses a mismatched concrete provider and unknown models", () => {
    expect(
      isPiExecutionRoute({
        catalogModel: piCatalogModel(null, "okou-1.0"),
        modelProviderType: "built-in",
        runtimeProviderType: "openai-api-key",
        codexServiceTier: undefined,
      }),
    ).toBe(false);
    expect(piCatalogModel(null, "unknown")).toBeNull();
  });
});
