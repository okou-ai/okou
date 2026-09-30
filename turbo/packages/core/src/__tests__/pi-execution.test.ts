import { describe, expect, it } from "vitest";
import {
  isPiExecutionRoute,
  piCatalogModel,
  piRouteCatalogIdentities,
  type PiCatalogSource,
  type PiRouteClass,
} from "../pi-execution";
import { SEEDED_MODEL_CATALOG } from "./seeded-model-catalog";

function catalogModel(model: string) {
  return piCatalogModel(SEEDED_MODEL_CATALOG, model);
}

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
          catalogModel: catalogModel("deepseek-v4.1-flash"),
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
            catalogModel: catalogModel(selectedModel),
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
          catalogModel: catalogModel(selectedModel),
          modelProviderType: "built-in",
          runtimeProviderType: "deepseek",
          codexServiceTier: undefined,
        }),
      ).toBe(false);
    },
  );
});

describe("Okou preset Pi admission", () => {
  it.each(["okou-1.0"] as const)(
    "admits %s only on the built-in OpenRouter route",
    (selectedModel) => {
      expect(
        isPiExecutionRoute({
          catalogModel: catalogModel(selectedModel),
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
            catalogModel: catalogModel(selectedModel),
            ...rejected,
          }),
        ).toBe(false);
      }
    },
  );
});

describe("catalog-driven Pi admission", () => {
  it("admits a new catalog model through its catalog route alone", () => {
    const catalog: PiCatalogSource = {
      models: [{ model: "acme-luna-preview", piRouteClass: "gpt-codex" }],
      routes: [
        {
          model: "acme-luna-preview",
          providerType: "built-in",
          concreteProviderType: "openai-api-key",
          subscriptionType: null,
          upstreamModel: "gpt-6-luna",
          enabled: true,
          priority: 0,
          serviceTiers: ["priority"],
        },
      ],
    };
    const route = {
      catalogModel: piCatalogModel(catalog, "acme-luna-preview"),
      modelProviderType: "built-in",
      runtimeProviderType: "openai-api-key",
      codexServiceTier: undefined,
    };
    expect(isPiExecutionRoute(route)).toBe(true);
    expect(piRouteCatalogIdentities(route)).toStrictEqual([
      { provider: "openai", model: "gpt-6-luna" },
    ]);
  });

  function deepSeekV4Catalog(
    piRouteClass: PiRouteClass,
    openRouterUpstream: string,
  ): PiCatalogSource {
    return {
      models: [{ model: "deepseek-v4-flash", piRouteClass }],
      routes: SEEDED_MODEL_CATALOG.routes
        .filter((route) => {
          return route.model === "deepseek-v4-flash";
        })
        .map((route) => {
          return route.providerType === "built-in" &&
            route.concreteProviderType === "openrouter-codex"
            ? { ...route, upstreamModel: openRouterUpstream }
            : route;
        }),
    };
  }

  it.each([
    ["deepseek", true],
    ["gpt-codex", false],
  ] as const)(
    "lets the %s route class decide the deepseek BYOK route",
    (piRouteClass, admitted) => {
      const catalog = deepSeekV4Catalog(
        piRouteClass,
        "deepseek/deepseek-v4-flash",
      );
      expect(
        isPiExecutionRoute({
          catalogModel: piCatalogModel(catalog, "deepseek-v4-flash"),
          modelProviderType: "deepseek",
          runtimeProviderType: "deepseek",
          codexServiceTier: undefined,
        }),
      ).toBe(admitted);
    },
  );

  it("follows the catalog route's upstream model for the runtime identity", () => {
    const catalog = deepSeekV4Catalog(
      "deepseek",
      "deepseek/deepseek-v4.1-flash",
    );
    const route = {
      catalogModel: piCatalogModel(catalog, "deepseek-v4-flash"),
      modelProviderType: "built-in",
      runtimeProviderType: "openrouter-codex",
      codexServiceTier: undefined,
    };
    expect(piRouteCatalogIdentities(route)).toStrictEqual([
      { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" },
    ]);
    expect(isPiExecutionRoute(route)).toBe(true);
  });
});
