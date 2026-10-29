import { command } from "ccstate";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { welcomeThreadPreviewImageUrl } from "@okouai/core/welcome-thread-assets";
import { resolveHostedSitePreview$ } from "../services/hosted-site-preview.service";
import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
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
  getHostedSiteBanner$,
  updateHostedSiteBanner$,
} from "../services/hosted-site-banner.service";
import {
  authorizeHostedSiteSession$,
  exchangeHostedSiteSession$,
  hostedSiteSessionViewer$,
} from "../services/hosted-site-sessions.service";
import { conflict, notFound, resourceUnavailable } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

const preview$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const { hostname } = get(queryOf(hostContract.sitePreview));
  const body = await set(
    resolveHostedSitePreview$,
    {
      ...get(pathParamsOf(hostContract.sitePreview)),
      ...get(queryOf(hostContract.sitePreview)),
      userId: get(authContext$).userId,
    },
    signal,
  );
  if (!body) {
    return notFound("Website preview is unavailable");
  }
  const previewImageUrl =
    body.previewImageUrl ??
    welcomeThreadPreviewImageUrl(`https://${hostname}/`);
  return {
    status: 200 as const,
    body: { ...body, ...(previewImageUrl ? { previewImageUrl } : {}) },
  };
});

const read$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
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
  set(setResHeader$, "Cache-Control", "private, no-store");
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
    const userId = await set(
      hostedSiteSessionViewer$,
      { siteId, origin: get(queryOf(hostContract.siteAccess)).origin },
      signal,
    );
    signal.throwIfAborted();
    if (userId) {
      body = await set(checkHostedSiteAccess$, { siteId, userId }, signal);
    }
  }
  return { status: 200 as const, body };
});

const readBanner$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await set(
    getHostedSiteBanner$,
    {
      ...get(organizationAuthContext$),
      ...get(pathParamsOf(hostContract.siteBanner)),
    },
    signal,
  );
  return body
    ? { status: 200 as const, body }
    : notFound("Published website not found");
});

const updateBanner$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const input = await get(bodyResultOf(hostContract.updateSiteBanner));
  signal.throwIfAborted();
  if (!input.ok) {
    return input.response;
  }
  const result = await set(
    updateHostedSiteBanner$,
    {
      ...get(organizationAuthContext$),
      ...get(pathParamsOf(hostContract.updateSiteBanner)),
      ...input.data,
    },
    signal,
  );
  if (result.status === "not_found") {
    return notFound("Published website not found");
  }
  if (result.status === "conflict") {
    return conflict("Website banner changed; reload before editing");
  }
  return { status: 200 as const, body: result.body };
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
  {
    route: hostContract.siteBanner,
    handler: authRoute(ownerAuth, readBanner$),
  },
  {
    route: hostContract.updateSiteBanner,
    handler: authRoute(ownerAuth, updateBanner$),
  },
  {
    route: hostContract.sitePreview,
    handler: authRoute({ requiredCapability: "host:read" }, preview$),
  },
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
