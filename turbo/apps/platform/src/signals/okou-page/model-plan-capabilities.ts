import { computed } from "ccstate";
import {
  getCatalogRunModelRouteAccess,
  isBuiltInModelProviderType,
  type ModelProviderType,
  type OrgModelPolicy,
  type RestrictedPlanModelAccess,
} from "@okouai/api-contracts/contracts/model-providers";

import { getMemberModelPolicyRoute } from "@okouai/api-contracts/contracts/member-model-policy";

import { modelCatalog$ } from "../external/model-catalog.ts";
import { orgPlanCapabilities$ } from "./org-plan-capabilities.ts";

export interface ModelPlanCapabilities {
  readonly supportByok: boolean;
  readonly restrictedBuiltInModels: boolean;
  /** The catalog's plan policy of a model; undefined outside the catalog. */
  readonly restrictedPlanAccess: (
    model: string,
  ) => RestrictedPlanModelAccess | undefined;
}

export const DEFAULT_MODEL_PLAN_CAPABILITIES =
  Object.freeze<ModelPlanCapabilities>({
    supportByok: true,
    restrictedBuiltInModels: false,
    restrictedPlanAccess: () => {
      return undefined;
    },
  });

export const modelPlanCapabilities$ = computed(
  async (get): Promise<ModelPlanCapabilities> => {
    const [capabilities, catalog] = await Promise.all([
      get(orgPlanCapabilities$),
      get(modelCatalog$),
    ]);
    return {
      supportByok: capabilities.supportByok,
      restrictedBuiltInModels: capabilities.restrictedBuiltInModels,
      restrictedPlanAccess: (model) => {
        return catalog.models.find((entry) => {
          return entry.model === model;
        });
      },
    };
  },
);

/** Whether the plan may run the model on a Built-in route. */
export function modelAllowedForPlan(
  model: string | null | undefined,
  capabilities: Pick<
    ModelPlanCapabilities,
    "restrictedBuiltInModels" | "restrictedPlanAccess"
  >,
): boolean {
  return (
    !model ||
    getCatalogRunModelRouteAccess(
      capabilities.restrictedPlanAccess(model),
      "built-in",
      capabilities.restrictedBuiltInModels,
    ) === "allowed"
  );
}

function modelProviderAllowedForPlan(
  providerType: ModelProviderType,
  capabilities: Pick<ModelPlanCapabilities, "supportByok">,
): boolean {
  return capabilities.supportByok || isBuiltInModelProviderType(providerType);
}

export function modelRouteAllowedForPlan(
  model: string | null | undefined,
  providerType: ModelProviderType,
  capabilities: ModelPlanCapabilities,
): boolean {
  return (
    (!model ||
      getCatalogRunModelRouteAccess(
        capabilities.restrictedPlanAccess(model),
        providerType,
        capabilities.restrictedBuiltInModels,
      ) === "allowed") &&
    modelProviderAllowedForPlan(providerType, capabilities)
  );
}

export function modelPolicyAllowedForPlan(
  policy: Pick<OrgModelPolicy, "model" | "defaultProviderType">,
  capabilities: ModelPlanCapabilities,
): boolean {
  return modelRouteAllowedForPlan(
    policy.model,
    policy.defaultProviderType,
    capabilities,
  );
}

/** Member controls use the server projection; organization settings keep the helper above. */
export function memberModelPolicyAllowedForPlan(
  policy: OrgModelPolicy,
  capabilities: ModelPlanCapabilities,
): boolean {
  const route = getMemberModelPolicyRoute(policy);
  if (policy.subscriptionOptions) {
    return route.availability !== "plan_restricted";
  }
  return (
    route.availability !== "plan_restricted" &&
    modelRouteAllowedForPlan(policy.model, route.providerType, capabilities)
  );
}
