import { command } from "ccstate";
import type {
  AvailableRunModel,
  AvailableRunModelsResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  AUTO_RUN_PROVIDER,
  AUTO_SELECTED_MODEL,
} from "@okouai/core/auto-run-model";
import { loadMemberModelRouteContext } from "./effective-model-route.service";
import { loadMemberSubscriptionModels } from "./member-subscription-models.service";
import { db$ } from "../external/db";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

export const listAvailableRunModels$ = command(
  async (
    { get },
    params: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<AvailableRunModelsResponse> => {
    const db = get(db$);
    const member = await loadMemberModelRouteContext(
      db,
      params.orgId,
      params.userId,
    );
    signal.throwIfAborted();
    const subscriptions = await loadMemberSubscriptionModels(db, member);
    signal.throwIfAborted();
    const capabilities =
      subscriptions.length > 0
        ? await loadOrgPlanCapabilities(db, params.orgId)
        : null;
    signal.throwIfAborted();
    // A suspended entitlement still blocks execution and must be shown as such.
    const personalPlanRestricted = capabilities?.status !== "active";
    // Selection is canonical; admission captures the execution independently.
    const auto: AvailableRunModel = {
      model: AUTO_SELECTED_MODEL,
      modelLabel: "Auto",
      modelProviderId: null,
      memberEffective: {
        providerType: "built-in",
        runtimeProviderType: AUTO_RUN_PROVIDER,
        credentialScope: "org",
        availability: "available",
        accountSelection: "not_applicable",
      },
    };
    return {
      models: [
        auto,
        ...subscriptions.map((entry): AvailableRunModel => {
          return {
            model: entry.model,
            modelLabel: entry.displayName,
            modelProviderId: entry.providerId,
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
