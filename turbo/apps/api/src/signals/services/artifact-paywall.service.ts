import { command } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { paidPlanRequired } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";

const FREE_PLAN_KEY = "limited-free-1";

/**
 * Whether the owning workspace is on the free plan with the artifact paywall
 * rolled out. A member's Lab override may opt into the paywall for testing but
 * never opts out of it: feature switches are not an authorization boundary.
 */
export const artifactPaywallApplies$ = command(
  async (
    { set },
    owner: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const key = FeatureSwitchKey.FreePlanArtifactPaywall;
    const rolledOut = isFeatureEnabled(key, {
      orgId: owner.orgId,
      userId: owner.userId,
    });
    if (!rolledOut) {
      const { overrides } = await set(
        loadUserFeatureSwitchContext$,
        owner.orgId,
        owner.userId,
        signal,
      );
      signal.throwIfAborted();
      if (overrides[key] !== true) {
        return false;
      }
    }
    const capabilities = await set(
      loadOrgPlanCapabilities$,
      owner.orgId,
      signal,
    );
    // A workspace that never subscribed has no entitlement row; billing
    // reports it as the free plan too.
    return capabilities === null || capabilities.planKey === FREE_PLAN_KEY;
  },
);

export function artifactPaywallRequired(feature: string) {
  return paidPlanRequired(feature, "Upgrade to Pro to unlock it.");
}

/**
 * Only App sessions are paywalled. Agent, sandbox, PAT, and OAuth tokens read
 * artifacts as task inputs, and blocking them would fail free-plan runs.
 */
export const appDownloadPaywalled$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const auth = get(authContext$);
    return (
      auth.tokenType === "session" &&
      auth.orgId !== undefined &&
      (await set(
        artifactPaywallApplies$,
        { orgId: auth.orgId, userId: auth.userId },
        signal,
      ))
    );
  },
);
