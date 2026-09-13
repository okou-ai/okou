import {
  resolveRouteReasoningEffort,
  isModelReasoningEffortSupported,
  modelReasoningEffort,
  withModelReasoningEffort,
  type ModelSettings,
  type ModelSettingsPatch,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { isSupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { badRequestMessage } from "../../lib/error";

/** Keep saved preferences dormant while rollout is disabled. */
export function resolveChatReasoningEffort(args: {
  readonly selectedModel: string | null;
  readonly modelSettings?: ModelSettings | null;
  readonly requested?: ReasoningEffort;
  readonly enabled: boolean;
}):
  | {
      readonly reasoningEffort: ReasoningEffort | undefined;
      readonly modelSettings: ModelSettings;
      readonly modelSettingsPatch: ModelSettingsPatch | undefined;
    }
  | ReturnType<typeof badRequestMessage> {
  const storedSettings = args.modelSettings ?? {};
  if (!args.enabled) {
    if (args.requested !== undefined) {
      return badRequestMessage("Reasoning effort selection is not enabled");
    }
    return {
      reasoningEffort: undefined,
      modelSettings: storedSettings,
      modelSettingsPatch: undefined,
    };
  }
  if (args.requested !== undefined) {
    if (!isModelReasoningEffortSupported(args.selectedModel, args.requested)) {
      return badRequestMessage(
        "Reasoning effort is not supported by the selected model",
      );
    }
  }
  const modelSettingsPatch =
    args.requested !== undefined && isSupportedRunModel(args.selectedModel)
      ? { model: args.selectedModel, effort: args.requested }
      : undefined;
  const modelSettings = modelSettingsPatch
    ? withModelReasoningEffort(storedSettings, modelSettingsPatch)
    : storedSettings;
  return {
    reasoningEffort: modelReasoningEffort(args.selectedModel, modelSettings),
    modelSettings,
    modelSettingsPatch,
  };
}

/** Adapt the preference to the route selected for this run, without rewriting it. */
export function resolveReasoningEffortForDispatch(args: {
  readonly selectedModel: string | null | undefined;
  readonly effort: ReasoningEffort | undefined;
  readonly piExecution: boolean;
  readonly runtimeProviderType: string | null | undefined;
}): ReasoningEffort | undefined {
  return resolveRouteReasoningEffort({ ...args, model: args.selectedModel });
}
