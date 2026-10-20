import { command } from "ccstate";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import {
  checkHostedSiteAccess$,
  getHostedSiteVisibility$,
  updateHostedSiteVisibility$,
} from "../services/hosted-site-access.service";
import { authorizeHostedSiteDownload$ } from "../services/hosted-site-download.service";
import {
  authorizeHostedSiteSession$,
  exchangeHostedSiteSession$,
  hostedSiteSessionViewer,
} from "../services/hosted-site-sessions.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import { conflict, notFound, resourceUnavailable } from "../../lib/error";
import type { RouteEntry } from "../route-entry";
import { env } from "../../lib/env";

const admission$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  if (env("HOSTED_SITE_ACCESS_ENABLED") !== "true") {
    return resourceUnavailable(
      "Website visibility management is not available",
    );
  }
  if (
    !env("HOSTED_SITE_VISIBILITY_SITE_IDS").includes(
      get(pathParamsOf(hostContract.siteVisibility)).siteId,
    )
  ) {
    return resourceUnavailable(
      "Website visibility management is not available",
    );
  }
  const auth = get(organizationAuthContext$);
  const features = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  return isFeatureEnabled(FeatureSwitchKey.HostedSiteVisibility, features)
    ? null
    : resourceUnavailable("Website visibility management is not available");
});

const read$ = command(async ({ get, set }, signal: AbortSignal) => {
  const denied = await set(admission$, signal);
  if (denied) {
    return denied;
  }
  const body = await set(
    getHostedSiteVisibility$,
    {
      ...get(organizationAuthContext$),
      ...get(pathParamsOf(hostContract.siteVisibility)),
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
  const body = await get(bodyResultOf(hostContract.updateSiteVisibility));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    updateHostedSiteVisibility$,
    {
      ...get(organizationAuthContext$),
      ...get(pathParamsOf(hostContract.updateSiteVisibility)),
      ...body.data,
    },
    signal,
  );
  if (result.status === "not_found") {
    return notFound("Published website not found");
  }
  if (result.status === "conflict") {
    return conflict("Website visibility changed; reload before editing");
  }
  return { status: 200 as const, body: result.body };
});

const access$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const { siteId } = get(pathParamsOf(hostContract.siteAccess));
  let body = await set(checkHostedSiteAccess$, { siteId }, signal);
  if (body.decision === "authenticate") {
    const userId = await get(
      hostedSiteSessionViewer(
        { siteId, origin: get(queryOf(hostContract.siteAccess)).origin },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (userId) {
      body = await set(checkHostedSiteAccess$, { siteId, userId }, signal);
    }
  }
  return { status: 200 as const, body };
});

const download$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await set(
    authorizeHostedSiteDownload$,
    {
      ...get(pathParamsOf(hostContract.downloadAuthorization)),
      ...get(queryOf(hostContract.downloadAuthorization)),
    },
    signal,
  );
  return { status: 200 as const, body };
});

const ownerAuth = {
  requiredCapability: "host:write",
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

function sessionUnauthorized() {
  return {
    status: 401 as const,
    body: {
      error: { code: "UNAUTHORIZED", message: "Website sign-in is required" },
    },
  };
}

const authorizeSession$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  set(setResHeader$, "Referrer-Policy", "no-referrer");
  const input = await get(bodyResultOf(hostContract.authorizeSiteSession));
  signal.throwIfAborted();
  if (!input.ok) {
    return input.response;
  }
  const result = await set(
    authorizeHostedSiteSession$,
    {
      ...get(pathParamsOf(hostContract.authorizeSiteSession)),
      ...input.data,
    },
    signal,
  );
  if (result.status === "unauthenticated") {
    return sessionUnauthorized();
  }
  if (result.status === "denied") {
    return resourceUnavailable("Website access is unavailable");
  }
  return { status: 200 as const, body: { callbackUrl: result.callbackUrl } };
});

const exchangeSession$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const input = await get(bodyResultOf(hostContract.exchangeSiteSession));
  signal.throwIfAborted();
  if (!input.ok) {
    return input.response;
  }
  const body = await set(
    exchangeHostedSiteSession$,
    {
      ...get(pathParamsOf(hostContract.exchangeSiteSession)),
      ...input.data,
    },
    signal,
  );
  return body ? { status: 200 as const, body } : sessionUnauthorized();
});

export const hostedSiteAccessRoutes: readonly RouteEntry[] = [
  { route: hostContract.authorizeSiteSession, handler: authorizeSession$ },
  { route: hostContract.exchangeSiteSession, handler: exchangeSession$ },
  { route: hostContract.siteVisibility, handler: authRoute(ownerAuth, read$) },
  {
    route: hostContract.updateSiteVisibility,
    handler: authRoute(ownerAuth, update$),
  },
  { route: hostContract.siteAccess, handler: access$ },
  { route: hostContract.downloadAuthorization, handler: download$ },
];
