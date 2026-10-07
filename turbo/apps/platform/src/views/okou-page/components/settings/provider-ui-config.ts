import type { ModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { i18n } from "../../../../i18n/index.ts";
import type { ModelCatalog } from "../../../../signals/external/model-catalog.ts";

/** Display price tiers; which tier a model has comes from the catalog. */
export type ModelPriceTier = "$" | "$$" | "$$$" | "$$$$";

/**
 * Media tiers compare one generation against the others in the same category,
 * so they read as cost per artifact rather than as the run-model capability
 * ladder the same badge carries for chat.
 */
export function getMediaModelPriceTierLabel(tier: ModelPriceTier): string {
  switch (tier) {
    case "$": {
      return i18n.t(($) => {
        return $.settings.models.picker.generationPriceTiers.lowest;
      });
    }
    case "$$": {
      return i18n.t(($) => {
        return $.settings.models.picker.generationPriceTiers.typical;
      });
    }
    case "$$$": {
      return i18n.t(($) => {
        return $.settings.models.picker.generationPriceTiers.higher;
      });
    }
    case "$$$$": {
      return i18n.t(($) => {
        return $.settings.models.picker.generationPriceTiers.highest;
      });
    }
  }
}

// Brand icons follow the vendor that serves a model's routes in the catalog.
const BRAND_ICON_VENDORS: readonly ModelProviderType[] = [
  "claude-code-oauth-token",
  "codex-oauth-token",
];

export function getModelBrandIconType(
  model: string,
  catalog: ModelCatalog | null | undefined,
): ModelProviderType {
  const concreteProviders = new Set(
    (catalog?.routes(model) ?? []).map((route) => {
      return route.concreteProviderType;
    }),
  );
  return (
    BRAND_ICON_VENDORS.find((vendor) => {
      return concreteProviders.has(vendor);
    }) ?? "built-in"
  );
}
