import { FeatureSwitchKey } from "./feature-switch-key";
import { isFeatureEnabled, type FeatureSwitchContext } from "./feature-switch";

/** Effort's switch. */
export function isChatEffortEnabled(ctx: FeatureSwitchContext): boolean {
  return isFeatureEnabled(FeatureSwitchKey.Effort, ctx);
}

/** Effort's control includes Fast; the existing rollout still serves other users. */
export function isCodexFastModeEnabled(ctx: FeatureSwitchContext): boolean {
  return (
    isChatEffortEnabled(ctx) ||
    isFeatureEnabled(FeatureSwitchKey.CodexFastMode, ctx)
  );
}
