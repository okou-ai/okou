import { command } from "ccstate";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import {
  checkHostedSiteUrl$,
  getHostedSiteUrl$,
  resolveHostedSiteAlias$,
  updateHostedSiteUrl$,
  type HostedSiteUrlResult,
} from "../services/hosted-site-url.service";
import { conflict, notFound, resourceUnavailable } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

const admission$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const auth = get(organizationAuthContext$);
  const features = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  signal.throwIfAborted();
  return isFeatureEnabled(FeatureSwitchKey.HostedSiteUrlEditing, features)
    ? null
    : resourceUnavailable("Website URL editing is not available");
});

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
  const denied = await set(admission$, signal);
  if (denied) {
    return denied;
  }
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
  const denied = await set(admission$, signal);
  if (denied) {
    return denied;
  }
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
  const denied = await set(admission$, signal);
  if (denied) {
    return denied;
  }
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
