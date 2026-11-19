import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { command } from "ccstate";

import { logger } from "../../lib/log";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { ensureOrgLimitedFreeBootstrap$ } from "../services/org-limited-free-bootstrap.service";
import { onboardingStatus } from "../services/onboarding.service";
import { serverOnboardingDraftEnabled$ } from "../services/onboarding-draft.service";
import { tapError } from "../utils";

const L = logger("onboarding-status.route");

const getOnboardingStatusInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(authContext$);
    let body = await get(onboardingStatus(auth));
    signal.throwIfAborted();

    if (auth.orgId && body.isAdmin && !body.hasDefaultAgent) {
      const bootstrapResult = await tapError(
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

      if (bootstrapResult !== undefined) {
        body = await get(onboardingStatus(auth));
        signal.throwIfAborted();
      }
    }

    const serverDraftEnabled =
      auth.tokenType === "session" &&
      auth.orgId &&
      body.needsOnboarding &&
      (await set(
        serverOnboardingDraftEnabled$,
        { orgId: auth.orgId, userId: auth.userId },
        signal,
      ));
    return {
      status: 200 as const,
      body: serverDraftEnabled
        ? { ...body, serverDraftEnabled: true as const }
        : body,
    };
  },
);

export const onboardingStatusRoutes: readonly RouteEntry[] = [
  {
    route: onboardingStatusContract.getStatus,
    handler: authRoute({}, getOnboardingStatusInner$),
  },
];
