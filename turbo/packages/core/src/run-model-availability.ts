import { isOkouRunModel } from "@okouai/api-contracts/contracts/model-providers";

import { isFeatureEnabled, type FeatureSwitchContext } from "./feature-switch";
import { FeatureSwitchKey } from "./feature-switch-key";

export const RUN_MODEL_FEATURE_UNAVAILABLE_MESSAGE =
  "This model is not currently available for this workspace.";

/** Current rollout availability; historical model recognition stays static. */
export function isRunModelAvailable(
  model: string | null | undefined,
  context: FeatureSwitchContext,
): boolean {
  return (
    !isOkouRunModel(model) ||
    isFeatureEnabled(FeatureSwitchKey.OkouModels, context)
  );
}

export function availableRunModels<T extends string>(
  models: readonly T[],
  context: FeatureSwitchContext,
): T[] {
  return models.filter((model) => {
    return isRunModelAvailable(model, context);
  });
}
