import {
  resolveRouteReasoningEffort,
  withModelReasoningEffort,
  type ModelSettings,
  type ModelSettingsPatch,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { badRequestMessage } from "../../lib/error";
import type { ModelCatalog } from "./model-catalog.service";
import {
  catalogModelReasoningEffort,
  catalogRouteDefaultEffort,
  catalogRouteEfforts,
  isCatalogRouteEffortSupported,
} from "./model-route-capabilities.service";

/**
 * Accept a requested effort only when the model's catalog route lists it; the
 * saved preference falls back to the route's default effort.
 */
export function resolveChatReasoningEffort(args: {
  readonly catalog: ModelCatalog;
  readonly selectedModel: string | null;
  /** The selected route's provider type, when the caller resolved it. */
  readonly modelProviderType?: string | null;
  readonly modelSettings?: ModelSettings | null;
  readonly requested?: ReasoningEffort;
}):
  | {
      readonly reasoningEffort: ReasoningEffort | undefined;
      readonly modelSettings: ModelSettings;
      readonly modelSettingsPatch: ModelSettingsPatch | undefined;
    }
  | ReturnType<typeof badRequestMessage> {
  const storedSettings = args.modelSettings ?? {};
  if (
    args.requested !== undefined &&
    !isCatalogRouteEffortSupported(
      args.catalog,
      args.selectedModel,
      args.requested,
      args.modelProviderType,
    )
  ) {
    return badRequestMessage(
      "Reasoning effort is not supported by the selected model",
    );
  }
  const modelSettingsPatch =
    args.requested !== undefined && args.selectedModel
      ? { model: args.selectedModel, effort: args.requested }
      : undefined;
  const modelSettings = modelSettingsPatch
    ? withModelReasoningEffort(storedSettings, modelSettingsPatch)
    : storedSettings;
  return {
    reasoningEffort: catalogModelReasoningEffort(
      args.catalog,
      args.selectedModel,
      modelSettings,
      args.modelProviderType,
    ),
    modelSettings,
    modelSettingsPatch,
  };
}

/** Adapt the preference to the route selected for this run, without rewriting it. */
export function resolveReasoningEffortForDispatch(args: {
  readonly catalog: ModelCatalog;
  readonly selectedModel: string | null | undefined;
  /** The selected route's provider type (`built-in` or a personal subscription). */
  readonly modelProviderType: string | null | undefined;
  readonly effort: ReasoningEffort | undefined;
  readonly piExecution: boolean;
  readonly runtimeProviderType: string | null | undefined;
}): ReasoningEffort | undefined {
  return resolveRouteReasoningEffort({
    model: args.selectedModel,
    effort: args.effort,
    efforts: catalogRouteEfforts(
      args.catalog,
      args.selectedModel,
      args.modelProviderType,
    ),
    defaultEffort: catalogRouteDefaultEffort(
      args.catalog,
      args.selectedModel,
      args.modelProviderType,
    ),
    piExecution: args.piExecution,
    runtimeProviderType: args.runtimeProviderType,
  });
}
