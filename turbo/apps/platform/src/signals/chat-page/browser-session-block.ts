import { BROWSER_IDLE_LEASE_MINUTES } from "@okouai/api-contracts/validators/browser";
import { browserContract } from "@okouai/api-contracts/client/browser";
import type { BrowserSession } from "@okouai/api-contracts/contracts/browser";
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
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import {
  createBrowserSignals,
  type BrowserConnection,
  type BrowserSignals,
} from "../browser/browser.ts";
import { setAblyPayloadLoop$ } from "../realtime.ts";
import { onRef, setLoop, withCleanup } from "../utils.ts";
import {
  createImageLoadSignals,
  type ImageLoadSignals,
} from "../image-load.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

// One heartbeat per minute keeps an open browser panel comfortably inside its
// ten-minute idle lease without making the lease itself stackable.
const LEASE_HEARTBEAT_INTERVAL_MS = 60_000;

export interface BrowserSessionDescriptor {
  readonly threadId: string;
  readonly href: string;
}

export interface BrowserSessionSignals extends BrowserSessionDescriptor {
  /** Load state of the session's screenshot thumbnail. */
  readonly screenshotImageLoad: ImageLoadSignals;
  readonly session$: Computed<Promise<BrowserSession | null>>;
  readonly panelSession$: Computed<Promise<BrowserSession | null>>;
  readonly viewerConnection$: Computed<
    Promise<{
      readonly liveUrl: string | null;
      readonly instanceId: string | null;
      readonly windowId: number | null;
      readonly cdpUrl: string;
      readonly extension: BrowserConnection["extension"];
    } | null>
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
): Promise<BrowserSession | null> {
  const response = await accept(
    createClient(browserContract).get({
      params: { threadId },
    }),
    [200, 404],
  );
  return response.status === 200 ? response.body.browser : null;
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
  readonly sessionOverride$: State<BrowserSession | null | undefined>;
  readonly reload$: Command<void, []>;
  readonly connectionChanged$: BrowserSignals["connectionChanged$"];
}

