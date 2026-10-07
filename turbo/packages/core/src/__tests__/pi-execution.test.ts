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
    expect(piRouteCatalogIdentities(args)).toStrictEqual([
      { provider: "openrouter", model: "okou-1.0" },
    ]);
  });

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

  it("does not carry fast on the fixed Auto route", () => {
    expect(
      isPiExecutionRoute({
        catalogModel: piCatalogModel(null, "okou-1.0"),
        modelProviderType: "built-in",
        runtimeProviderType: "openrouter-codex",
        codexServiceTier: "fast",
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
