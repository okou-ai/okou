import { command } from "ccstate";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { updateHostedSiteTitle$ } from "../services/hosted-site-title.service";
import { rejectSuspendedOrg$ } from "../services/org-suspension.service";
import type { RouteEntry } from "../route-entry";

const update$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const auth = get(organizationAuthContext$);
  const suspended = await set(rejectSuspendedOrg$, auth.orgId, signal);
  if (suspended) {
    return suspended;
  }
  const body = await get(bodyResultOf(hostContract.updateSiteTitle));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const site = await set(
    updateHostedSiteTitle$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...get(pathParamsOf(hostContract.updateSiteTitle)),
      title: body.data.title,
    },
    signal,
  );
  return site
    ? { status: 200 as const, body: site }
    : notFound("Hosted site not found");
});

export const hostedSiteTitleRoutes: readonly RouteEntry[] = [
  {
    route: hostContract.updateSiteTitle,
    handler: authRoute(
      {
        requiredCapability: "host:write",
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      update$,
    ),
  },
];
