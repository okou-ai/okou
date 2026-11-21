import {
  memberOnboardingContract,
  onboardingStatusContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { command } from "ccstate";

import { logger } from "../../lib/log";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { ensureOrgLimitedFreeBootstrap$ } from "../services/org-limited-free-bootstrap.service";
import {
  memberOnboardingStatus,
  onboardingWorkspaceProvisioningId,
  onboardingStatus,
} from "../services/onboarding.service";
import { tapError } from "../utils";

const L = logger("onboarding-status.route");

function statusHandler(memberOnly: boolean) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    if (
      auth.orgId &&
      "orgRole" in auth &&
      auth.orgRole === "admin" &&
      !(await get(onboardingWorkspaceProvisioningId(auth.orgId)))
    ) {
      signal.throwIfAborted();
      await tapError(
        set(
          ensureOrgLimitedFreeBootstrap$,
          { orgId: auth.orgId, ownerUserId: auth.userId },
          signal,
        ),
        (error) => {
          L.warn("Lazy onboarding status bootstrap failed", {
            orgId: auth.orgId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }
    const body = memberOnly
      ? await get(memberOnboardingStatus(auth))
      : await get(onboardingStatus(auth));
    signal.throwIfAborted();
    return { status: 200 as const, body };
  });
}

export const onboardingStatusRoutes: readonly RouteEntry[] = [
  {
    route: memberOnboardingContract.getStatus,
    handler: authRoute({}, statusHandler(true)),
  },
  {
    route: onboardingStatusContract.getStatus,
    handler: authRoute({}, statusHandler(false)),
  },
];
