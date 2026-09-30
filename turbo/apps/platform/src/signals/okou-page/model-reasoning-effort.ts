import { isPiExecutionRoute } from "@okouai/core/pi-execution";
import type { OrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";
import {
  narrowRouteReasoningEfforts,
  reasoningEffortSchema,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  getMemberModelPolicyRoute,
  isMemberModelPolicyConfigurable,
} from "@okouai/api-contracts/contracts/member-model-policy";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import type { ModelCatalog } from "../external/model-catalog.ts";

function catalogRouteQuery(policy: OrgModelPolicy) {
  const route = getMemberModelPolicyRoute(policy);
  return {
    providerType: route.providerType,
    concreteProviderType: route.runtimeProviderType,
  };
}

/**
 * The saved preference of the selected model, independent of the route's
 * current capability; without one the route's catalog default applies.
 */
export function preferredChatReasoningEffort(
  selection: ModelProviderSelection | null | undefined,
  catalog?: ModelCatalog | null,
): ReasoningEffort | undefined {
  const model = selection?.selectedModel;
  if (!model) {
    return undefined;
  }
  const saved = selection.modelSettings?.[model]?.effort;
  if (saved !== undefined) {
    return saved;
  }
  const parsed = reasoningEffortSchema.safeParse(catalog?.defaultEffort(model));
  return parsed.success ? parsed.data : undefined;
}

/**
 * The catalog route's efforts are the product authority; execution-time
 * protocol narrowing (Pi and provider-specific rules) is applied on top.
 */
export function availableChatReasoningEfforts(
  selection: ModelProviderSelection | null | undefined,
  policy: OrgModelPolicy | undefined,
  catalog: ModelCatalog | null | undefined,
): readonly ReasoningEffort[] {
  if (
    !selection ||
    !policy ||
    !catalog ||
    !isMemberModelPolicyConfigurable(policy)
  ) {
    return [];
  }
  const route = getMemberModelPolicyRoute(policy);
  const runtimeProviderType = route.runtimeProviderType;
  if (runtimeProviderType === null) {
    return [];
  }
  const piExecution = isPiExecutionRoute({
    catalogModel: catalog.piModel(selection.selectedModel),
    modelProviderType: route.providerType,
    runtimeProviderType,
    codexServiceTier: selection.codexServiceTier ?? undefined,
  });
  const catalogEfforts = catalog
    .efforts(selection.selectedModel, catalogRouteQuery(policy))
    .flatMap((effort) => {
      const parsed = reasoningEffortSchema.safeParse(effort);
      return parsed.success ? [parsed.data] : [];
    });
  const routeEfforts = narrowRouteReasoningEfforts({
    model: selection.selectedModel,
    efforts: catalogEfforts,
    piExecution,
    runtimeProviderType,
  });
  return policy.subscriptionOptions
    ? routeEfforts.filter((effort) => {
        return policy.subscriptionOptions?.efforts.includes(effort);
      })
    : routeEfforts;
}

/** Resolve the value this UI can execute without mutating the saved preference. */
export function effectiveChatReasoningEffort(
  selection: ModelProviderSelection | null | undefined,
  policy: OrgModelPolicy | undefined,
  catalog: ModelCatalog | null | undefined,
): ReasoningEffort | undefined {
  if (!selection || !policy || !catalog) {
    return undefined;
  }
  const available = availableChatReasoningEfforts(selection, policy, catalog);
  const preferred = preferredChatReasoningEffort(selection);
  if (preferred && available.includes(preferred)) {
    return preferred;
  }
  const defaultEffort = catalog.defaultEffort(
    selection.selectedModel,
    catalogRouteQuery(policy),
  );
  return available.find((effort) => {
    return effort === defaultEffort;
  });
}

/** Preserve the map across model and Fast changes; never copy one model's effort. */
export function withChatModelSettings(
  selection: ModelProviderSelection | null,
  previous: ModelProviderSelection | null,
) {
  if (!selection) {
    return selection;
  }
  return {
    ...selection,
    modelSettings: selection.modelSettings ?? previous?.modelSettings ?? {},
  };
}
