import { describe, expect, it } from "vitest";
import {
  isPiAdmittedRoute,
  isPiExecutionRoute,
  piCatalogModel,
  piRouteCatalogIdentities,
} from "../pi-execution";
import {
  SEEDED_MODEL_CATALOG,
  SEEDED_ROUTED_MODELS,
} from "./seeded-model-catalog";

// Custom's combinatorial platform/BYOK/gateway matrix is retired. Enumerate
// the remaining source boundary so adding catalog rows cannot reopen it.
describe("Auto-only platform admission", () => {
  it("admits only Auto from the platform, regardless of legacy catalog rows", () => {
    const admitted = SEEDED_ROUTED_MODELS.filter((model) => {
      return isPiExecutionRoute({
        catalogModel: piCatalogModel(SEEDED_MODEL_CATALOG, model),
        modelProviderType: "built-in",
        runtimeProviderType: "openrouter-codex",
        codexServiceTier: undefined,
      });
    });
    expect(admitted).toStrictEqual(["okou-1.0"]);
  });

  it("keeps Pi-eligible Codex subscriptions independent of platform routes", () => {
    const models = new Set(
      SEEDED_MODEL_CATALOG.routes
        .filter((route) => {
          return (
            route.enabled &&
            route.subscriptionType === "codex-oauth-token" &&
            SEEDED_MODEL_CATALOG.models.some((model) => {
              return (
                model.model === route.model &&
                model.piRouteClass === "gpt-codex"
              );
            })
          );
        })
        .map((route) => {
          return route.model;
        }),
    );
    expect(models.size).toBeGreaterThan(0);
    for (const model of models) {
      const args = {
        catalogModel: piCatalogModel(SEEDED_MODEL_CATALOG, model),
        modelProviderType: "codex-oauth-token",
        runtimeProviderType: "codex-oauth-token",
        codexServiceTier: undefined,
      } as const;
      expect(isPiAdmittedRoute(args)).toBe(true);
      expect(piRouteCatalogIdentities(args)).toStrictEqual([
        { provider: "openai-codex", model },
      ]);
      expect(isPiExecutionRoute(args)).toBe(true);
    }
  });

  it("does not admit Claude subscriptions to Pi", () => {
    for (const route of SEEDED_MODEL_CATALOG.routes) {
      if (route.subscriptionType !== "claude-code-oauth-token") continue;
      expect(
        isPiAdmittedRoute({
          catalogModel: piCatalogModel(SEEDED_MODEL_CATALOG, route.model),
          modelProviderType: "claude-code-oauth-token",
          runtimeProviderType: "claude-code-oauth-token",
          codexServiceTier: undefined,
        }),
      ).toBe(false);
    }
  });
});
