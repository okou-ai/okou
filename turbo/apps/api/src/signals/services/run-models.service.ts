import { command, type Computed } from "ccstate";
import type {
  AvailableRunModel,
  AvailableRunModelsResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  AUTO_RUN_PROVIDER,
  AUTO_SELECTED_MODEL,
} from "@okouai/core/auto-run-model";
import {
  memberModelRouteContext,
  type MemberModelRouteIdentity,
} from "./effective-model-route.service";
import { memberSubscriptionModels } from "./member-subscription-models.service";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";

export function listAvailableRunModels(
  identity$: Computed<MemberModelRouteIdentity>,
) {
  const member$ = memberModelRouteContext(identity$);
  const subscriptions$ = memberSubscriptionModels(member$);
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<AvailableRunModelsResponse> => {
      const params = get(identity$);
      await get(member$);
      signal.throwIfAborted();
      const subscriptions = await get(subscriptions$);
      signal.throwIfAborted();
      const capabilities =
        subscriptions.length > 0
          ? await set(loadOrgPlanCapabilities$, params.orgId)
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
                serviceTier:
                  entry.serviceTier === "priority" ? "priority" : null,
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
}
