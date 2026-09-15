import { FeatureSwitchKey } from "./feature-switch-key";
import { isFeatureEnabled, type FeatureSwitchContext } from "./feature-switch";

/**
 * Effort's switch. `refactorModelSelect` carried effort before it was split
 * from the model picker's layout, so it still counts while app bundles that
 * read it are deployed.
 */
export function isChatEffortEnabled(ctx: FeatureSwitchContext): boolean {
  return (
    isFeatureEnabled(FeatureSwitchKey.Effort, ctx) ||
    isFeatureEnabled(FeatureSwitchKey.RefactorModelSelect, ctx)
  );
}

/** Effort's control includes Fast; the existing rollout still serves other users. */
export function isCodexFastModeEnabled(ctx: FeatureSwitchContext): boolean {
  return (
    isChatEffortEnabled(ctx) ||
    isFeatureEnabled(FeatureSwitchKey.CodexFastMode, ctx)
  );
}
