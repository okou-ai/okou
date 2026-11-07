import { BROWSER_IDLE_LEASE_MINUTES } from "@okouai/api-contracts/validators/browser";
import { browserContract } from "@okouai/api-contracts/client/browser";
import type {
  BrowserSession,
  BrowserViewerConnection,
  BrowserViewerAcquisition,
  BrowserTabOrder,
} from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { browserSessionChangedPayloadSchema } from "@okouai/api-contracts/validators/realtime";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";

import { formatAppNumber } from "../../i18n/format.ts";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { ApiError } from "../../lib/api-error.ts";
import { isNetworkRequestError } from "../../lib/network-error.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import {
  createBrowserSignals,
  type BrowserConnection,
  type BrowserSignals,
} from "../browser/browser.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import { logger } from "../log.ts";
import { onRef, setLoop, throwIfAbort, withCleanup } from "../utils.ts";
import {
  createImageLoadSignals,
  type ImageLoadSignals,
} from "../image-load.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";
import { threadComputerAccessVersion } from "./chat-thread-event-sourcing.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { authenticatedSessionKey$ } from "../auth.ts";

// One heartbeat per minute keeps an open browser panel comfortably inside its
// ten-minute idle lease without making the lease itself stackable.
const LEASE_HEARTBEAT_INTERVAL_MS = 60_000;
const L = logger("BrowserHeartbeat");
const AUTHORIZATION_OPTIONS = {
  expectedErrors: { 403: ["BROWSER_AUTHORIZATION_REQUIRED"] },
  showExpectedErrorToast: false,
} as const;

interface BrowserAuthorizationRequired {
  readonly status: "unauthorized";
}

const UNAUTHORIZED = { status: "unauthorized" } as const;
type BrowserSessionResult =
  BrowserSession | BrowserAuthorizationRequired | null;
type BrowserAcquisitionResult =
  BrowserViewerAcquisition | BrowserAuthorizationRequired | null;
type BrowserAcquisitionMode = "legacy" | "summary" | "viewer";
interface BrowserAcquisitionScope {
  readonly authorizationScope: string;
  readonly mode: BrowserAcquisitionMode;
}

export function isBrowserUnauthorized(
  value: unknown,
): value is BrowserAuthorizationRequired {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "unauthorized"
  );
}

function isBrowserAuthorizationError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.code === "BROWSER_AUTHORIZATION_REQUIRED"
  );
}

async function browserAuthorizationResult<T>(
  request: Promise<T>,
): Promise<T | BrowserAuthorizationRequired> {
  const [result] = await Promise.allSettled([request]);
  if (result.status === "fulfilled") {
    return result.value;
  }
  if (isBrowserAuthorizationError(result.reason)) {
    return UNAUTHORIZED;
  }
  throw result.reason;
}

interface BrowserSessionLifetime {
  readonly scope: BrowserAcquisitionScope;
  // The initiating viewer can consume its own open result instead of its echo.
  // Any independent invalidation creates another owner and retires this ID.
  readonly openOperationId$: State<string | null>;
  readonly acquisitionOverride$: State<BrowserAcquisitionResult | undefined>;
  readonly leaseOverride$: State<BrowserSession | undefined>;
}

export interface BrowserSessionDescriptor {
  readonly threadId: string;
  readonly href: string;
}

/** What the panel shows: authorization, the session lifecycle, or nothing. */
export type BrowserSessionPanelStatus =
  "unauthorized" | BrowserSession["status"] | null;

