import {
  BROWSER_IDLE_LEASE_MINUTES,
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { browserSessionChangedPayloadSchema } from "@okouai/api-contracts/contracts/realtime";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { WindowSizeSync } from "cdp-viewer";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";

import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { formatAppNumber } from "../../i18n/format.ts";
import { i18n } from "../../i18n/index.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
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
  /**
   * The Run the member stopped to take over this browser. Control returns to
   * the agent as soon as a newer Run starts.
   */
  readonly takeoverRunId$: Computed<string | null>;
  readonly setTakeoverRunId$: Command<void, [string | null]>;
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
): Pick<BrowserSessionSignals, "fitViewport$"> {
  const resize$ = command(
    async (
      { get, set },
      aspectRatio: number,
      signal: AbortSignal,
    ): Promise<void> => {
      const fitted = await accept(
        get(apiClient$)(browserContract).resizeByThread({
          params: { threadId: descriptor.threadId },
          body: { aspectRatio },
          fetchOptions: { signal },
        }),
        [200, 404],
        signal,
      );
      signal.throwIfAborted();
      if (fitted.status === 200) {
        set(sessionOverride$, fitted.body.browser);
        set(browserFitDom.syncFitActionForScreen$, fitted.body.browser.screen);
      }
    },
  );
  const fitViewport$ = command(async ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const aspectRatio = set(browserFitDom.viewportAspectRatio$);
    if (aspectRatio !== null) {
      await set(resize$, aspectRatio, signal);
    }
  });
  return { fitViewport$ };
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
        options: { runOnSubscribe: false },
      },
      signal,
    );
  });
  return { subscribe$ };
}

function createTakeoverSignals(): Pick<
  BrowserSessionSignals,
  "takeoverRunId$" | "setTakeoverRunId$"
> {
  const internalTakeoverRunId$ = state<string | null>(null);
  const takeoverRunId$ = computed((get) => {
    return get(internalTakeoverRunId$);
  });
  const setTakeoverRunId$ = command(({ set }, runId: string | null) => {
    set(internalTakeoverRunId$, runId);
  });
  return { takeoverRunId$, setTakeoverRunId$ };
}

export function createBrowserSessionSignals(
  threadId: string,
): BrowserSessionSignals {
  const descriptor: BrowserSessionDescriptor = {
    threadId,
    href: `/browsers/${threadId}`,
  };
  const reloadVersion$ = state(0);
  const internalViewerWindowSizeSync$ = state<WindowSizeSync>("live");
  const viewerWindowSizeSync$ = computed((get) => {
    return get(internalViewerWindowSizeSync$);
  });
  const setViewerWindowSizeSync$ = command(({ set }, mode: WindowSizeSync) => {
    set(internalViewerWindowSizeSync$, mode);
  });
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

  const viewerConnection$ = computed(async (get) => {
    if (!get(featureSwitch$)[FeatureSwitchKey.BrowserCdpViewer]) {
      return null;
    }
    const session = await get(session$);
    if (session?.status !== "active" || !session.liveUrl) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(browserContract).viewerConnection({
        params: { threadId: descriptor.threadId },
      }),
      [200, 409],
    );
    return response.status === 200
      ? { cdpUrl: response.body.cdpUrl, liveUrl: session.liveUrl }
      : null;
  });

  const browserFitDom = createBrowserFitDomSignals();
  const { fitViewport$ } = createFitWindowSignals(
    descriptor,
    sessionOverride$,
    browserFitDom,
  );
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
    viewerConnection$,
    viewerWindowSizeSync$,
    setViewerWindowSizeSync$,
    ...createTakeoverSignals(),
    ...startSignals,
    ...closeSignals,
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
