import {
  BROWSER_IDLE_LEASE_MINUTES,
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { browserSessionChangedPayloadSchema } from "@okouai/api-contracts/contracts/realtime";
import type { ViewerCaptureOptions, WindowSizeSync } from "cdp-viewer";
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
      readonly liveUrl: string;
      readonly cdpUrl: string;
    } | null>
  >;
  readonly viewerWindowSizeSync$: Computed<WindowSizeSync>;
  readonly setViewerWindowSizeSync$: Command<void, [WindowSizeSync]>;
  readonly viewerCapture$: Computed<ViewerCaptureOptions>;
  readonly setViewerCapture$: Command<void, [ViewerCaptureOptions]>;
  readonly reload$: Command<void, []>;
  readonly reloadPanel$: Command<void, []>;
  readonly start$: Command<Promise<void>, [AbortSignal]>;
  readonly close$: Command<Promise<void>, [AbortSignal]>;
  readonly subscribe$: Command<void, [AbortSignal]>;
  // Attach to the visible panel container: the lease heartbeat lives exactly as
  // long as that element is mounted.
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

function activeBrowserLiveUrl(session: BrowserSession | null): string | null {
  return session?.status === "active" && session.liveUrl
    ? session.liveUrl
    : null;
}

interface BrowserMutationSignalContext {
  readonly descriptor: BrowserSessionDescriptor;
  readonly sessionOverride$: State<BrowserSession | null | undefined>;
  readonly reload$: Command<void, []>;
}

function createStartBrowserSignals({
  descriptor,
  sessionOverride$,
  reload$,
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

function createViewerSettingsSignals(): Pick<
  BrowserSessionSignals,
  | "viewerWindowSizeSync$"
  | "setViewerWindowSizeSync$"
  | "viewerCapture$"
  | "setViewerCapture$"
> {
  const internalViewerWindowSizeSync$ = state<WindowSizeSync>("live");
  const viewerWindowSizeSync$ = computed((get) => {
    return get(internalViewerWindowSizeSync$);
  });
  const setViewerWindowSizeSync$ = command(({ set }, mode: WindowSizeSync) => {
    set(internalViewerWindowSizeSync$, mode);
  });
  const internalViewerCapture$ = state<ViewerCaptureOptions>({
    format: "webp",
  });
  const viewerCapture$ = computed((get) => {
    return get(internalViewerCapture$);
  });
  const setViewerCapture$ = command(
    ({ set }, capture: ViewerCaptureOptions) => {
      set(internalViewerCapture$, capture);
    },
  );
  return {
    viewerWindowSizeSync$,
    setViewerWindowSizeSync$,
    viewerCapture$,
    setViewerCapture$,
  };
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
  const session$ = computed(async (get): Promise<BrowserSession | null> => {
    get(reloadVersion$);
    const override = get(sessionOverride$);
    return override === undefined
      ? await fetchBrowserSession(get(apiClient$), descriptor.threadId)
      : override;
  });
  const reload$ = command(({ set }) => {
    set(sessionOverride$, undefined);
    set(reloadVersion$, (version) => {
      return version + 1;
    });
  });

  // Lease responses publish fresh session data without changing the provider.
  // Keep the resolved identity synchronous so equal URLs suppress refetches.
  const fetchedViewerLiveUrl$ = computed(async (get) => {
    return activeBrowserLiveUrl(await get(session$));
  });
  const viewerLiveUrl$ = computed((get) => {
    const override = get(sessionOverride$);
    return override === undefined
      ? get(fetchedViewerLiveUrl$)
      : activeBrowserLiveUrl(override);
  });
  const viewerConnection$ = computed(async (get) => {
    const liveUrl = await get(viewerLiveUrl$);
    if (!liveUrl) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(browserContract).viewerConnection({
        params: { threadId: descriptor.threadId },
      }),
      [200, 409],
    );
    return response.status === 200
      ? { cdpUrl: response.body.cdpUrl, liveUrl }
      : null;
  });

  const mutationContext: BrowserMutationSignalContext = {
    descriptor,
    sessionOverride$,
    reload$,
  };
  const startSignals = createStartBrowserSignals(mutationContext);
  const closeSignals = createCloseBrowserSignals(mutationContext);
  const subscriptionSignals = createBrowserSessionSubscriptionSignals(
    descriptor,
    session$,
    reload$,
  );

  const keepAliveRef$ = onRef(
    command(({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
      setLoop(
        async () => {
          const response = await accept(
            get(apiClient$)(browserContract).leaseByThread({
              params: { threadId: descriptor.threadId },
              body: {},
              fetchOptions: { signal },
            }),
            [200, 404, 409],
          );
          if (response.status === 200) {
            const currentSession = await get(session$);
            signal.throwIfAborted();
            set(
              sessionOverride$,
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
          // The browser was reclaimed. Stop the heartbeat and let the panel
          // offer a resume instead.
          set(reload$);
          return true;
        },
        LEASE_HEARTBEAT_INTERVAL_MS,
        signal,
      );
    }),
  );

  return {
    ...descriptor,
    screenshotImageLoad,
    session$,
    panelSession$: session$,
    viewerConnection$,
    ...createViewerSettingsSignals(),
    ...startSignals,
    ...closeSignals,
    reload$,
    reloadPanel$: reload$,
    ...subscriptionSignals,
    keepAliveRef$,
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
