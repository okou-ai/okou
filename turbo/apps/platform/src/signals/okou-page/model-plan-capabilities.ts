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
  /**
   * Whether the catalog has an enabled personal subscription route
   * (`subscriptionType`) of the provider type for the model. A member-scope
   * policy on it runs only with each member's own valid subscription, which
   * every plan allows; the API verifies the account per run.
   */
  readonly subscriptionRouteServes: (
    model: string,
    providerType: string,
  ) => boolean;
}

export const DEFAULT_MODEL_PLAN_CAPABILITIES =
  Object.freeze<ModelPlanCapabilities>({
    supportByok: true,
    restrictedBuiltInModels: false,
    restrictedPlanAccess: () => {
      return undefined;
    },
    subscriptionRouteServes: () => {
      return false;
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
      subscriptionRouteServes: (model, providerType) => {
        return catalog.routes(model, { providerType }).some((route) => {
          return route.subscriptionType === providerType;
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

/** A member-scope Claude Code or Codex route on the model's subscription route. */
export function memberSubscriptionRouteAllowed(
  model: string | null | undefined,
  providerType: ModelProviderType,
  capabilities: Pick<ModelPlanCapabilities, "subscriptionRouteServes">,
): boolean {
  return (
    !!model &&
    (providerType === "claude-code-oauth-token" ||
      providerType === "codex-oauth-token") &&
    capabilities.subscriptionRouteServes(model, providerType)
  );
}

export function modelRouteAllowedForPlan(
  model: string | null | undefined,
  providerType: ModelProviderType,
  capabilities: ModelPlanCapabilities,
): boolean {
  if (memberSubscriptionRouteAllowed(model, providerType, capabilities)) {
    return true;
  }
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
