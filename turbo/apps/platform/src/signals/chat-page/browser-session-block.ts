import {
  BROWSER_IDLE_LEASE_MINUTES,
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { browserSessionChangedPayloadSchema } from "@okouai/api-contracts/contracts/realtime";
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
import { onRef, settle, setLoop, withCleanup } from "../utils.ts";
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
  readonly starting$: Computed<boolean>;
  readonly fittingWindow$: Computed<boolean>;
  readonly reload$: Command<void, []>;
  readonly reloadPanel$: Command<void, []>;
  readonly start$: Command<Promise<void>, [AbortSignal]>;
  readonly close$: Command<Promise<void>, [AbortSignal]>;
  readonly fitViewport$: Command<Promise<void>, [AbortSignal]>;
  readonly syncFitActionVisibility$: Command<void, []>;
  readonly subscribe$: Command<void, [AbortSignal]>;
  readonly fitViewportRef$: Command<
    (() => void) | undefined,
    [HTMLDivElement | null]
  >;
  // Attach to the visible panel container: the lease heartbeat lives exactly as
  // long as that element is mounted.
  readonly keepAliveRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}

export interface BrowserLifecycleOptimisticEvents {
  readonly append$: Command<
    Promise<void>,
    [
      {
        readonly eventId: string;
        readonly eventType: "browser.open" | "browser.close";
      },
      AbortSignal,
    ]
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

const BROWSER_FIT_GAP_TOLERANCE_PX = 2;

interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

interface BrowserFitDomSignals extends Pick<
  BrowserSessionSignals,
  "fitViewportRef$" | "syncFitActionVisibility$"
> {
  readonly syncFitActionForScreen$: Command<void, [BrowserSession["screen"]]>;
  readonly viewportAspectRatio$: Command<number | null, []>;
}

function measuredViewport(element: HTMLElement | null): ViewportSize | null {
  if (!element) {
    return null;
  }
  const { width, height } = element.getBoundingClientRect();
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { width, height };
}

function browserFrameNeedsFit(
  viewport: ViewportSize | null,
  browserAspectRatio: number,
): boolean {
  if (
    !viewport ||
    !Number.isFinite(browserAspectRatio) ||
    browserAspectRatio <= 0
  ) {
    return false;
  }
  const fittedWidth = Math.min(
    viewport.width,
    viewport.height * browserAspectRatio,
  );
  const fittedHeight = Math.min(
    viewport.height,
    viewport.width / browserAspectRatio,
  );
  return (
    viewport.width - fittedWidth > BROWSER_FIT_GAP_TOLERANCE_PX ||
    viewport.height - fittedHeight > BROWSER_FIT_GAP_TOLERANCE_PX
  );
}

function createBrowserFitDomSignals(): BrowserFitDomSignals {
  const runtime: { viewport: HTMLDivElement | null } = { viewport: null };
  const fitAction = (): HTMLElement | null => {
    return (
      runtime.viewport?.querySelector("[data-browser-session-fit-action]") ??
      null
    );
  };
  const updateFitActionVisibility = (
    browserAspectRatio: number,
    canFitWindow: boolean,
  ): void => {
    const action = fitAction();
    if (!action) {
      return;
    }
    action.hidden = !(
      canFitWindow &&
      browserFrameNeedsFit(
        measuredViewport(runtime.viewport),
        browserAspectRatio,
      )
    );
  };
  const syncFitActionVisibility$ = command(() => {
    const viewport = runtime.viewport;
    const browserAspectRatio = Number(
      viewport?.dataset.browserAspectRatio ?? "",
    );
    const canFitWindow = viewport?.dataset.canFitWindow === "true";
    updateFitActionVisibility(browserAspectRatio, canFitWindow);
  });
  const syncFitActionForScreen$ = command(
    (_, screen: BrowserSession["screen"]): void => {
      updateFitActionVisibility(
        screen ? screen.width / screen.height : Number.NaN,
        screen?.resizable === true,
      );
    },
  );
  const viewportAspectRatio$ = command((): number | null => {
    const size = measuredViewport(runtime.viewport);
    return size ? size.width / size.height : null;
  });
  const fitViewportRef$ = onRef(
    command(({ set }, viewport: HTMLDivElement, signal: AbortSignal): void => {
      runtime.viewport = viewport;
      const syncFitActionVisibility = () => {
        set(syncFitActionVisibility$);
      };
      const win = viewport.ownerDocument.defaultView;
      win?.addEventListener("resize", syncFitActionVisibility);
      signal.addEventListener(
        "abort",
        () => {
          win?.removeEventListener("resize", syncFitActionVisibility);
          if (runtime.viewport === viewport) {
            runtime.viewport = null;
          }
        },
        { once: true },
      );
      set(syncFitActionVisibility$);
    }),
  );
  return {
    fitViewportRef$,
    syncFitActionForScreen$,
    syncFitActionVisibility$,
    viewportAspectRatio$,
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

function createFitWindowSignals(
  descriptor: BrowserSessionDescriptor,
  sessionOverride$: State<BrowserSession | null | undefined>,
  browserFitDom: BrowserFitDomSignals,
): Pick<BrowserSessionSignals, "fittingWindow$" | "fitViewport$"> {
  const fittingWindowState$ = state(false);
  const fitViewport$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (get(fittingWindowState$)) {
        return;
      }
      const aspectRatio = set(browserFitDom.viewportAspectRatio$);
      if (aspectRatio === null) {
        return;
      }
      set(fittingWindowState$, true);
      const fitted = await settle(
        withCleanup(
          accept(
            get(apiClient$)(browserContract).resizeByThread({
              params: { threadId: descriptor.threadId },
              body: { aspectRatio },
              fetchOptions: { signal },
            }),
            [200, 404],
            signal,
          ),
          () => {
            set(fittingWindowState$, false);
          },
        ),
        signal,
      );
      if (fitted.ok && fitted.value.status === 200) {
        set(sessionOverride$, fitted.value.body.browser);
        set(
          browserFitDom.syncFitActionForScreen$,
          fitted.value.body.browser.screen,
        );
      }
    },
  );
  return {
    fittingWindow$: computed((get) => {
      return get(fittingWindowState$);
    }),
    fitViewport$,
  };
}

interface BrowserMutationSignalContext {
  readonly descriptor: BrowserSessionDescriptor;
  readonly sessionOverride$: State<BrowserSession | null | undefined>;
  readonly reload$: Command<void, []>;
  readonly optimisticEvents?: BrowserLifecycleOptimisticEvents;
}

function createStartBrowserSignals({
  descriptor,
  sessionOverride$,
  reload$,
  optimisticEvents,
}: BrowserMutationSignalContext): Pick<
  BrowserSessionSignals,
  "starting$" | "start$"
> {
  const startingState$ = state(false);
  const start$ = command(async ({ get, set }, signal: AbortSignal) => {
    const eventId = crypto.randomUUID();
    set(startingState$, true);
    if (optimisticEvents) {
      await set(
        optimisticEvents.append$,
        {
          eventId,
          eventType: "browser.open",
        },
        signal,
      );
      signal.throwIfAborted();
    }
    const started = await settle(
      accept(
        get(apiClient$)(browserContract).open({
          params: { threadId: descriptor.threadId },
          body: { eventId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      ),
      signal,
    );
    set(startingState$, false);
    if (started.ok) {
      set(sessionOverride$, started.value.body.browser);
      return;
    }
    set(reload$);
  });
  return {
    starting$: computed((get) => {
      return get(startingState$);
    }),
    start$,
  };
}

function createCloseBrowserSignals({
  descriptor,
  optimisticEvents,
}: BrowserMutationSignalContext): Pick<BrowserSessionSignals, "close$"> {
  const close$ = command(async ({ get, set }, signal: AbortSignal) => {
    const eventId = crypto.randomUUID();
    if (optimisticEvents) {
      await set(
        optimisticEvents.append$,
        {
          eventId,
          eventType: "browser.close",
        },
        signal,
      );
      signal.throwIfAborted();
    }
    await settle(
      accept(
        get(apiClient$)(browserContract).close({
          params: { threadId: descriptor.threadId },
          body: { eventId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      ),
      signal,
    );
  });
  return { close$ };
}

function createBrowserSessionSubscriptionSignals(
  descriptor: BrowserSessionDescriptor,
  session$: BrowserSessionSignals["session$"],
  reload$: BrowserSessionSignals["reload$"],
  browserFitDom: BrowserFitDomSignals,
): Pick<BrowserSessionSignals, "subscribe$"> {
  const reloadBrowserSession$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      set(reload$);
      const session = await get(session$);
      signal.throwIfAborted();
      set(browserFitDom.syncFitActionForScreen$, session?.screen);
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
      },
      signal,
    );
  });
  return { subscribe$ };
}

export function createBrowserSessionSignals(
  threadId: string,
  optimisticEvents?: BrowserLifecycleOptimisticEvents,
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

  const browserFitDom = createBrowserFitDomSignals();
  const { fittingWindow$, fitViewport$ } = createFitWindowSignals(
    descriptor,
    sessionOverride$,
    browserFitDom,
  );
  const mutationContext: BrowserMutationSignalContext = {
    descriptor,
    sessionOverride$,
    reload$,
    ...(optimisticEvents ? { optimisticEvents } : {}),
  };
  const startSignals = createStartBrowserSignals(mutationContext);
  const closeSignals = createCloseBrowserSignals(mutationContext);
  const subscriptionSignals = createBrowserSessionSubscriptionSignals(
    descriptor,
    session$,
    reload$,
    browserFitDom,
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
    ...startSignals,
    ...closeSignals,
    fittingWindow$,
    reload$,
    reloadPanel$: reload$,
    fitViewport$,
    fitViewportRef$: browserFitDom.fitViewportRef$,
    syncFitActionVisibility$: browserFitDom.syncFitActionVisibility$,
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
