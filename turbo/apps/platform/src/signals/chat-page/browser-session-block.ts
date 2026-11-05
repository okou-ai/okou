import { BROWSER_IDLE_LEASE_MINUTES } from "@okouai/api-contracts/validators/browser";
import { browserContract } from "@okouai/api-contracts/client/browser";
import type {
  BrowserSession,
  BrowserViewerConnection,
} from "@okouai/api-contracts/contracts/browser";
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
  readonly sessionOverride$: State<BrowserSessionResult | undefined>;
  readonly leaseOverride$: State<BrowserSession | undefined>;
}

export interface BrowserSessionDescriptor {
  readonly threadId: string;
  readonly href: string;
}

export type BrowserSessionPanelState =
  | BrowserAuthorizationRequired
  | {
      readonly status: BrowserSession["status"];
      readonly screenshotUrl: BrowserSession["screenshotUrl"];
      readonly liveUrl: BrowserSession["liveUrl"];
      readonly instanceId: string | undefined;
      readonly windowId: number | undefined;
    };

export interface BrowserSessionSignals extends BrowserSessionDescriptor {
  /** Load state of the session's screenshot thumbnail. */
  readonly screenshotImageLoad: ImageLoadSignals;
  /** A new authorization grant owns a new native viewer, even for the same window. */
  readonly authorizationScope$: Computed<string>;
  readonly session$: Computed<Promise<BrowserSessionResult>>;
  readonly panelSession$: Computed<Promise<BrowserSessionPanelState | null>>;
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

async function fetchBrowserSession(
  createClient: ApiClientFactory,
  threadId: string,
): Promise<BrowserSessionResult> {
  const response = await browserAuthorizationResult(
    accept(
      createClient(browserContract).get({
        params: { threadId },
      }),
      [200, 404],
      undefined,
      AUTHORIZATION_OPTIONS,
    ),
  );
  if (isBrowserUnauthorized(response)) {
    return response;
  }
  return response.status === 200 ? response.body.browser : null;
}

async function requestBrowserSessionLease(
  createClient: ApiClientFactory,
  threadId: string,
  signal: AbortSignal,
) {
  const [lease] = await Promise.allSettled([
    accept(
      createClient(browserContract).leaseByThread({
        params: { threadId },
        body: {},
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
  // renew again. Unknown failures and cancellation must still stop the work.
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
  readonly connectionChanged$: BrowserSignals["connectionChanged$"];
}

function createStartBrowserSignals(
  {
    descriptor,
    lifetime$,
    reload$,
    connectionChanged$,
  }: BrowserMutationSignalContext,
  measureInitialDisplay$: BrowserSignals["measureInitialDisplay$"],
  session$: Computed<Promise<BrowserSessionResult>>,
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
    const [started] = await Promise.allSettled([
      browserAuthorizationResult(
        accept(
          get(apiClient$)(browserContract).open({
            params: { threadId: descriptor.threadId },
            body: initialDisplay ? { initialDisplay } : {},
            fetchOptions: { signal },
          }),
          [200],
          signal,
          AUTHORIZATION_OPTIONS,
        ),
      ),
    ]);
    signal.throwIfAborted();
    if (started.status === "rejected") {
      if (get(lifetime$) === lifetime) {
        set(reload$);
      }
      throw started.reason;
    }
    if (get(lifetime$) !== lifetime) {
      return;
    }
    set(reload$);
    set(
      get(lifetime$).sessionOverride$,
      isBrowserUnauthorized(started.value)
        ? UNAUTHORIZED
        : started.value.body.browser,
    );
    set(connectionChanged$);
  });
  return { start$: openBrowser$ };
}

function createCloseBrowserSignals({
  descriptor,
  reload$,
}: BrowserMutationSignalContext): Pick<BrowserSessionSignals, "close$"> {
  const close$ = command(async ({ get, set }, signal: AbortSignal) => {
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    await withCleanup(
      browserAuthorizationResult(
        accept(
          get(apiClient$)(browserContract).close({
            params: { threadId: descriptor.threadId },
            body: {},
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
      { set },
      payload: unknown,
      signal: AbortSignal,
    ): Promise<boolean> | boolean => {
      const parsed = browserSessionChangedPayloadSchema.safeParse(payload);
      if (parsed.success && parsed.data.threadId === descriptor.threadId) {
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
  connectionChanged$: BrowserSignals["connectionChanged$"],
): Pick<BrowserSessionSignals, "keepAliveRef$"> {
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
        set(lifetime.sessionOverride$, UNAUTHORIZED);
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
            // Only this idempotent renewal can continue at the normal interval.
            // An outage must not replay input or invalidate the mounted viewer.
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

function createBrowserSessionReadSignals(descriptor: BrowserSessionDescriptor) {
  const reloadVersion$ = state(0);
  const accessVersion$ = threadComputerAccessVersion(descriptor.threadId);
  const authorizationScope$ = computed((get) => {
    return get(accessVersion$) ?? "initial";
  });
  const lifetime$ = computed((get) => {
    get(reloadVersion$);
    get(authorizationScope$);
    // These are lifetime-local resource outcomes, not independent UI flags.
    return {
      sessionOverride$: state<BrowserSessionResult | undefined>(undefined),
      leaseOverride$: state<BrowserSession | undefined>(undefined),
    };
  });
  const lifecycleSession$ = computed(
    async (get): Promise<BrowserSessionResult> => {
      const lifetime = get(lifetime$);
      const override = get(lifetime.sessionOverride$);
      return override === undefined
        ? await fetchBrowserSession(get(apiClient$), descriptor.threadId)
        : override;
    },
  );
  const session$ = computed(async (get): Promise<BrowserSessionResult> => {
    const lifetime = get(lifetime$);
    const session = await get(lifecycleSession$);
    return isBrowserUnauthorized(session)
      ? session
      : (get(lifetime.leaseOverride$) ?? session);
  });
  // Lease timestamps remain authoritative in session$, but do not change the
  // panel's presentation or the mounted viewer's connection identity.
  const panelSession$ = computed(
    async (get): Promise<BrowserSessionPanelState | null> => {
      const session = await get(session$);
      if (isBrowserUnauthorized(session)) {
        return session;
      }
      return session
        ? {
            status: session.status,
            screenshotUrl: session.screenshotUrl,
            liveUrl: session.liveUrl,
            instanceId: session.window?.instanceId,
            windowId: session.window?.primaryWindowId,
          }
        : null;
    },
  );
  // Lifecycle reloads (including open/close) can replace the connection. Lease
  // responses only refresh presentation and must not interrupt live input.
  const viewerConnection$ = computed(async (get) => {
    const lifecycleSession = await get(lifecycleSession$);
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
            instanceId: connection.browser.window?.instanceId ?? null,
            windowId: connection.browser.window?.primaryWindowId ?? null,
            extension: connection.extension,
          }
        : null;
    },
  );
  return {
    reloadVersion$,
    authorizationScope$,
    lifetime$,
    lifecycleSession$,
    session$,
    panelSession$,
    viewerConnection$,
    browserConnection$,
  };
}

export function createBrowserSessionSignals(
  threadId: string,
  onPageInput$?: Command<void, []>,
): BrowserSessionSignals {
  const descriptor = { threadId, href: `/browsers/${threadId}` };
  const screenshotImageLoad = createImageLoadSignals();
  const {
    reloadVersion$,
    authorizationScope$,
    lifetime$,
    lifecycleSession$,
    session$,
    panelSession$,
    viewerConnection$,
    browserConnection$,
  } = createBrowserSessionReadSignals(descriptor);
  const reload$ = command(({ set }) => {
    set(reloadVersion$, (version) => {
      return version + 1;
    });
    set(browser.connectionChanged$);
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
    connectionChanged$: browser.connectionChanged$,
  };
  const startSignals = createStartBrowserSignals(
    mutationContext,
    browser.measureInitialDisplay$,
    lifecycleSession$,
  );
  const closeSignals = createCloseBrowserSignals(mutationContext);
  const subscriptionSignals = createBrowserSessionSubscriptionSignals(
    descriptor,
    session$,
    reload$,
  );

  const keepAliveSignals = createBrowserSessionKeepAliveSignals(
    descriptor,
    session$,
    lifetime$,
    reload$,
    browser.connectionChanged$,
  );

  return {
    ...descriptor,
    screenshotImageLoad,
    authorizationScope$,
    session$,
    panelSession$,
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
