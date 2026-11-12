import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { command, computed } from "ccstate";
import { constrainBrowserDisplay } from "@okouai/core/browser-display";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import type { BrowserServiceError } from "../services/browser.service";
import { createSharedBrowserGraph } from "../services/browser-shared.service";

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
const sharedRunInput$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    ...("runId" in auth ? { runId: auth.runId } : {}),
  };
});
const sharedRun = createSharedBrowserGraph(sharedRunInput$);
const sharedThreadParams$ = pathParamsOf(browserContract.get);
const sharedThreadInput$ = computed(async (get) => {
  return {
    ...(await get(sharedRunInput$)),
    chatThreadId: get(sharedThreadParams$).threadId,
  };
});
const sharedThread = createSharedBrowserGraph(sharedThreadInput$);
const sharedCreateInput$ = computed(async (get) => {
  const body = await get(createBody$);
  return body.ok ? { ...(await get(sharedRunInput$)), ...body.data } : null;
});
const sharedCreate = createSharedBrowserGraph(sharedCreateInput$);
const sharedResizeBody$ = bodyResultOf(browserContract.resizeByThread);
const sharedResizeInput$ = computed(async (get) => {
  const body = await get(sharedResizeBody$);
  return body.ok
    ? { ...(await get(sharedThreadInput$)), aspectRatio: body.data.aspectRatio }
    : null;
});
const sharedResize = createSharedBrowserGraph(sharedResizeInput$);
const createBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(createBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const shared = await set(sharedCreate.open$, signal);
    return shared.kind === "error"
      ? errorResponse(shared)
      : { status: 201 as const, body: shared.value };
  },
);

const useBody$ = bodyResultOf(browserContract.use);
const useBrowserInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(useBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const shared = await set(sharedRun.open$, signal);
  return shared.kind === "error"
    ? errorResponse(shared)
    : { status: 200 as const, body: shared.value };
});

const leaseBody$ = bodyResultOf(browserContract.lease);
const leaseBrowserInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(leaseBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const shared = await set(sharedRun.lease$, signal);
    return shared.kind === "error"
      ? errorResponse(shared)
      : { status: 200 as const, body: { browser: shared.value } };
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
    const shared = await set(sharedThread.lease$, signal);
    return shared.kind === "error"
      ? errorResponse(shared)
      : { status: 200 as const, body: { browser: shared.value } };
  },
);

const openBody$ = bodyResultOf(browserContract.open);
const openQuery$ = queryOf(browserContract.open);
const sharedOpenInput$ = computed(async (get) => {
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
    ...(await get(sharedThreadInput$)),
    initialDisplay,
    viewer: get(openQuery$)?.viewer === "native",
    operationId: body.data.operationId,
  };
});
const sharedOpen = createSharedBrowserGraph(sharedOpenInput$);
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
  const shared = await set(sharedOpen.open$, signal);
  return shared.kind === "error"
    ? errorResponse(shared)
    : {
        status: 200 as const,
        body: {
          browser: shared.value.browser,
          ...(includeViewer ? { viewer: shared.value } : {}),
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
    const shared = await set(sharedThread.close$, signal);
    return shared.kind === "error"
      ? errorResponse(shared)
      : { status: 200 as const, body: shared.value };
  },
);

const resizeByThreadBody$ = bodyResultOf(browserContract.resizeByThread);
const resizeBrowserByThreadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(resizeByThreadBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const shared = await set(sharedResize.resize$, signal);
    return shared.kind === "error"
      ? errorResponse(shared)
      : { status: 200 as const, body: { browser: shared.value } };
  },
);

const currentBrowserInner$ = command(async ({ set }, signal: AbortSignal) => {
  const shared = await set(sharedRun.present$, false, signal);
  return shared.kind === "error"
    ? errorResponse(shared)
    : { status: 200 as const, body: shared.value };
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
  const shared = await set(sharedThread.present$, includeViewer, signal);
  return shared.kind === "error"
    ? errorResponse(shared)
    : { status: 200 as const, body: shared.value };
});

const viewerConnectionInner$ = command(async ({ set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const shared = await set(sharedThread.viewer$, signal);
  return shared.kind === "error"
    ? errorResponse(shared)
    : { status: 200 as const, body: shared.value };
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
