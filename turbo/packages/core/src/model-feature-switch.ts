import { FeatureSwitchKey } from "./feature-switch-key";
import { isFeatureEnabled, type FeatureSwitchContext } from "./feature-switch";

/** The compact menu includes Fast; the existing rollout still serves other users. */
export function isCodexFastModeEnabled(ctx: FeatureSwitchContext): boolean {
  return (
    isFeatureEnabled(FeatureSwitchKey.RefactorModelSelect, ctx) ||
    isFeatureEnabled(FeatureSwitchKey.CodexFastMode, ctx)
  );
}
