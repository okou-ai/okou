import {
  getCatalogRunModelRouteAccess,
  type AvailableRunModel,
  type ModelProviderType,
  type RestrictedPlanModelAccess,
} from "@okouai/api-contracts/contracts/model-providers";
import { computed } from "ccstate";

import { getMemberRunModelRoute } from "@okouai/api-contracts/contracts/member-run-model";

import { modelCatalog$ } from "../external/model-catalog.ts";
import { orgPlanCapabilities$ } from "./org-plan-capabilities.ts";

export interface ModelPlanCapabilities {
  readonly restrictedBuiltInModels: boolean;
  /** The catalog's plan eligibility of a model; undefined outside the catalog. */
  readonly restrictedPlanAccess: (
    model: string,
  ) => RestrictedPlanModelAccess | undefined;
  /**
   * Whether the catalog has an enabled personal subscription route
   * (`subscriptionType`) of the provider type for the model. A member-scope
   * model on it runs only with each member's own valid subscription, which
   * every plan allows; the API verifies the account per run.
   */
  readonly subscriptionRouteServes: (
    model: string,
    providerType: string,
  ) => boolean;
}

export const DEFAULT_MODEL_PLAN_CAPABILITIES =
  Object.freeze<ModelPlanCapabilities>({
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
    !model ||
    getCatalogRunModelRouteAccess(
      capabilities.restrictedPlanAccess(model),
      providerType,
      capabilities.restrictedBuiltInModels,
    ) === "allowed"
  );
}

/** Member controls use the caller-specific server projection. */
export function memberRunModelAllowedForPlan(
  runModel: AvailableRunModel,
  capabilities: ModelPlanCapabilities,
): boolean {
  const route = getMemberRunModelRoute(runModel);
  if (runModel.subscriptionOptions) {
    return route.availability !== "plan_restricted";
  }
  return (
    route.availability !== "plan_restricted" &&
    modelRouteAllowedForPlan(runModel.model, route.providerType, capabilities)
  );
}