export interface BrowserSessionSignals extends BrowserSessionDescriptor {
  /** Load state of the session's screenshot thumbnail. */
  readonly screenshotImageLoad: ImageLoadSignals;
  /** A new authorization grant owns a new native viewer, even for the same window. */
  readonly authorizationScope$: Computed<string>;
  readonly session$: Computed<Promise<BrowserSessionResult>>;
  /**
   * Panel presentation as primitives. Lease renewals rewrite the session
   * object but leave these values unchanged, so they do not render the panel.
   */
  readonly panelStatus$: Computed<Promise<BrowserSessionPanelStatus>>;
  readonly panelLiveUrl$: Computed<Promise<BrowserSession["liveUrl"] | null>>;
  readonly panelInstanceId$: Computed<Promise<string | undefined>>;
  readonly panelWindowId$: Computed<Promise<number | undefined>>;
  readonly viewerConnection$: Computed<
    Promise<
      | (BrowserViewerConnection & {
          readonly requestedSession: BrowserSession;
        })
      | null
      | BrowserAuthorizationRequired
    >
  >;
  readonly browser: BrowserSignals;
  readonly reload$: Command<void, []>;
  readonly reloadPanel$: Command<void, []>;
  readonly start$: Command<Promise<void>, [AbortSignal]>;
  readonly close$: Command<Promise<void>, [AbortSignal]>;
  readonly subscribe$: Command<void, [AbortSignal]>;
  // An open panel keeps only its own chat's Browser window alive.
  readonly keepAliveRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}

export function parseBrowserSessionUrl(
  value: string,
): BrowserSessionDescriptor | null {
  const url = parseTrustedPlatformActionUrl(value);
  if (!url) {
    return null;
  }
  const match = url.pathname.match(
    /^\/browsers\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/iu,
  );
  const threadId = match?.[1];
  if (!threadId) {
    return null;
  }
  return {
    threadId,
    href: `/browsers/${threadId}`,
  };
}

async function fetchBrowserAcquisition(
  createClient: ApiClientFactory,
  threadId: string,
  nativeViewer: boolean,
): Promise<BrowserAcquisitionResult> {
  const response = await browserAuthorizationResult(
    accept(
      createClient(browserContract).get({
        params: { threadId },
        ...(nativeViewer ? { query: { viewer: "native" as const } } : {}),
      }),
      [200, 404],
      undefined,
      AUTHORIZATION_OPTIONS,
    ),
  );
  if (isBrowserUnauthorized(response)) {
    return response;
  }
  return response.status === 200 ? response.body : null;
}

async function requestBrowserSessionLease(
  createClient: ApiClientFactory,
  threadId: string,
  signal: AbortSignal,
  tabOrder: BrowserTabOrder | null,
) {
  const [lease] = await Promise.allSettled([
    accept(
      createClient(browserContract).leaseByThread({
        params: { threadId },
        body: { tabOrder: tabOrder ?? undefined },
        fetchOptions: { signal },
      }),
      [200, 404, 409, 500, 502, 503, 504],
      signal,
      AUTHORIZATION_OPTIONS,
    ),
  ]);
  signal.throwIfAborted();
  if (lease.status === "fulfilled") {
    return lease.value;
  }
  const error: unknown = lease.reason;
  throwIfAbort(error);
  if (isBrowserAuthorizationError(error)) {
    return UNAUTHORIZED;
  }
  if (!isNetworkRequestError(error)) {
    throw error;
  }
  // No response confirms this idempotent renewal; its owner decides when to
  // renew again. An unknown failure fails this round, which the heartbeat
  // loop reports before renewing again; cancellation stops the work.
  return null;
}

function sameBrowserWindow(
  left: BrowserSession["window"],
  right: BrowserSession["window"],
): boolean {
  return (
    left?.instanceId === right?.instanceId &&
    left?.primaryWindowId === right?.primaryWindowId
  );
}

interface BrowserMutationSignalContext {
  readonly descriptor: BrowserSessionDescriptor;
  readonly lifetime$: Computed<BrowserSessionLifetime>;
  readonly reload$: Command<void, []>;
}

