import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { command } from "ccstate";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { memberOnboardingStatus } from "../services/onboarding.service";

const statusHandler$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const body = await get(memberOnboardingStatus(auth));
  signal.throwIfAborted();
  return { status: 200 as const, body };
});

export const onboardingStatusRoutes: readonly RouteEntry[] = [
  {
    route: onboardingStatusContract.getStatus,
    handler: authRoute({}, statusHandler$),
  },
];
