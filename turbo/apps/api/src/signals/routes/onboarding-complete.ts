import { command } from "ccstate";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";

import { logger } from "../../lib/log";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { deleteOnboardingDraft$ } from "../services/onboarding-draft.service";
import { tapError } from "../utils";
import { completeOnboarding$ } from "../services/onboarding.service";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";

const L = logger("onboarding-complete.route");
const completeBody$ = bodyResultOf(onboardingCompleteContract.complete);

const completeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(completeBody$);
  signal.throwIfAborted();

  if (!body.ok) {
    return body.response;
  }
  // Anyone who is not an admin records only their own completion; the service
  // keeps it away from the organization-wide state an admin's completion writes.
  const role = auth.orgRole ?? "member";

  const result = await set(
    completeOnboarding$,
    {
      orgId: auth.orgId,
      member: { userId: auth.userId, role },
      isAdmin: role === "admin",
      timezone: body.data.timezone,
      industry: body.data.industry,
    },
    signal,
  );
  await tapError(set(deleteOnboardingDraft$, auth), () => {
    L.warn("Could not remove completed onboarding draft", {
      orgId: auth.orgId,
      userId: auth.userId,
    });
  });
  signal.throwIfAborted();
  return result;
});

export const onboardingCompleteRoutes: readonly RouteEntry[] = [
  {
    route: onboardingCompleteContract.complete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      completeInner$,
    ),
  },
];
