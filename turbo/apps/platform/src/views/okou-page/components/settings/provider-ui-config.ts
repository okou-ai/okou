import {
  MODEL_PROVIDER_TYPES,
  getBuiltInModelPriceTier,
  isBuiltInModelProviderType,
  type ModelProviderType,
  type SupportedRunModel,
  type ModelPriceTier,
} from "@okouai/api-contracts/contracts/model-providers";
import { i18n } from "../../../../i18n/index.ts";

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

const MODEL_BRAND_ICON: Readonly<Record<SupportedRunModel, ModelProviderType>> =
  Object.freeze({
    "claude-fable-5-1": "anthropic-api-key",
    "claude-fable-5": "anthropic-api-key",
    "claude-opus-5": "anthropic-api-key",
    "claude-opus-4-8": "anthropic-api-key",
    "claude-sonnet-5": "anthropic-api-key",
    "claude-sonnet-4-6": "anthropic-api-key",
    "deepseek-v4.1-flash": "deepseek",
    "deepseek-v4-flash": "deepseek",
    "deepseek-v4-pro": "deepseek",
    "gpt-6-astra": "openai-api-key",
    "gpt-5.6-sol": "openai-api-key",
    "gpt-5.6-terra": "openai-api-key",
    "gpt-5.6-luna": "openai-api-key",
    "gpt-5.5": "openai-api-key",
  });

export function getModelBrandIconType(
  model: SupportedRunModel,
): ModelProviderType {
  return MODEL_BRAND_ICON[model];
}
export { getBuiltInModelPriceTier, type ModelPriceTier };
