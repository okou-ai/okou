import { command } from "ccstate";
import type {
  AvailableRunModel,
  AvailableRunModelsResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import { AUTO_RUN_MODEL, AUTO_RUN_PROVIDER } from "@okouai/core/auto-run-model";
import { loadMemberModelRouteContext } from "./effective-model-route.service";
import { loadMemberSubscriptionModels } from "./member-subscription-models.service";
import { db$ } from "../external/db";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

export const listAvailableRunModels$ = command(
  async (
    { get },
    params: { readonly orgId: string; readonly userId?: string },
    signal: AbortSignal,
  ): Promise<AvailableRunModelsResponse> => {
    const db = get(db$);
    const member = await loadMemberModelRouteContext(
      db,
      params.orgId,
      params.userId ?? "__no_preference__",
    );
    signal.throwIfAborted();
    const subscriptions = await loadMemberSubscriptionModels(db, member);
    signal.throwIfAborted();
    const capabilities =
      subscriptions.length > 0
        ? await loadOrgPlanCapabilities(db, params.orgId)
        : null;
    signal.throwIfAborted();
    // Caller-owned subscriptions are exempt from retired organization BYOK limits.
    // A suspended entitlement still blocks execution and must be shown as such.
    const personalPlanRestricted = capabilities?.status !== "active";
    const auto: AvailableRunModel = {
      model: AUTO_RUN_MODEL,
      modelLabel: "Auto",
      defaultProviderType: "built-in",
      runtimeProviderType: AUTO_RUN_PROVIDER,
      credentialScope: "org",
      modelProviderId: null,
      routeStatus: "valid",
      routeStatusReason: null,
      memberEffective: {
        providerType: "built-in",
        runtimeProviderType: AUTO_RUN_PROVIDER,
        credentialScope: "org",
        availability: "available",
        accountSelection: "not_applicable",
      },
    };
    return {
      defaultModel: AUTO_RUN_MODEL,
      models: [
        auto,
        ...subscriptions.map((entry): AvailableRunModel => {
          return {
            model: entry.model,
            modelLabel: entry.displayName,
            defaultProviderType: entry.providerType,
            runtimeProviderType: entry.providerType,
            credentialScope: "member",
            modelProviderId: entry.providerId,
            routeStatus: "valid",
            routeStatusReason: null,
            subscriptionOptions: {
              efforts: [...entry.efforts],
              serviceTier: entry.serviceTier === "priority" ? "priority" : null,
            },
            memberEffective: {
              providerType: entry.providerType,
              runtimeProviderType: entry.providerType,
              credentialScope: "member",
              availability: personalPlanRestricted
                ? "plan_restricted"
                : entry.needsReconnect
                  ? "reconnect_required"
                  : "available",
              accountSelection: "capture_required",
            },
          };
        }),
      ],
    };
  },
);

export const listAvailableRunModelsWithDefault$ = command(
  async (
    { set },
    params: { readonly orgId: string; readonly userId?: string },
    signal: AbortSignal,
  ) => {
    const response = await set(listAvailableRunModels$, params, signal);
    return { response, systemDefaultModel: response.defaultModel };
  },
);
