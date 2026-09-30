import {
  MODEL_PROVIDER_TYPES,
  isBuiltInModelProviderType,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { i18n } from "../../../../i18n/index.ts";
import type { ModelCatalog } from "../../../../signals/external/model-catalog.ts";

/** Display price tiers; which tier a model has comes from the catalog. */
export type ModelPriceTier = "$" | "$$" | "$$$" | "$$$$";

const MODEL_PRICE_TIERS: ReadonlySet<string> = new Set([
  "$",
  "$$",
  "$$$",
  "$$$$",
]);

function isModelPriceTier(value: string | null): value is ModelPriceTier {
  return value !== null && MODEL_PRICE_TIERS.has(value);
}

/** The catalog's Built-in display price tier of a model, if it has one. */
export function getCatalogModelPriceTier(
  catalog: ModelCatalog | null | undefined,
  model: string,
): ModelPriceTier | undefined {
  const tier = catalog?.priceTier(model) ?? null;
  return isModelPriceTier(tier) ? tier : undefined;
}

/**
 * Get the display label for a provider type (UI override or core fallback)
 */
export function getUILabel(type: ModelProviderType): string {
  if (isBuiltInModelProviderType(type)) {
    return i18n.t(($) => {
      return $.settings.models.picker.builtInModel;
    });
  }
  switch (type) {
    case "claude-code-oauth-token": {
      return i18n.t(($) => {
        return $.settings.models.picker.providerLabels.claudeCodeOauth;
      });
    }
    case "deepseek": {
      return i18n.t(($) => {
        return $.settings.models.picker.providerLabels.deepseek;
      });
    }
    case "azure-foundry": {
      return i18n.t(($) => {
        return $.settings.models.picker.providerLabels.azureFoundryPortal;
      });
    }
    default: {
      return MODEL_PROVIDER_TYPES[type].label;
    }
  }
}

export function getBuiltInModelPriceTierLabel(tier: ModelPriceTier): string {
  switch (tier) {
    case "$": {
      return i18n.t(($) => {
        return $.settings.models.picker.priceTiers.economy;
      });
    }
    case "$$": {
      return i18n.t(($) => {
        return $.settings.models.picker.priceTiers.balanced;
      });
    }
    case "$$$": {
      return i18n.t(($) => {
        return $.settings.models.picker.priceTiers.frontier;
      });
    }
    case "$$$$": {
      return i18n.t(($) => {
        return $.settings.models.picker.priceTiers.premium;
      });
    }
  }
}

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
  "anthropic-api-key",
  "openai-api-key",
  "deepseek",
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
