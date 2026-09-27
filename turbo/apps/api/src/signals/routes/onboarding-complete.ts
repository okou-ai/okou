import { command } from "ccstate";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { completeOnboarding$ } from "../services/onboarding.service";
import { bodyResultOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";

const completeBody$ = bodyResultOf(onboardingCompleteContract.complete);
const completeQuery$ = queryOf(onboardingCompleteContract.complete);

const completeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(completeBody$);
  signal.throwIfAborted();

  if (!body.ok) {
    return body.response;
  }
  const query = get(completeQuery$);
  // Anyone who is not an admin records only their own completion; the service
  // keeps it away from the organization-wide state an admin's completion writes.
  const role = auth.orgRole ?? "member";

  return await set(
    completeOnboarding$,
    {
      orgId: auth.orgId,
      member: { userId: auth.userId, role },
      isAdmin: role === "admin",
      timezone: body.data.timezone,
      industry: body.data.industry,
      modelProvider: query?.modelProvider,
    },
    signal,
  );
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
