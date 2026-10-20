import { FeatureSwitchKey } from "./feature-switch-key";
import { isFeatureEnabled, type FeatureSwitchContext } from "./feature-switch";

/** Guided setup includes both protocols; resource and chat authorization remain separate. */
export function isVncAccessEnabled(context: FeatureSwitchContext): boolean {
  return (
    isFeatureEnabled(FeatureSwitchKey.VncAccess, context) ||
    isFeatureEnabled(FeatureSwitchKey.RemoteControlGuidedSetup, context)
  );
}

export function isTailscaleAccessEnabled(
  context: FeatureSwitchContext,
): boolean {
  return (
    isFeatureEnabled(FeatureSwitchKey.TailscaleAccess, context) ||
    isFeatureEnabled(FeatureSwitchKey.RemoteControlGuidedSetup, context)
  );
}
