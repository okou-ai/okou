import { describe, expect, it } from "vitest";
import { userMessageDocumentSchema } from "@okouai/api-contracts/contracts/chat-threads";
import {
  getModelDisplayName,
  getRunModelDisplayName,
} from "../model-display-name";
import {
  AUTO_RUN_MODEL,
  AUTO_RUN_PRICING_PROVIDER,
  autoRunBillingProvider,
  autoRunPricingLongContextMinTotalInputTokens,
  explicitModelSettings,
  isAutoSelectedModel,
  sameSelectedModel,
  isAutoRunPreset,
} from "../auto-run-model";
import { chatInputModelSelectionSchema } from "@okouai/api-contracts/contracts/chat-input-model";
import { isPiExecutionRoute, piCatalogModel } from "../pi-execution";

describe("selected and runtime Auto identities", () => {
  it.each([
    "@preset/okou-1-0",
    "@preset/okou-experimental",
    "@preset/okou-1-0-dsf",
  ])(
    "uses captured runtime %s without reinterpreting old billing",
    (runtime) => {
      expect(autoRunBillingProvider("auto", runtime)).toBe(runtime);
      expect(autoRunBillingProvider("okou-1.0", runtime)).toBe("okou-1.0");
    },
  );
  it.each(["auto", "okou-1.0"])(
    "reads and displays a nonempty %s history annotation",
    (selectedModel) => {
      const document = {
        version: 1,
        parts: [{ type: "model", selectedModel }],
      };
      expect(userMessageDocumentSchema.parse(document)).toEqual(document);
      expect(getModelDisplayName(selectedModel)).toBe("Auto");
      expect(getRunModelDisplayName(selectedModel, null)).toBeUndefined();
      expect(
        userMessageDocumentSchema.safeParse({
          version: 1,
          parts: [{ type: "model", selectedModel: "" }],
        }).success,
      ).toBe(false);
    },
  );
  it("keeps absence distinct from an explicit captured Auto decision", () => {
    expect(isAutoSelectedModel(null)).toBe(false);
    expect(isAutoSelectedModel(undefined)).toBe(false);
    expect(isAutoSelectedModel("@preset/okou-1-0")).toBe(false);
    expect(chatInputModelSelectionSchema.nullable().parse(null)).toBeNull();
    expect(
      chatInputModelSelectionSchema.parse({
        selectedModel: "auto",
        codexServiceTier: null,
        reasoningEffort: null,
      }),
    ).toMatchObject({ selectedModel: "auto" });
    expect(
      chatInputModelSelectionSchema.safeParse({
        selectedModel: "",
        codexServiceTier: null,
        reasoningEffort: null,
      }).success,
    ).toBe(false);
    expect(sameSelectedModel(undefined, "auto")).toBe(false);
    expect(sameSelectedModel(null, "auto")).toBe(true);
    expect(sameSelectedModel(AUTO_RUN_MODEL, "auto")).toBe(true);
    expect(AUTO_RUN_MODEL).toBe("okou-1.0");
    expect(AUTO_RUN_PRICING_PROVIDER).toBe("okou-1.0");
  });
  it.each(["okou-1.0", "auto"])(
    "admits %s without a selection catalog and never offers Fast",
    (model) => {
      const route = {
        catalogModel: piCatalogModel(null, model),
        modelProviderType: "built-in",
        runtimeProviderType: "openrouter-codex",
        codexServiceTier: undefined,
      };
      expect(isPiExecutionRoute(route)).toBe(true);
      expect(isPiExecutionRoute({ ...route, codexServiceTier: "fast" })).toBe(
        false,
      );
    },
  );
  it("copies only explicit effort preferences without mutating retained history", () => {
    const settings = {
      auto: { effort: "high" },
      "okou-1.0": { effort: "max" },
      "okou-1.0-pro": { effort: "high" },
      "okou-1.0-max": { effort: "xhigh" },
      "@preset/okou-1-0": { effort: "high" },
      "claude-sonnet-5-5": { effort: "extra" },
      "gpt-6.1-sol": { effort: "medium" },
    };
    expect(explicitModelSettings(settings)).toEqual({
      "claude-sonnet-5-5": { effort: "extra" },
      "gpt-6.1-sol": { effort: "medium" },
    });
    expect(settings.auto).toEqual({ effort: "high" });
  });
  it.each([
    [100000, false, false],
    [100001, true, false],
    [272000, true, false],
    [272001, true, true],
  ])(
    "classifies %i input tokens under new Haiku and retained legacy tariffs",
    (inputTokens, canonicalLong, legacyLong) => {
      expect(
        inputTokens >= autoRunPricingLongContextMinTotalInputTokens("auto"),
      ).toBe(canonicalLong);
      expect(
        inputTokens >= autoRunPricingLongContextMinTotalInputTokens("okou-1.0"),
      ).toBe(legacyLong);
    },
  );
  it("bounds executable runtime identity to the captured SQL column", () => {
    expect(isAutoRunPreset(`@preset/${"x".repeat(247)}`)).toBe(true);
    expect(isAutoRunPreset(`@preset/${"x".repeat(248)}`)).toBe(false);
    expect(isAutoRunPreset("@preset/")).toBe(false);
  });
});
