import { command } from "ccstate";
import {
  isCodexFastModeModel,
  isSupportedRunModel,
  type OrgModelPoliciesResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { withChatModelSettings } from "./model-reasoning-effort.ts";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  modelAllowedForPlan,
  modelPlanCapabilities$,
  modelPolicyAllowedForPlan,
} from "./model-plan-capabilities.ts";

interface UserModelDefaultSource {
  selectedModel: string | null;
  serviceTier?: "priority" | null;
  modelSettings?: ModelSettings;
}

function createModelFirstSelection(
  selectedModel: string | null | undefined,
  modelSettings: ModelSettings = {},
): ModelProviderSelection | null {
  if (!isSupportedRunModel(selectedModel)) {
    return null;
  }
  return {
    selectedModel,
    modelSettings,
  };
}

function resolveModelFirstWorkspaceDefaultSelection(
  policies: OrgModelPoliciesResponse | null | undefined,
  modelSettings: ModelSettings = {},
): ModelProviderSelection | null {
  const defaultPolicy = policies?.policies.find((policy) => {
    return policy.isDefault && policy.routeStatus === "valid";
  });
  return createModelFirstSelection(
    defaultPolicy?.model ?? policies?.workspaceDefaultModel,
    modelSettings,
  );
}

export function isCodexFastModeAvailableForSelection(params: {
  readonly policies: OrgModelPoliciesResponse | null | undefined;
  readonly selectedModel: string | null | undefined;
  readonly codexFastModeEnabled: boolean;
}): boolean {
  if (
    !params.codexFastModeEnabled ||
    !isCodexFastModeModel(params.selectedModel)
  ) {
    return false;
  }
  const policy = params.policies?.policies.find((candidate) => {
    return candidate.model === params.selectedModel;
  });
  return policy?.routeStatus === "valid";
}

export function resolveModelFirstUserDefaultSelection(params: {
  userPreference: UserModelDefaultSource | null | undefined;
  policies: OrgModelPoliciesResponse | null | undefined;
  codexFastModeEnabled: boolean;
}): ModelProviderSelection | null {
  const userSelection = resolveModelFirstStoredUserSelection(params);
  return (
    userSelection ??
    resolveModelFirstWorkspaceDefaultSelection(
      params.policies,
      params.userPreference?.modelSettings,
    )
  );
}

export function resolveModelFirstStoredUserSelection(params: {
  userPreference: UserModelDefaultSource | null | undefined;
  policies: OrgModelPoliciesResponse | null | undefined;
  codexFastModeEnabled: boolean;
}): ModelProviderSelection | null {
  const userSelection = createModelFirstSelection(
    params.userPreference?.selectedModel,
    params.userPreference?.modelSettings,
  );
  if (!userSelection) {
    return null;
  }
  if (
    params.userPreference?.serviceTier === "priority" &&
    isCodexFastModeAvailableForSelection({
      policies: params.policies,
      selectedModel: userSelection.selectedModel,
      codexFastModeEnabled: params.codexFastModeEnabled,
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
    const [policies, modelCapabilities] = await Promise.all([
      get(orgModelPolicies$),
      get(modelPlanCapabilities$),
    ]);
    signal.throwIfAborted();
    const selectedModel = params.selection?.selectedModel;
    const selectedPolicy = policies.policies.find((policy) => {
      return policy.model === selectedModel;
    });
    if (
      !modelAllowedForPlan(selectedModel, modelCapabilities) ||
      (selectedPolicy !== undefined &&
        !modelPolicyAllowedForPlan(selectedPolicy, modelCapabilities))
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
