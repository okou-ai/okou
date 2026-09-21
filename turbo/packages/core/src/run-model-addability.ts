import { isOkouRunModel } from "@okouai/api-contracts/contracts/model-providers";

import { isFeatureEnabled, type FeatureSwitchContext } from "./feature-switch";
import { FeatureSwitchKey } from "./feature-switch-key";

export const RUN_MODEL_ADD_UNAVAILABLE_MESSAGE =
  "This model is not currently available to add.";

/** Whether this user may add the model to a workspace policy. */
export function isRunModelAddable(
  model: string | null | undefined,
  context: FeatureSwitchContext,
): boolean {
  return (
    !isOkouRunModel(model) ||
    isFeatureEnabled(FeatureSwitchKey.OkouModels, context)
  );
}
