import { FeatureSwitchKey } from "./feature-switch-key";
import { isFeatureEnabled, type FeatureSwitchContext } from "./feature-switch";

/** Effort's switch. */
export function isChatEffortEnabled(ctx: FeatureSwitchContext): boolean {
  return isFeatureEnabled(FeatureSwitchKey.Effort, ctx);
}
