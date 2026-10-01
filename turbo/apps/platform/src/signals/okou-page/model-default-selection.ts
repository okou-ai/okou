import { command } from "ccstate";
import {
  getMemberModelPolicyRoute,
  isMemberModelPolicyConfigurable,
} from "@okouai/api-contracts/contracts/member-model-policy";
import type {
  OrgModelPoliciesResponse,
  OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import type { ModelCatalog } from "../external/model-catalog.ts";
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
  readonly policies: OrgModelPoliciesResponse | null | undefined;
  readonly catalog: ModelCatalog | null | undefined;
  readonly selectedModel: string | null | undefined;
  readonly tier: "priority" | "ultrafast";
}): boolean {
  const { catalog, selectedModel } = params;
  if (!catalog || !selectedModel) {
    return false;
  }
  const policy = params.policies?.policies.find((candidate) => {
    return candidate.model === selectedModel;
  });
  if (policy === undefined) {
    return false;
  }
  if (policy.subscriptionOptions && params.tier === "priority") {
    return policy.subscriptionOptions.serviceTier === "priority";
  }
  const providerType = getMemberModelPolicyRoute(policy).providerType;
  if (
    !catalog.supportsServiceTier(selectedModel, params.tier, { providerType })
  ) {
    return false;
  }
  // Availability can change without changing this model's Fast capability.
  // Preserve the saved choice through reconnect, plan restrictions and outages;
  // send readiness and admission own whether it can run now.
  return policy.memberEffective !== undefined || policy.routeStatus === "valid";
}

/** Whether a configurable policy row offers the Fast (priority) toggle. */
export function isPolicyFastModeAvailable(
  policy: OrgModelPolicy | undefined,
  catalog: ModelCatalog | null | undefined,
): boolean {
  if (
    !policy ||
    !catalog ||
    !isMemberModelPolicyConfigurable(policy, catalog)
  ) {
    return false;
  }
  if (policy.subscriptionOptions) {
    return policy.subscriptionOptions.serviceTier === "priority";
  }
  return catalog.supportsServiceTier(policy.model, "priority", {
    providerType: getMemberModelPolicyRoute(policy).providerType,
  });
}

/** Whether a policy row's route offers the Ultrafast service tier. */
export function isPolicyUltrafastAvailable(
  policy: OrgModelPolicy,
  catalog: ModelCatalog | null | undefined,
): boolean {
  return (
    catalog?.supportsServiceTier(policy.model, "ultrafast", {
      providerType: getMemberModelPolicyRoute(policy).providerType,
    }) ?? false
  );
}

export function isCodexFastModeAvailableForSelection(params: {
  readonly policies: OrgModelPoliciesResponse | null | undefined;
  readonly catalog: ModelCatalog | null | undefined;
  readonly selectedModel: string | null | undefined;
}): boolean {
  return isServiceTierAvailableForSelection({ ...params, tier: "priority" });
}

function hasUsableModelRoute(
  policies: OrgModelPoliciesResponse | null | undefined,
  catalog: ModelCatalog,
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
      (isMemberModelPolicyConfigurable(policy, catalog) ||
        getMemberModelPolicyRoute(policy).availability === "plan_restricted")
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
  policies: OrgModelPoliciesResponse | null | undefined;
  catalog: ModelCatalog | null | undefined;
}): ModelProviderSelection | null {
  if (!params.catalog) {
    return null;
  }
  const userSelection = resolveModelFirstStoredUserSelection(params);
  if (
    userSelection &&
    hasUsableModelRoute(
      params.policies,
      params.catalog,
      userSelection.selectedModel,
    )
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
  policies: OrgModelPoliciesResponse | null | undefined;
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
    params.userPreference?.serviceTier === "ultrafast" &&
    isServiceTierAvailableForSelection({
      policies: params.policies,
      catalog: params.catalog,
      selectedModel: userSelection.selectedModel,
      tier: "ultrafast",
    })
  ) {
    return { ...userSelection, codexServiceTier: "ultrafast" };
  }
  if (
    params.userPreference?.serviceTier === "priority" &&
    isCodexFastModeAvailableForSelection({
      policies: params.policies,
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
