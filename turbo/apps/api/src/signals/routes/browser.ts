import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { command, computed } from "ccstate";
import { constrainBrowserDisplay } from "@okouai/core/browser-display";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import type { BrowserServiceError } from "../services/browser-error";
import { createBrowserGraph } from "../services/browser.service";

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

function viewerModeError(tokenType: string, includeViewer: boolean) {
  return includeViewer && tokenType !== "session"
    ? errorResponse({
        kind: "error",
        status: 403,
        code: "BROWSER_VIEWER_SESSION_REQUIRED",
        message: "Browser viewer connections require a signed-in session",
      })
    : null;
}

const createBody$ = bodyResultOf(browserContract.create);
const runBrowserInput$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    ...("runId" in auth ? { runId: auth.runId } : {}),
  };
});
const runBrowser = createBrowserGraph(runBrowserInput$);
const threadParams$ = pathParamsOf(browserContract.get);
const threadBrowserInput$ = computed(async (get) => {
  return {
    ...(await get(runBrowserInput$)),
    chatThreadId: get(threadParams$).threadId,
  };
});
const threadBrowser = createBrowserGraph(threadBrowserInput$);
const createBrowserInput$ = computed(async (get) => {
  const body = await get(createBody$);
  return body.ok ? { ...(await get(runBrowserInput$)), ...body.data } : null;
});
const createBrowser = createBrowserGraph(createBrowserInput$);
const resizeByThreadBody$ = bodyResultOf(browserContract.resizeByThread);
const resizeBrowserInput$ = computed(async (get) => {
  const body = await get(resizeByThreadBody$);
  return body.ok
    ? {
        ...(await get(threadBrowserInput$)),
        aspectRatio: body.data.aspectRatio,
      }
    : null;
});
const resizeBrowser = createBrowserGraph(resizeBrowserInput$);
const createBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(createBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(createBrowser.open$, signal);
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
  const result = await set(runBrowser.open$, signal);
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
    const result = await set(runBrowser.lease$, signal);
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
  },
);

const leaseByThreadBody$ = bodyResultOf(browserContract.leaseByThread);
const leaseBrowserByThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(leaseByThreadBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(threadBrowser.lease$, signal);
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
  },
);

const openBody$ = bodyResultOf(browserContract.open);
const openQuery$ = queryOf(browserContract.open);
const openBrowserInput$ = computed(async (get) => {
  const body = await get(openBody$);
  if (!body.ok) {
    return null;
  }
  const initialDisplay = body.data.initialDisplay
    ? constrainBrowserDisplay(body.data.initialDisplay)
    : undefined;
  // The request's dimension and density limits guarantee a representable raster.
  if (initialDisplay === null) {
    throw new Error("Validated Browser display cannot fit the raster budget");
  }
  return {
    ...(await get(threadBrowserInput$)),
    initialDisplay,
    viewer: get(openQuery$)?.viewer === "native",
    operationId: body.data.operationId,
  };
});
const openBrowser = createBrowserGraph(openBrowserInput$);
const openBrowserInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(openBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  const includeViewer = get(openQuery$)?.viewer === "native";
  if (includeViewer) {
    set(setResHeader$, "Cache-Control", "no-store");
  }
  const denied = viewerModeError(auth.tokenType, includeViewer);
  if (denied) {
    return denied;
  }
  const result = await set(openBrowser.open$, signal);
  return result.kind === "error"
    ? errorResponse(result)
    : {
        status: 200 as const,
        body: {
          browser: result.value.browser,
          ...(includeViewer ? { viewer: result.value } : {}),
        },
      };
});

const closeBody$ = bodyResultOf(browserContract.close);
const closeBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(closeBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(threadBrowser.close$, signal);
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: result.value };
  },
);

const resizeBrowserByThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(resizeByThreadBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(resizeBrowser.resize$, signal);
    return result.kind === "error"
      ? errorResponse(result)
      : { status: 200 as const, body: { browser: result.value } };
  },
);

const currentBrowserInner$ = command(async ({ set }, signal: AbortSignal) => {
  const result = await set(runBrowser.present$, false, signal);
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: result.value };
});

const getQuery$ = queryOf(browserContract.get);
const getBrowserInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const includeViewer = get(getQuery$)?.viewer === "native";
  if (includeViewer) {
    set(setResHeader$, "Cache-Control", "no-store");
  }
  const denied = viewerModeError(auth.tokenType, includeViewer);
  if (denied) {
    return denied;
  }
  const result = await set(threadBrowser.present$, includeViewer, signal);
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: result.value };
});

const viewerConnectionInner$ = command(async ({ set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const result = await set(threadBrowser.viewer$, signal);
  return result.kind === "error"
    ? errorResponse(result)
    : { status: 200 as const, body: result.value };
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
  {
    route: browserContract.viewerConnection,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        accept: ["session"],
      },
      viewerConnectionInner$,
    ),
  },
];