function createStartBrowserSignals({
  descriptor,
  sessionOverride$,
  reload$,
  connectionChanged$,
}: BrowserMutationSignalContext): Pick<BrowserSessionSignals, "start$"> {
  const openBrowser$ = command(async ({ get, set }, signal: AbortSignal) => {
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    const started = await withCleanup(
      accept(
        get(apiClient$)(browserContract).open({
          params: { threadId: descriptor.threadId },
          body: {},
          fetchOptions: { signal },
        }),
        [200],
        signal,
      ),
      () => {
        set(reload$);
      },
    );
    signal.throwIfAborted();
    set(sessionOverride$, started.body.browser);
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
      accept(
        get(apiClient$)(browserContract).close({
          params: { threadId: descriptor.threadId },
          body: {},
          fetchOptions: { signal },
        }),
        [200],
        signal,
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
  leaseOverride$: State<BrowserSession | undefined>,
  reload$: BrowserSessionSignals["reload$"],
): Pick<BrowserSessionSignals, "keepAliveRef$"> {
  const keepAliveRef$ = onRef(
    command(({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
      setLoop(
        async () => {
          const mountedSession = await get(session$);
          signal.throwIfAborted();
          const response = await accept(
            get(apiClient$)(browserContract).leaseByThread({
              params: { threadId: descriptor.threadId },
              body: {},
              fetchOptions: { signal },
            }),
            [200, 404, 409],
            signal,
          );
          const currentSession = await get(session$);
          signal.throwIfAborted();
          // A response from the previous lifetime cannot replace a reopened
          // window or a newly admitted shared instance.
          if (
            currentSession?.liveUrl !== mountedSession?.liveUrl ||
            !sameBrowserWindow(currentSession?.window, mountedSession?.window)
          ) {
            return false;
          }
          if (
            response.status === 200 &&
            sameBrowserWindow(
              response.body.browser.window,
              currentSession?.window,
            )
          ) {
            set(
              leaseOverride$,
              currentSession
                ? {
                    ...response.body.browser,
                    // Lease responses intentionally omit the provider live
                    // URL, so retain the one loaded by the viewer endpoint.
                    liveUrl: currentSession.liveUrl,
                  }
                : response.body.browser,
            );
            return false;
          }
          // Reclaimed windows pause the panel, but a concurrent reopen keeps
          // the mounted panel's heartbeat alive for its new lifetime.
          set(reload$);
          const reloadedSession = await get(session$);
          signal.throwIfAborted();
          return reloadedSession?.status !== "active";
        },
        LEASE_HEARTBEAT_INTERVAL_MS,
        signal,
      );
    }),
  );
  return { keepAliveRef$ };
}

export function createBrowserSessionSignals(
  threadId: string,
): BrowserSessionSignals {
  const descriptor: BrowserSessionDescriptor = {
    threadId,
    href: `/browsers/${threadId}`,
  };
  const reloadVersion$ = state(0);
  const screenshotImageLoad = createImageLoadSignals();
  const sessionOverride$ = state<BrowserSession | null | undefined>(undefined);
  const leaseOverride$ = state<BrowserSession | undefined>(undefined);
  const lifecycleSession$ = computed(
    async (get): Promise<BrowserSession | null> => {
      get(reloadVersion$);
      const override = get(sessionOverride$);
      return override === undefined
        ? await fetchBrowserSession(get(apiClient$), descriptor.threadId)
        : override;
    },
  );
  const session$ = computed(async (get): Promise<BrowserSession | null> => {
    return get(leaseOverride$) ?? (await get(lifecycleSession$));
  });
  // Lifecycle reloads (including open/close) can replace the connection. Lease
  // responses only refresh presentation and must not interrupt live input.
  const viewerConnection$ = computed(async (get) => {
    const lifecycleSession = await get(lifecycleSession$);
    if (lifecycleSession?.status !== "active") {
      return null;
    }
    const response = await accept(
      get(apiClient$)(browserContract).viewerConnection({
        params: { threadId: descriptor.threadId },
      }),
      [200, 409],
    );
    return response.status === 200
      ? {
          cdpUrl: response.body.cdpUrl,
          extension: response.body.extension,
          liveUrl: lifecycleSession.liveUrl,
          instanceId: lifecycleSession.window?.instanceId ?? null,
          windowId: lifecycleSession.window?.primaryWindowId ?? null,
        }
      : null;
  });

  const browserConnection$ = computed(
    async (get): Promise<BrowserConnection | null> => {
      const connection = await get(viewerConnection$);
      return connection
        ? {
            cdpUrl: connection.cdpUrl,
            instanceId: connection.instanceId,
            windowId: connection.windowId,
            extension: connection.extension,
          }
        : null;
    },
  );
  const browser = createBrowserSignals(browserConnection$);
  const reload$ = command(({ set }) => {
    set(leaseOverride$, undefined);
    set(sessionOverride$, undefined);
    set(reloadVersion$, (version) => {
      return version + 1;
    });
    set(browser.connectionChanged$);
  });
  const mutationContext: BrowserMutationSignalContext = {
    descriptor,
    sessionOverride$,
    reload$,
    connectionChanged$: browser.connectionChanged$,
  };
  const startSignals = createStartBrowserSignals(mutationContext);
  const closeSignals = createCloseBrowserSignals(mutationContext);
  const subscriptionSignals = createBrowserSessionSubscriptionSignals(
    descriptor,
    session$,
    reload$,
  );

  const keepAliveSignals = createBrowserSessionKeepAliveSignals(
    descriptor,
    session$,
    leaseOverride$,
    reload$,
  );

  return {
    ...descriptor,
    screenshotImageLoad,
    session$,
    panelSession$: session$,
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
  session: BrowserSession,
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