function createStartBrowserSignals(
  { descriptor, lifetime$, reload$ }: BrowserMutationSignalContext,
  measureInitialDisplay$: BrowserSignals["measureInitialDisplay$"],
  session$: Computed<Promise<BrowserSessionResult>>,
  replaceAcquisition$: Command<
    void,
    [BrowserAcquisitionResult | undefined, string | null]
  >,
): Pick<BrowserSessionSignals, "start$"> {
  const openBrowser$ = command(async ({ get, set }, signal: AbortSignal) => {
    const lifetime = get(lifetime$);
    const current = await get(session$);
    signal.throwIfAborted();
    if (get(lifetime$) !== lifetime || isBrowserUnauthorized(current)) {
      return;
    }
    const initialDisplay =
      current?.status === "active" ? null : set(measureInitialDisplay$);
    const operationId =
      lifetime.scope.mode === "viewer" ? crypto.randomUUID() : null;
    set(lifetime.openOperationId$, operationId);
    const retirePendingOpen = () => {
      set(lifetime.openOperationId$, null);
    };
    signal.addEventListener("abort", retirePendingOpen, { once: true });
    const [started] = await Promise.allSettled([
      browserAuthorizationResult(
        accept(
          get(apiClient$)(browserContract).open({
            params: { threadId: descriptor.threadId },
            ...(lifetime.scope.mode === "viewer"
              ? { query: { viewer: "native" as const } }
              : {}),
            body: {
              ...(initialDisplay ? { initialDisplay } : {}),
              ...(operationId ? { operationId } : {}),
            },
            fetchOptions: { signal },
          }),
          [200],
          signal,
          AUTHORIZATION_OPTIONS,
        ),
      ),
    ]);
    signal.throwIfAborted();
    signal.removeEventListener("abort", retirePendingOpen);
    set(lifetime.openOperationId$, null);
    if (started.status === "rejected") {
      if (get(lifetime$) === lifetime) {
        set(reload$);
      }
      throw started.reason;
    }
    if (get(lifetime$) !== lifetime) {
      return;
    }
    set(
      replaceAcquisition$,
      isBrowserUnauthorized(started.value) ? UNAUTHORIZED : started.value.body,
      operationId,
    );
  });
  return { start$: openBrowser$ };
}

function createCloseBrowserSignals(
  { descriptor, reload$ }: BrowserMutationSignalContext,
  tabOrder$: BrowserSignals["tabOrder$"],
): Pick<BrowserSessionSignals, "close$"> {
  const close$ = command(async ({ get, set }, signal: AbortSignal) => {
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    await withCleanup(
      browserAuthorizationResult(
        accept(
          get(apiClient$)(browserContract).close({
            params: { threadId: descriptor.threadId },
            body: { tabOrder: get(tabOrder$) ?? undefined },
            fetchOptions: { signal },
          }),
          [200],
          signal,
          AUTHORIZATION_OPTIONS,
        ),
      ),
      () => {
        set(reload$);
      },
    );
    signal.throwIfAborted();
  });
  return { close$ };
}

function createBrowserSessionSubscriptionSignals(
  descriptor: BrowserSessionDescriptor,
  session$: BrowserSessionSignals["session$"],
  lifetime$: Computed<BrowserSessionLifetime>,
  reload$: BrowserSessionSignals["reload$"],
): Pick<BrowserSessionSignals, "subscribe$"> {
  const reloadBrowserSession$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      set(reload$);
      await get(session$);
      signal.throwIfAborted();
      return false;
    },
  );
  const onBrowserSessionChanged$ = command(
    (
      { get, set },
      payload: unknown,
      signal: AbortSignal,
    ): Promise<boolean> | boolean => {
      const parsed = browserSessionChangedPayloadSchema.safeParse(payload);
      if (parsed.success && parsed.data.threadId === descriptor.threadId) {
        if (
          parsed.data.operationId &&
          parsed.data.operationId === get(get(lifetime$).openOperationId$)
        ) {
          return false;
        }
        return set(reloadBrowserSession$, signal);
      }
      return false;
    },
  );
  const subscribe$ = command(({ set }, signal: AbortSignal): void => {
    set(
      setAblyPayloadLoop$,
      {
        topic: "browserSessionChanged",
        loopCommand$: onBrowserSessionChanged$,
        initializeCommand$: reloadBrowserSession$,
        options: { runOnSubscribe: false },
      },
      signal,
    );
  });
  return { subscribe$ };
}

