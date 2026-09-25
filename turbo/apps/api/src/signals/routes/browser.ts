import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  createBrowser$,
  closeBrowserForThread$,
  getCurrentBrowser$,
  getBrowser$,
  leaseCurrentBrowser$,
  leaseBrowserByThread$,
  openBrowserForThread$,
  resizeBrowserByThread$,
  useBrowser$,
  type BrowserServiceError,
} from "../services/browser.service";

function errorResponse(error: BrowserServiceError) {
  return {
    status: error.status,
    body: {
      error: {
        message: error.message,
        code: error.code,
      },
    },
  };
}

const createBody$ = bodyResultOf(browserContract.create);
const createBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(createBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      createBrowser$,
      {
        actor: {
          orgId: auth.orgId,
          userId: auth.userId,
          ...("runId" in auth ? { runId: auth.runId } : {}),
        },
        input: body.data,
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 201 as const, body: result.value };
  },
);

const useBody$ = bodyResultOf(browserContract.use);
const useBrowserInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(useBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  const result = await set(
    useBrowser$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      ...("runId" in auth ? { runId: auth.runId } : {}),
    },
    signal,
  );
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: result.value };
});

const leaseBody$ = bodyResultOf(browserContract.lease);
const leaseBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(leaseBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      leaseCurrentBrowser$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...("runId" in auth ? { runId: auth.runId } : {}),
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
  },
);

const leaseByThreadParams$ = pathParamsOf(browserContract.leaseByThread);
const leaseByThreadBody$ = bodyResultOf(browserContract.leaseByThread);
const leaseBrowserByThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(leaseByThreadBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      leaseBrowserByThread$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        chatThreadId: get(leaseByThreadParams$).threadId,
        ...("runId" in auth ? { runId: auth.runId } : {}),
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
  },
);

const openParams$ = pathParamsOf(browserContract.open);
const openBody$ = bodyResultOf(browserContract.open);
const openBrowserInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(openBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  const result = await set(
    openBrowserForThread$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      chatThreadId: get(openParams$).threadId,
      lifecycleEventId: body.data.eventId,
      ...("runId" in auth ? { runId: auth.runId } : {}),
    },
    signal,
  );
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: result.value };
});

const closeParams$ = pathParamsOf(browserContract.close);
const closeBody$ = bodyResultOf(browserContract.close);
const closeBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(closeBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      closeBrowserForThread$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        chatThreadId: get(closeParams$).threadId,
        lifecycleEventId: body.data.eventId,
        ...("runId" in auth ? { runId: auth.runId } : {}),
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: result.value };
  },
);

const resizeByThreadParams$ = pathParamsOf(browserContract.resizeByThread);
const resizeByThreadBody$ = bodyResultOf(browserContract.resizeByThread);
const resizeBrowserByThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(resizeByThreadBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      resizeBrowserByThread$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        chatThreadId: get(resizeByThreadParams$).threadId,
        aspectRatio: body.data.aspectRatio,
        ...("runId" in auth ? { runId: auth.runId } : {}),
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
  },
);

const currentBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const result = await set(
      getCurrentBrowser$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        ...("runId" in auth ? { runId: auth.runId } : {}),
      },
      signal,
    );
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
  },
);

const getParams$ = pathParamsOf(browserContract.get);
const getBrowserInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const result = await set(
    getBrowser$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      chatThreadId: get(getParams$).threadId,
      ...("runId" in auth ? { runId: auth.runId } : {}),
    },
    signal,
  );
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: { browser: result.value } };
});

const browserReadAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "browser:read" as const,
  accept: Object.freeze(["session", "agent"] as const),
});

const browserWriteAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "browser:write" as const,
  accept: Object.freeze(["agent"] as const),
});

// Keeping a browser alive and restarting a suspended one are viewer actions, so
// the signed-in owner may call them without a live run.
const browserViewerWriteAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "browser:write" as const,
  accept: Object.freeze(["session", "agent"] as const),
});

const browserCurrentAuth = Object.freeze({
  requireOrganization: true,
  missingOrganizationStatus: 401 as const,
  requiredCapability: "browser:read" as const,
  accept: Object.freeze(["agent"] as const),
});

export const browserRoutes: readonly RouteEntry[] = [
  {
    route: browserContract.create,
    handler: authRoute(browserWriteAuth, createBrowserInner$),
  },
  {
    route: browserContract.use,
    handler: authRoute(browserWriteAuth, useBrowserInner$),
  },
  {
    route: browserContract.lease,
    handler: authRoute(browserWriteAuth, leaseBrowserInner$),
  },
  {
    route: browserContract.leaseByThread,
    handler: authRoute(browserViewerWriteAuth, leaseBrowserByThreadInner$),
  },
  {
    route: browserContract.open,
    handler: authRoute(browserViewerWriteAuth, openBrowserInner$),
  },
  {
    route: browserContract.close,
    handler: authRoute(browserViewerWriteAuth, closeBrowserInner$),
  },
  {
    route: browserContract.resizeByThread,
    handler: authRoute(browserViewerWriteAuth, resizeBrowserByThreadInner$),
  },
  {
    route: browserContract.current,
    handler: authRoute(browserCurrentAuth, currentBrowserInner$),
  },
  {
    route: browserContract.get,
    handler: authRoute(browserReadAuth, getBrowserInner$),
  },
];
