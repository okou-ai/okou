import {
  getMemberRunModelRoute,
  isMemberRunModelConfigurable,
} from "@okouai/api-contracts/contracts/member-run-model";
import type {
  AvailableRunModel,
  AvailableRunModelsResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { command } from "ccstate";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import type { ModelCatalog } from "../external/model-catalog.ts";
import { availableRunModels$ } from "../external/run-models.ts";
import {
  memberRunModelAllowedForPlan,
  modelPlanCapabilities$,
} from "./model-plan-capabilities.ts";
import { withChatModelSettings } from "./model-reasoning-effort.ts";

interface UserModelDefaultSource {
  selectedModel: string | null;
  serviceTier?: "priority" | null;
  modelSettings?: ModelSettings;
}

/**
 * A stored selection (member preference, thread pin) resolves along the
 * catalog replacement chain. Unknown models are not selectable.
 */
function createModelFirstSelection(
  selectedModel: string | null | undefined,
  catalog: ModelCatalog | null | undefined,
  modelSettings: ModelSettings = {},
): ModelProviderSelection | null {
  const resolvedModel = catalog?.resolve(selectedModel);
  if (!resolvedModel) {
    return null;
  }
  return {
    selectedModel: resolvedModel,
    modelSettings,
  };
}

/** Whether the model's selected route offers a catalog service tier. */
export function isServiceTierAvailableForSelection(params: {
  readonly models: AvailableRunModelsResponse | null | undefined;
  readonly catalog: ModelCatalog | null | undefined;
  readonly selectedModel: string | null | undefined;
  readonly tier: "priority";
}): boolean {
  const { catalog, selectedModel } = params;
  if (!catalog || !selectedModel) {
    return false;
  }
  const runModel = params.models?.models.find((candidate) => {
    return candidate.model === selectedModel;
  });
  if (runModel === undefined) {
    return false;
  }
  if (runModel.subscriptionOptions && params.tier === "priority") {
    return runModel.subscriptionOptions.serviceTier === "priority";
  }
  const providerType = getMemberRunModelRoute(runModel).providerType;
  if (
    !catalog.supportsServiceTier(selectedModel, params.tier, { providerType })
  ) {
    return false;
  }
  // Availability can change without changing this model's Fast capability.
  // Preserve the saved choice through reconnect and plan restrictions; send
  // readiness and admission own whether it can run now.
  return true;
}

/** Whether a configurable runModel row offers the Fast (priority) toggle. */
export function isRunModelFastModeAvailable(
  runModel: AvailableRunModel | undefined,
  catalog: ModelCatalog | null | undefined,
): boolean {
  if (!runModel || !catalog || !isMemberRunModelConfigurable(runModel)) {
    return false;
  }
  if (runModel.subscriptionOptions) {
    return runModel.subscriptionOptions.serviceTier === "priority";
  }
  return catalog.supportsServiceTier(runModel.model, "priority", {
    providerType: getMemberRunModelRoute(runModel).providerType,
  });
}

export function isCodexFastModeAvailableForSelection(params: {
  readonly models: AvailableRunModelsResponse | null | undefined;
  readonly catalog: ModelCatalog | null | undefined;
  readonly selectedModel: string | null | undefined;
}): boolean {
  return isServiceTierAvailableForSelection({ ...params, tier: "priority" });
}

function hasUsableModelRoute(
  models: AvailableRunModelsResponse | null | undefined,
  model: string,
): boolean {
  // Before models load there is no route evidence to reject the preference.
  if (!models) {
    return true;
  }
  // A plan-restricted route stays selected so the composer can offer the
  // upgrade instead of silently switching models.
  return models.models.some((runModel) => {
    return (
      runModel.model === model &&
      (isMemberRunModelConfigurable(runModel) ||
        getMemberRunModelRoute(runModel).availability === "plan_restricted")
    );
  });
}

/**
 * Default for a new chat: the member's saved preference (resolved through the
 * catalog) when its route is usable, otherwise the catalog system default.
 * Null until the catalog loads: there is no product default without it.
 */
export function resolveDefaultModelSelection(params: {
  userPreference: UserModelDefaultSource | null | undefined;
  models: AvailableRunModelsResponse | null | undefined;
  catalog: ModelCatalog | null | undefined;
}): ModelProviderSelection | null {
  if (!params.catalog) {
    return null;
  }
  const userSelection = resolveModelFirstStoredUserSelection(params);
  if (
    userSelection &&
    hasUsableModelRoute(params.models, userSelection.selectedModel)
  ) {
    return userSelection;
  }
  return {
    selectedModel: params.catalog.systemDefaultModel,
    modelSettings: params.userPreference?.modelSettings ?? {},
  };
}

export function resolveModelFirstStoredUserSelection(params: {
  userPreference: UserModelDefaultSource | null | undefined;
  models: AvailableRunModelsResponse | null | undefined;
  catalog: ModelCatalog | null | undefined;
}): ModelProviderSelection | null {
  const userSelection = createModelFirstSelection(
    params.userPreference?.selectedModel,
    params.catalog,
    params.userPreference?.modelSettings,
  );
  if (!userSelection) {
    return null;
  }
  if (
    params.userPreference?.serviceTier === "priority" &&
    isCodexFastModeAvailableForSelection({
      models: params.models,
      catalog: params.catalog,
      selectedModel: userSelection.selectedModel,
    })
  ) {
    return { ...userSelection, codexServiceTier: "fast" };
  }
  return userSelection;
}

type ExplicitModelSelectionResult =
  | { kind: "compare-plans" }
  | { kind: "select"; selection: ModelProviderSelection | null };

export const resolveExplicitModelSelection$ = command(
  async (
    { get },
    params: {
      selection: ModelProviderSelection | null;
      previousSelection: ModelProviderSelection | null;
    },
    signal: AbortSignal,
  ): Promise<ExplicitModelSelectionResult> => {
    const [models, modelCapabilities] = await Promise.all([
      get(availableRunModels$),
      get(modelPlanCapabilities$),
    ]);
    signal.throwIfAborted();
    const selectedModel = params.selection?.selectedModel;
    const selectedRunModel = models.models.find((runModel) => {
      return runModel.model === selectedModel;
    });
    if (
      selectedRunModel !== undefined &&
      !memberRunModelAllowedForPlan(selectedRunModel, modelCapabilities)
    ) {
      return { kind: "compare-plans" };
    }
    return {
      kind: "select",
      selection: withChatModelSettings(
        params.selection,
        params.previousSelection,
      ),
    };
  },
);
