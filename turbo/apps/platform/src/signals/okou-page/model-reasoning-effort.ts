import { isPiExecutionRoute } from "@okouai/core/pi-execution";
import {
  isBuiltInModelProviderType,
  type OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  defaultModelReasoningEffort,
  getRouteReasoningEfforts,
  modelReasoningEffort,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";

/** Saved preferences remain independent of the route's current capability. */
export function preferredChatReasoningEffort(
  selection: ModelProviderSelection | null | undefined,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): ReasoningEffort | undefined {
  if (!switches[FeatureSwitchKey.ChatReasoningEffort]) {
    return undefined;
  }
  return modelReasoningEffort(
    selection?.selectedModel,
    selection?.modelSettings,
  );
}

/** Resolve the same model/provider runtime policy used by server admission. */
export function availableChatReasoningEfforts(
  selection: ModelProviderSelection | null | undefined,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
  policy: OrgModelPolicy | undefined,
): readonly ReasoningEffort[] {
  if (
    !selection ||
    !policy ||
    policy.routeStatus !== "valid" ||
    !switches[FeatureSwitchKey.ChatReasoningEffort]
  ) {
    return [];
  }
  const runtimeProviderType = isBuiltInModelProviderType(
    policy.defaultProviderType,
  )
    ? policy.runtimeProviderType
    : policy.defaultProviderType;
  if (runtimeProviderType === null) {
    return [];
  }
  const piExecution = isPiExecutionRoute({
    selectedModel: selection.selectedModel,
    modelProviderType: policy.defaultProviderType,
    runtimeProviderType,
    codexServiceTier: selection.codexServiceTier ?? undefined,
    piEnabled: switches[FeatureSwitchKey.PiLoop] === true,
    codexFastModeEnabled: Boolean(
      switches[FeatureSwitchKey.ModelPickerMenu] ||
      switches[FeatureSwitchKey.CodexFastMode],
    ),
  });
  return getRouteReasoningEfforts({
    model: selection.selectedModel,
    piExecution,
    runtimeProviderType,
  });
}

/** Resolve the value this UI can execute without mutating the saved preference. */
export function effectiveChatReasoningEffort(
  selection: ModelProviderSelection | null | undefined,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
  policy: OrgModelPolicy | undefined,
): ReasoningEffort | undefined {
  if (!selection) {
    return undefined;
  }
  const available = availableChatReasoningEfforts(selection, switches, policy);
  const preferred = preferredChatReasoningEffort(selection, switches);
  if (preferred && available.includes(preferred)) {
    return preferred;
  }
  const defaultEffort = defaultModelReasoningEffort(selection.selectedModel);
  return defaultEffort && available.includes(defaultEffort)
    ? defaultEffort
    : undefined;
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
