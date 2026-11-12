import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";
import { authenticatedSessionKey$ } from "../auth.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { billingStatusAsync$ } from "./billing.ts";
import { openSettingsBillingPlansDialog$ } from "./settings/settings-dialog.ts";

/**
 * Free-plan workspaces see downloads, Customize URL, and hiding the website
 * banner as upgrade prompts. The API enforces the same rule; this only decides
 * which affordance the App renders.
 */
export const artifactPaywallLocked$ = computed(async (get) => {
  if (
    !get(authenticatedSessionKey$) ||
    !get(featureSwitch$)[FeatureSwitchKey.FreePlanArtifactPaywall]
  ) {
    return false;
  }
  const billing = await get(billingStatusAsync$);
  return billing.tier === "limited-free-1";
});

/**
 * Resolve whether a paywalled action may proceed, opening the plans dialog
 * when it may not.
 */
export const passArtifactPaywall$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const locked = await get(artifactPaywallLocked$);
    signal.throwIfAborted();
    if (!locked) {
      return true;
    }
    await set(openSettingsBillingPlansDialog$, signal);
    return false;
  },
);
