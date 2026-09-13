import { computed } from "ccstate";
import {
  isLimitedFree1RestrictedRunModel,
  isBuiltInModelProviderType,
  type ModelProviderType,
  type OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";

import { orgPlanCapabilities$ } from "./org-plan-capabilities.ts";

export interface ModelPlanCapabilities {
  readonly supportByok: boolean;
  readonly restrictedBuiltInModels: boolean;
}

export const DEFAULT_MODEL_PLAN_CAPABILITIES =
  Object.freeze<ModelPlanCapabilities>({
    supportByok: true,
    restrictedBuiltInModels: false,
  });

export const modelPlanCapabilities$ = computed(
  async (get): Promise<ModelPlanCapabilities> => {
    const capabilities = await get(orgPlanCapabilities$);
    return {
      supportByok: capabilities.supportByok,
      restrictedBuiltInModels: capabilities.restrictedBuiltInModels,
    };
  },
);

export function modelAllowedForPlan(
  model: string | null | undefined,
  capabilities: Pick<ModelPlanCapabilities, "restrictedBuiltInModels">,
): boolean {
  return (
    !capabilities.restrictedBuiltInModels ||
    !isLimitedFree1RestrictedRunModel(model)
  );
}

function modelProviderAllowedForPlan(
  providerType: ModelProviderType,
  capabilities: Pick<ModelPlanCapabilities, "supportByok">,
): boolean {
  return capabilities.supportByok || isBuiltInModelProviderType(providerType);
}

export function modelPolicyAllowedForPlan(
  policy: Pick<OrgModelPolicy, "model" | "defaultProviderType">,
  capabilities: ModelPlanCapabilities,
): boolean {
  return (
    modelAllowedForPlan(policy.model, capabilities) &&
    modelProviderAllowedForPlan(policy.defaultProviderType, capabilities)
  );
}
