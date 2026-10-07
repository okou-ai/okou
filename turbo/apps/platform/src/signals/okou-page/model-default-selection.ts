import { isMemberRunModelConfigurable } from "@okouai/api-contracts/contracts/member-run-model";
import type {
  AvailableRunModel,
  AvailableRunModelsResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { command } from "ccstate";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import type { ModelCatalog } from "../external/model-catalog.ts";
import { availableRunModels$ } from "../external/run-models.ts";
import { memberRunModelAllowedForPlan } from "./model-plan-capabilities.ts";
import { withChatModelSettings } from "./model-reasoning-effort.ts";

interface UserModelDefaultSource {
  selectedModel: string | null;
  serviceTier?: "priority" | null;
  modelSettings?: ModelSettings;
}

/**
 * A stored selection (member preference, thread pin) resolves along the
 * catalog replacement chain; null is Auto. Unknown models are not selectable.
 */
function createModelFirstSelection(
  selectedModel: string | null | undefined,
  catalog: ModelCatalog | null | undefined,
  modelSettings: ModelSettings = {},
): ModelProviderSelection | null {
  if (selectedModel === null) {
    return { selectedModel: null, modelSettings };
  }
  const resolvedModel = catalog?.resolve(selectedModel);
  if (!resolvedModel) {
    return null;
  }
  return {
    selectedModel: resolvedModel,
    modelSettings,
  };
}

/** Whether the selected subscription model offers the service tier. */
export function isServiceTierAvailableForSelection(params: {
  readonly models: AvailableRunModelsResponse | null | undefined;
  readonly selectedModel: string | null | undefined;
  readonly tier: "priority";
}): boolean {
  const runModel = params.models?.models.find((candidate) => {
    return candidate.model === params.selectedModel;
  });
  // Availability can change without changing this model's Fast capability.
  // Preserve the saved choice through reconnect and plan restrictions; send
  // readiness and admission own whether it can run now.
  return runModel?.subscriptionOptions?.serviceTier === params.tier;
}

/** Whether a configurable runModel row offers the Fast (priority) toggle. */
export function isRunModelFastModeAvailable(
  runModel: AvailableRunModel | undefined,
): boolean {
  return (
    !!runModel &&
    runModel.model !== null &&
    isMemberRunModelConfigurable(runModel) &&
    runModel.subscriptionOptions?.serviceTier === "priority"
  );
}

export function isCodexFastModeAvailableForSelection(params: {
  readonly models: AvailableRunModelsResponse | null | undefined;
  readonly selectedModel: string | null | undefined;
}): boolean {
  return isServiceTierAvailableForSelection({ ...params, tier: "priority" });
}

function hasUsableModelRoute(
  models: AvailableRunModelsResponse | null | undefined,
  model: string | null,
): boolean {
  // Before models load there is no route evidence to reject the preference.
  // Auto is always offered.
  if (!models || model === null) {
    return true;
  }
  // A plan-restricted route stays selected so the composer can offer the
  // upgrade instead of silently switching models.
  return models.models.some((runModel) => {
    return (
      runModel.model === model &&
      (isMemberRunModelConfigurable(runModel) ||
        runModel.memberEffective.availability === "plan_restricted")
    );
  });
}

/**
 * Default for a new chat: the member's saved preference (resolved through the
 * catalog) when its route is usable, otherwise Auto. Null until the catalog
 * loads: a saved preference cannot be resolved without it.
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
    selectedModel: null,
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
    const models = await get(availableRunModels$);
    signal.throwIfAborted();
    const selectedModel = params.selection?.selectedModel;
    const selectedRunModel = models.models.find((runModel) => {
      return runModel.model === selectedModel;
    });
    if (
      selectedRunModel !== undefined &&
      !memberRunModelAllowedForPlan(selectedRunModel)
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
