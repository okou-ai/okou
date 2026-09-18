import { FeatureSwitchKey } from "./feature-switch-key";
import { isFeatureEnabled, type FeatureSwitchContext } from "./feature-switch";

export function isCodexFastModeEnabled(ctx: FeatureSwitchContext): boolean {
  return isFeatureEnabled(FeatureSwitchKey.CodexFastMode, ctx);
}
