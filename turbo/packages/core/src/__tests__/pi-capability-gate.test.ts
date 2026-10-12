import { describe, expect, it, vi } from "vitest";
import {
  isPiAdmittedRoute,
  isPiExecutionRoute,
  piCatalogModel,
} from "../pi-execution";
import type { PiRuntimeIdentity } from "../pi-runtime-capability";
import { SEEDED_MODEL_CATALOG } from "./seeded-model-catalog";

// The pinned runtime capability gate remains load-bearing for the fixed Auto
// route, not merely for the retired platform multi-model catalog.
vi.mock("../pi-runtime-capability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../pi-runtime-capability")>();
  return {
    ...actual,
    isPiRuntimeIdentityResolvable: (identity: PiRuntimeIdentity): boolean => {
      return identity.provider === "openrouter" && identity.model === "auto"
        ? false
        : actual.isPiRuntimeIdentityResolvable(identity);
    },
  };
});

describe("Pi capability gate", () => {
  it("refuses Auto execution if its pinned runtime identity is absent", () => {
    const args = {
      catalogModel: piCatalogModel(null, "okou-1.0"),
      modelProviderType: "built-in",
      runtimeProviderType: "openrouter-codex",
      codexServiceTier: undefined,
    } as const;
    expect(isPiAdmittedRoute(args)).toBe(true);
    expect(isPiExecutionRoute(args)).toBe(false);
  });

  it("leaves a resolvable personal Codex subscription available", () => {
    expect(
      isPiExecutionRoute({
        catalogModel: piCatalogModel(SEEDED_MODEL_CATALOG, "gpt-6-luna"),
        modelProviderType: "codex-oauth-token",
        runtimeProviderType: "codex-oauth-token",
        codexServiceTier: undefined,
      }),
    ).toBe(true);
  });
});
