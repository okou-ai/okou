import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { command } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { request$ } from "../context/hono";
import { userFeatureSwitchContext } from "../services/feature-switches.service";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { memberOnboardingStatus } from "../services/onboarding.service";

const statusHandler$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const body = await get(memberOnboardingStatus(auth));
  if (get(request$).header("X-Client-Type") !== "iOS") {
    signal.throwIfAborted();
    return { status: 200 as const, body };
  }
  const context = auth.orgId
    ? await get(userFeatureSwitchContext(auth.orgId, auth.userId))
    : { userId: auth.userId };
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      ...body,
      nativeOnboardingEnabled: isFeatureEnabled(
        FeatureSwitchKey.NativeOnboarding,
        context,
      ),
    },
  };
});

export const onboardingStatusRoutes: readonly RouteEntry[] = [
  {
    route: onboardingStatusContract.getStatus,
    handler: authRoute({}, statusHandler$),
  },
];
