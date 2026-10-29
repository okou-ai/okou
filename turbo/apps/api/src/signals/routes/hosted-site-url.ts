import { command } from "ccstate";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import {
  checkHostedSiteUrl$,
  getHostedSiteUrl$,
  resolveHostedSiteAlias$,
  updateHostedSiteUrl$,
  type HostedSiteUrlResult,
} from "../services/hosted-site-url.service";
import { conflict, notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

function response(result: HostedSiteUrlResult) {
  if (result.status === "not_found") {
    return notFound(result.message);
  }
  if (result.status === "conflict") {
    return conflict(result.message);
  }
  return { status: 200 as const, body: result.body };
}

const siteUrl$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  return response(
    await set(
      getHostedSiteUrl$,
      {
        ...get(organizationAuthContext$),
        ...get(pathParamsOf(hostContract.siteUrl)),
        ...get(queryOf(hostContract.siteUrl)),
      },
      signal,
    ),
  );
});
const availability$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await set(
    checkHostedSiteUrl$,
    {
      ...get(organizationAuthContext$),
      ...get(pathParamsOf(hostContract.siteUrlAvailability)),
      ...get(queryOf(hostContract.siteUrlAvailability)),
    },
    signal,
  );
  return body
    ? { status: 200 as const, body }
    : notFound("Published website not found");
});
const update$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await get(bodyResultOf(hostContract.updateSiteUrl));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return response(
    await set(
      updateHostedSiteUrl$,
      {
        ...get(organizationAuthContext$),
        ...get(pathParamsOf(hostContract.updateSiteUrl)),
        ...body.data,
      },
      signal,
    ),
  );
});
const resolve$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const pointer = await set(
    resolveHostedSiteAlias$,
    {
      ...get(pathParamsOf(hostContract.resolveAlias)),
      ...get(queryOf(hostContract.resolveAlias)),
    },
    signal,
  );
  return { status: 200 as const, body: { pointer } };
});
const auth = {
  requiredCapability: "host:write",
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;
export const hostedSiteUrlRoutes: readonly RouteEntry[] = [
  { route: hostContract.resolveAlias, handler: resolve$ },
  { route: hostContract.siteUrl, handler: authRoute(auth, siteUrl$) },
  {
    route: hostContract.siteUrlAvailability,
    handler: authRoute(auth, availability$),
  },
  { route: hostContract.updateSiteUrl, handler: authRoute(auth, update$) },
];