function createBrowserSessionKeepAliveSignals(
  descriptor: BrowserSessionDescriptor,
  session$: BrowserSessionSignals["session$"],
  lifetime$: Computed<BrowserSessionLifetime>,
  reload$: BrowserSessionSignals["reload$"],
  browser: Pick<BrowserSignals, "connectionChanged$" | "tabOrder$">,
): Pick<BrowserSessionSignals, "keepAliveRef$"> {
  const { connectionChanged$, tabOrder$ } = browser;
  const applyLease$ = command(
    async (
      { get, set },
      lifetime: BrowserSessionLifetime,
      mountedSession: BrowserSession | null,
      response: NonNullable<
        Awaited<ReturnType<typeof requestBrowserSessionLease>>
      >,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (isBrowserUnauthorized(response)) {
        set(lifetime.leaseOverride$, undefined);
        set(lifetime.acquisitionOverride$, UNAUTHORIZED);
        set(connectionChanged$);
        return true;
      }
      const currentSession = await get(session$);
      signal.throwIfAborted();
      if (get(lifetime$) !== lifetime) {
        return false;
      }
      if (isBrowserUnauthorized(currentSession)) {
        return true;
      }
      // A response from the previous lifetime cannot replace a reopened window.
      if (
        currentSession?.liveUrl !== mountedSession?.liveUrl ||
        !sameBrowserWindow(currentSession?.window, mountedSession?.window)
      ) {
        return false;
      }
      if (
        response.status === 200 &&
        sameBrowserWindow(response.body.browser.window, currentSession?.window)
      ) {
        set(
          lifetime.leaseOverride$,
          currentSession
            ? { ...response.body.browser, liveUrl: currentSession.liveUrl }
            : response.body.browser,
        );
        return false;
      }
      // Confirm reclaimed state rather than treating failed renewal as expiry.
      set(reload$);
      const reloadedLifetime = get(lifetime$);
      const reloadedSession = await get(session$);
      signal.throwIfAborted();
      return (
        get(lifetime$) === reloadedLifetime &&
        reloadedSession?.status !== "active"
      );
    },
  );
  const keepAliveRef$ = onRef(
    command(({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
      let reportedFailure = false;
      setLoop(
        async () => {
          const lifetime = get(lifetime$);
          const mountedSession = await get(session$);
          signal.throwIfAborted();
          if (get(lifetime$) !== lifetime) {
            return false;
          }
          if (isBrowserUnauthorized(mountedSession)) {
            return true;
          }
          const response = await requestBrowserSessionLease(
            get(apiClient$),
            descriptor.threadId,
            signal,
            get(tabOrder$),
          );
          signal.throwIfAborted();
          // Authorization and reload transitions create a new request owner,
          // even when a re-enabled chat retains the same native window.
          if (get(lifetime$) !== lifetime) {
            return false;
          }
          if (
            !response ||
            (!isBrowserUnauthorized(response) && response.status >= 500)
          ) {
            // An outage keeps the mounted viewer and renews at the normal
            // interval. It must not replay input or invalidate the viewer.
            if (!reportedFailure) {
              // Gateway failures need not have an application error body.
              L.error(
                "Browser heartbeat failed; scheduled renewal will continue",
                {
                  threadId: descriptor.threadId,
                  status: response?.status ?? "network",
                },
              );
              reportedFailure = true;
            }
            return false;
          }
          reportedFailure = false;
          return set(applyLease$, lifetime, mountedSession, response, signal);
        },
        LEASE_HEARTBEAT_INTERVAL_MS,
        signal,
      );
    }),
  );
  return { keepAliveRef$ };
}

function createBrowserSessionAcquisitionSignals(
  descriptor: BrowserSessionDescriptor,
  viewerRequested$: Computed<boolean>,
) {
  const reloadRequest$ = state<{
    readonly acquisition: BrowserAcquisitionResult | undefined;
    readonly scope: BrowserAcquisitionScope | null;
    readonly operationId: string | null;
  }>({ acquisition: undefined, scope: null, operationId: null });
  const accessVersion$ = threadComputerAccessVersion(descriptor.threadId);
  const authorizationScope$ = computed((get) => {
    return JSON.stringify([
      get(authenticatedSessionKey$),
      get(accessVersion$) ?? "initial",
    ]);
  });
  const mode$ = computed((get): BrowserAcquisitionMode => {
    if (!get(featureSwitch$)[FeatureSwitchKey.BrowserSharedOwner]) {
      return "legacy";
    }
    return get(viewerRequested$) ? "viewer" : "summary";
  });
  const acquisitionScope$ = computed((get): BrowserAcquisitionScope => {
    return {
      authorizationScope: get(authorizationScope$),
      mode: get(mode$),
    };
  });
  const lifetime$ = computed((get) => {
    const request = get(reloadRequest$);
    const scope = get(acquisitionScope$);
    // These are lifetime-local resource outcomes, not independent UI flags.
    return {
      scope,
      openOperationId$: state(
        request.scope === scope ? request.operationId : null,
      ),
      acquisitionOverride$: state<BrowserAcquisitionResult | undefined>(
        request.scope === scope ? request.acquisition : undefined,
      ),
      leaseOverride$: state<BrowserSession | undefined>(undefined),
    };
  });
  const lifecycleAcquisition$ = computed(
    async (get): Promise<BrowserAcquisitionResult> => {
      const lifetime = get(lifetime$);
      const override = get(lifetime.acquisitionOverride$);
      return override === undefined
        ? await fetchBrowserAcquisition(
            get(apiClient$),
            descriptor.threadId,
            lifetime.scope.mode === "viewer",
          )
        : override;
    },
  );
  const lifecycleSession$ = computed(
    async (get): Promise<BrowserSessionResult> => {
      const acquisition = await get(lifecycleAcquisition$);
      return acquisition && !isBrowserUnauthorized(acquisition)
        ? acquisition.browser
        : acquisition;
    },
  );
  return {
    reloadRequest$,
    authorizationScope$,
    lifetime$,
    lifecycleAcquisition$,
    lifecycleSession$,
  };
}

function createBrowserSessionReadSignals(
  descriptor: BrowserSessionDescriptor,
  viewerRequested$: Computed<boolean>,
) {
  const {
    reloadRequest$,
    authorizationScope$,
    lifetime$,
    lifecycleAcquisition$,
    lifecycleSession$,
  } = createBrowserSessionAcquisitionSignals(descriptor, viewerRequested$);
  const session$ = computed(async (get): Promise<BrowserSessionResult> => {
    const lifetime = get(lifetime$);
    const session = await get(lifecycleSession$);
    return isBrowserUnauthorized(session)
      ? session
      : (get(lifetime.leaseOverride$) ?? session);
  });
  // Lease timestamps remain authoritative in session$, but do not change the
  // panel's presentation or the mounted viewer's connection identity.
  const panelStatus$ = computed(
    async (get): Promise<BrowserSessionPanelStatus> => {
      const session = await get(session$);
      if (isBrowserUnauthorized(session)) {
        return "unauthorized";
      }
      return session?.status ?? null;
    },
  );
  const panelLiveUrl$ = computed(
    async (get): Promise<BrowserSession["liveUrl"] | null> => {
      const session = await get(session$);
      return isBrowserUnauthorized(session) ? null : (session?.liveUrl ?? null);
    },
  );
  const panelInstanceId$ = computed(
    async (get): Promise<string | undefined> => {
      const session = await get(session$);
      return isBrowserUnauthorized(session)
        ? undefined
        : session?.window?.instanceId;
    },
  );
  const panelWindowId$ = computed(async (get): Promise<number | undefined> => {
    const session = await get(session$);
    return isBrowserUnauthorized(session)
      ? undefined
      : session?.window?.primaryWindowId;
  });
  // Lifecycle reloads (including open/close) can replace the connection. Lease
  // responses only refresh presentation and must not interrupt live input.
  const viewerConnection$ = computed(async (get) => {
    const lifetime = get(lifetime$);
    if (lifetime.scope.mode === "summary") {
      return null;
    }
    const acquisition = await get(lifecycleAcquisition$);
    if (!acquisition || isBrowserUnauthorized(acquisition)) {
      return acquisition;
    }
    const lifecycleSession = acquisition.browser;
    if (lifetime.scope.mode === "viewer") {
      // Shared acquisition is a single operation, never a summary-authorized
      // second credential lookup. An old non-GA API cannot satisfy this mode.
      if (acquisition.viewer === undefined) {
        throw new Error(
          "Shared Browser viewer acquisition is not supported by this API",
        );
      }
      return acquisition.viewer
        ? { ...acquisition.viewer, requestedSession: lifecycleSession }
        : null;
    }
    if (lifecycleSession?.status !== "active") {
      return null;
    }
    const response = await browserAuthorizationResult(
      accept(
        get(apiClient$)(browserContract).viewerConnection({
          params: { threadId: descriptor.threadId },
        }),
        [200],
        undefined,
        AUTHORIZATION_OPTIONS,
      ),
    );
    if (isBrowserUnauthorized(response)) {
      return response;
    }
    return {
      ...response.body,
      // This snapshot identifies the request for retained-panel visibility;
      // native admission uses only the authoritative response below.
      requestedSession: lifecycleSession,
    };
  });

  const browserConnection$ = computed(
    async (get): Promise<BrowserConnection | null> => {
      const connection = await get(viewerConnection$);
      return connection && !isBrowserUnauthorized(connection)
        ? {
            cdpUrl: connection.cdpUrl,
            threadId: descriptor.threadId,
            instanceId:
              connection.browser.window?.instanceId ??
              connection.tabOrder?.instanceId ??
              null,
            windowId: connection.browser.window?.primaryWindowId ?? null,
            extension: connection.extension,
            tabOrder: connection.tabOrder,
          }
        : null;
    },
  );
  return {
    reloadRequest$,
    authorizationScope$,
    lifetime$,
    lifecycleSession$,
    session$,
    panelStatus$,
    panelLiveUrl$,
    panelInstanceId$,
    panelWindowId$,
    viewerConnection$,
    browserConnection$,
  };
}

export function createBrowserSessionSignals(
  threadId: string,
  viewerRequested$: Computed<boolean>,
  onPageInput$?: Command<void, []>,
): BrowserSessionSignals {
  const descriptor = { threadId, href: `/browsers/${threadId}` };
  const screenshotImageLoad = createImageLoadSignals();
  const {
    reloadRequest$,
    authorizationScope$,
    lifetime$,
    lifecycleSession$,
    session$,
    panelStatus$,
    panelLiveUrl$,
    panelInstanceId$,
    panelWindowId$,
    viewerConnection$,
    browserConnection$,
  } = createBrowserSessionReadSignals(descriptor, viewerRequested$);
  const replaceAcquisition$ = command(
    (
      { get, set },
      acquisition: BrowserAcquisitionResult | undefined,
      operationId: string | null,
    ) => {
      // Publish a seeded lifetime in one state update. A successful explicit
      // open must never expose an empty reload that starts a redundant GET.
      const lifetime = get(lifetime$);
      set(reloadRequest$, {
        acquisition,
        scope: lifetime.scope,
        operationId,
      });
      set(browser.connectionChanged$);
    },
  );
  const reload$ = command(({ set }) => {
    set(replaceAcquisition$, undefined, null);
  });
  const browser = createBrowserSignals(
    browserConnection$,
    reload$,
    onPageInput$,
  );
  const mutationContext: BrowserMutationSignalContext = {
    descriptor,
    lifetime$,
    reload$,
  };
  const startSignals = createStartBrowserSignals(
    mutationContext,
    browser.measureInitialDisplay$,
    lifecycleSession$,
    replaceAcquisition$,
  );
  const closeSignals = createCloseBrowserSignals(
    mutationContext,
    browser.tabOrder$,
  );
  const subscriptionSignals = createBrowserSessionSubscriptionSignals(
    descriptor,
    session$,
    lifetime$,
    reload$,
  );

  const keepAliveSignals = createBrowserSessionKeepAliveSignals(
    descriptor,
    session$,
    lifetime$,
    reload$,
    browser,
  );

  return {
    ...descriptor,
    screenshotImageLoad,
    authorizationScope$,
    session$,
    panelStatus$,
    panelLiveUrl$,
    panelInstanceId$,
    panelWindowId$,
    viewerConnection$,
    browser,
    ...startSignals,
    ...closeSignals,
    reload$,
    reloadPanel$: reload$,
    ...subscriptionSignals,
    ...keepAliveSignals,
  };
}

export function browserSessionReclaimHint(
  session: Pick<BrowserSession, "status">,
): string | null {
  return session.status === "active"
    ? i18n.t(
        ($) => {
          return $.browserSession.reclaimHint;
        },
        {
          count: BROWSER_IDLE_LEASE_MINUTES,
          formattedCount: formatAppNumber(BROWSER_IDLE_LEASE_MINUTES),
        },
      )
    : null;
}
