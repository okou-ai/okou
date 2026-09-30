import { command } from "ccstate";
import {
  getMemberModelPolicyRoute,
  isMemberModelPolicyConfigurable,
} from "@okouai/api-contracts/contracts/member-model-policy";
import {
  isCodexFastModeModel,
  isSupportedRunModel,
  ORG_DEFAULT_RUN_MODEL,
  type OrgModelPoliciesResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { withChatModelSettings } from "./model-reasoning-effort.ts";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  modelPlanCapabilities$,
  memberModelPolicyAllowedForPlan,
} from "./model-plan-capabilities.ts";

interface UserModelDefaultSource {
  selectedModel: string | null;
  serviceTier?: "priority" | "ultrafast" | null;
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

export function isCodexFastModeAvailableForSelection(params: {
  readonly policies: OrgModelPoliciesResponse | null | undefined;
  readonly selectedModel: string | null | undefined;
}): boolean {
  if (!isCodexFastModeModel(params.selectedModel)) {
    return false;
  }
  const policy = params.policies?.policies.find((candidate) => {
    return candidate.model === params.selectedModel;
  });
  // Availability can change without changing this model's Fast capability.
  // Preserve the saved choice through reconnect, plan restrictions and outages;
  // send readiness and admission own whether it can run now.
  return (
    policy !== undefined &&
    (policy.memberEffective !== undefined || policy.routeStatus === "valid")
  );
}

function hasUsableModelRoute(
  policies: OrgModelPoliciesResponse | null | undefined,
  model: string,
): boolean {
  // Before policies load there is no route evidence to reject the preference.
  if (!policies) {
    return true;
  }
  // A plan-restricted route stays selected so the composer can offer the
  // upgrade instead of silently switching models.
  return policies.policies.some((policy) => {
    return (
      policy.model === model &&
      (isMemberModelPolicyConfigurable(policy) ||
        getMemberModelPolicyRoute(policy).availability === "plan_restricted")
    );
  });
}

/**
 * Default for a new chat: the member's saved preference when its route is
 * usable, otherwise the fixed organization default (Auto).
 */
export function resolveDefaultModelSelection(params: {
  userPreference: UserModelDefaultSource | null | undefined;
  policies: OrgModelPoliciesResponse | null | undefined;
}): ModelProviderSelection {
  const userSelection = resolveModelFirstStoredUserSelection(params);
  if (
    userSelection &&
    hasUsableModelRoute(params.policies, userSelection.selectedModel)
  ) {
    return userSelection;
  }
  return {
    selectedModel: ORG_DEFAULT_RUN_MODEL,
    modelSettings: params.userPreference?.modelSettings ?? {},
  };
}

export function resolveModelFirstStoredUserSelection(params: {
  userPreference: UserModelDefaultSource | null | undefined;
  policies: OrgModelPoliciesResponse | null | undefined;
}): ModelProviderSelection | null {
  const userSelection = createModelFirstSelection(
    params.userPreference?.selectedModel,
    params.userPreference?.modelSettings,
  );
  if (!userSelection) {
    return null;
  }
  if (
    params.userPreference?.serviceTier === "ultrafast" &&
    userSelection.selectedModel === "gpt-6-astra" &&
    params.policies?.policies.some((policy) => {
      return (
        policy.model === "gpt-6-astra" &&
        getMemberModelPolicyRoute(policy).providerType === "openai-api-key"
      );
    })
  ) {
    return { ...userSelection, codexServiceTier: "ultrafast" };
  }
  if (
    params.userPreference?.serviceTier === "priority" &&
    isCodexFastModeAvailableForSelection({
      policies: params.policies,
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
      selectedPolicy !== undefined &&
      !memberModelPolicyAllowedForPlan(selectedPolicy, modelCapabilities)
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
