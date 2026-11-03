import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { timeout } from "signal-timers";
import {
  createDeferredPromise,
  detach,
  isAbortError,
  Reason,
  resetSignal,
} from "../../utils.ts";
import {
  createCdpClient,
  type CdpClient,
  type CdpEvent,
} from "../cdp/client.ts";
import { CdpFault, isRecord, validateConfiguration } from "../cdp/errors.ts";
import {
  captureSentryLogError,
  sentryLogContext,
} from "../../../lib/sentry-config.ts";
import { diagnostic } from "./diagnostic.ts";
import {
  createTargetDirectory,
  pageTarget,
  type TargetDirectory,
} from "../cdp/targets.ts";
import { CreatedTabFault, createTabCreation } from "../cdp/tabs.ts";
import {
  changesMembership,
  connectNative,
  nativeFault,
} from "../cdp/native.ts";
import type {
  OkouBrowserClient,
  NativeEvent,
} from "@okouai/browser-extension-client";
import { createInputSession } from "../input/session.ts";
import type { NativeInputHost } from "../input/port.ts";
import { createNavigationData } from "../navigation/data.ts";
import type { InputStop } from "../input/lifecycle.ts";
import {
  positive,
  type DisplaySize,
  type Viewport,
} from "../display/geometry.ts";
import { createDisplayViewport } from "../display/viewport.ts";
import {
  createDisplaySync,
  type DisplayModeResult,
  type DisplayState,
} from "../display/sync.ts";
import { captureBoundary } from "../display/capture-boundary.ts";
import { createCanvasRenderer, type FrameSink } from "../render/canvas.ts";
import type { ViewerSignals } from "./model.ts";
import type { ViewerIntent } from "./lifecycle.ts";
import type {
  BrowserConnection,
  NavigationAction,
  NavigationReceipt,
  ViewerHistory,
  ViewerNavigation,
  ViewerCaptureOptions,
  ViewerError,
  WindowSizeSync,
} from "./types.ts";
import {
  captureSettings,
  capturePreferences,
  sameCaptureSettings,
  type CaptureSettings,
} from "./capture.ts";
import { createScreencast } from "./screencast.ts";
import { createTargetDiscovery } from "./discovery.ts";
import { readFavicon } from "./favicon.ts";
import {
  createSelectionLifecycle,
  type AttachedSelection,
  type SelectionOwner,
  type SelectionOutcome,
} from "./selection.ts";
interface FaviconDocument {
  readonly wanted: boolean;
  readonly waiting: boolean;
  readonly ready: boolean;
}
interface RetirementReceipts {
  readonly input: PromiseSettledResult<void>;
  readonly capture: PromiseSettledResult<void>;
  readonly display?: PromiseSettledResult<void>;
}
interface Retirement {
  readonly owner: object;
  readonly session: SelectedSession;
  /** Original evidence; native capture closure is reconciled when consumed. */
  readonly receipts: RetirementReceipts | null;
}
interface CaptureChange {
  readonly settings: CaptureSettings;
  readonly first: number;
  readonly last: number;
}
function cancelled(): DOMException {
  return new DOMException("The browser operation was cancelled.", "AbortError");
}

/** Native draw ownership, not business state. Late old cleanup cannot clear a replacement. */
function createFrameLease(root: FrameSink) {
  let active = true;
  const sink: FrameSink = {
    push(data, painted, failed, accept) {
      if (!active) {
        return;
      }
      root.push(
        data,
        (raster) => {
          if (active) {
            painted(raster);
          }
        },
        (error) => {
          if (active) {
            failed(error);
          }
        },
        (raster) => {
          return active && (accept?.(raster) ?? true);
        },
      );
    },
    invalidate() {
      if (active) {
        root.invalidate();
      }
    },
    reset() {
      if (active) {
        root.reset();
      }
    },
    dispose() {
      if (active) {
        root.invalidate();
      }
      active = false;
    },
  };
  return {
    sink,
    current() {
      return active;
    },
    retire() {
      if (active) {
        root.invalidate();
      }
      active = false;
    },
  };
}

/** Constructed only by the immutable attached-session identity computed. */
function createSelectedSession(
  attached: AttachedSelection,
  current$: Computed<boolean>,
  host: {
    readonly sink: FrameSink;
    readonly directory: TargetDirectory;
    readonly nativeHost: NativeInputHost;
    readonly settings$: Computed<CaptureSettings>;
    readonly failed$: Command<
      Promise<void>,
      [SelectionOwner, unknown, AbortSignal]
    >;
    readonly started$: Command<
      void,
      [SelectionOwner, CaptureSettings, AbortSignal]
    >;
  },
) {
  const { sink, directory, nativeHost, settings$, failed$, started$ } = host;
  const frameLease = createFrameLease(sink);
  const geometry = createDisplayViewport();
  const navigation = createNavigationData(
    attached.client,
    attached.sessionId,
    current$,
  );
  const input = createInputSession(
    attached,
    current$,
    geometry,
    nativeHost,
    navigation,
  );
  const painted$ = state(false);
  const inputReady$ = state(false);
  const failure$ = state<unknown>(null);
  const favicon$ = state<FaviconDocument>({
    wanted: true,
    waiting: false,
    ready: false,
  });
  const captureFailed$ = command(
    async ({ set }, error: unknown, signal: AbortSignal): Promise<void> => {
      await set(failed$, attached.owner, error, signal);
    },
  );
  const captureStarted$ = command(
    ({ set }, settings: CaptureSettings, signal: AbortSignal) => {
      signal.throwIfAborted();
      set(geometry.setCapture$, {
        width: settings.maxWidth,
        height: settings.maxHeight,
      });
      set(started$, attached.owner, settings, signal);
    },
  );
  const stream = createScreencast(
    {
      client: attached.frames,
      sessionId: attached.frameSessionId,
      sink: frameLease.sink,
      current$,
      failed$: captureFailed$,
      starting$: captureStarted$,
    },
    attached.settings,
  );
  const prepareRetry$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (!get(current$)) {
        throw cancelled();
      }
      await set(directory.assertMember$, attached.owner.targetId, signal);
      signal.throwIfAborted();
      if (!get(current$)) {
        throw cancelled();
      }
      const boundary = await captureBoundary(
        attached.client,
        attached.sessionId,
        frameLease.current,
      );
      signal.throwIfAborted();
      if (boundary === null || !get(current$)) {
        throw cancelled();
      }
      await set(directory.assertMember$, attached.owner.targetId, signal);
      signal.throwIfAborted();
      if (!get(current$)) {
        throw cancelled();
      }
      set(geometry.fence$, boundary);
      set(geometry.resumePresentation$);
    },
  );
  const { refresh$ } = createSessionRefreshGraph({
    attached,
    current$,
    settings$,
    stream,
    captureFailed$,
  });
  return {
    attached,
    current$,
    geometry,
    input,
    navigation,
    stream,
    frameLease,
    painted$,
    inputReady$,
    failure$,
    favicon$,
    prepareRetry$,
    refresh$,
  };
}
type SelectedSession = ReturnType<typeof createSelectedSession>;

interface SessionRefreshNodes {
  readonly attached: AttachedSelection;
  readonly current$: Computed<boolean>;
  readonly settings$: Computed<CaptureSettings>;
  readonly stream: ReturnType<typeof createScreencast>;
  readonly captureFailed$: Command<Promise<void>, [unknown, AbortSignal]>;
}
type RefreshIntent = { readonly prepare$: Command<Promise<void>, []> };

function createSessionRestart(
  nodes: SessionRefreshNodes,
  refreshIntent$: State<RefreshIntent | null>,
) {
  const { attached, current$, settings$, stream, captureFailed$ } = nodes;
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const intent = get(refreshIntent$);
    if (!intent || !get(current$)) {
      throw cancelled();
    }
    const progress: { phase: "stopping" | "stopped" | "starting" } = {
      phase: "stopping",
    };
    const [result] = await Promise.allSettled([
      (async () => {
        await set(stream.stop$, signal);
        progress.phase = "stopped";
        signal.throwIfAborted();
        if (!get(current$)) {
          throw cancelled();
        }
        await set(intent.prepare$);
        signal.throwIfAborted();
        if (!get(current$)) {
          throw cancelled();
        }
        progress.phase = "starting";
        await set(stream.begin$, get(settings$), signal);
      })(),
    ]);
    signal.throwIfAborted();
    if (result.status === "fulfilled") {
      return;
    }
    const error: unknown = result.reason;
    if (get(current$) && !signal.aborted) {
      if (
        progress.phase === "stopping" &&
        error instanceof CdpFault &&
        error.code !== undefined
      ) {
        set(stream.resume$, signal);
      } else {
        const [restored] = await Promise.allSettled([
          (async () => {
            if (progress.phase !== "stopped") {
              await set(stream.stop$, attached.frames.signal);
            }
            if (!get(current$)) {
              throw cancelled();
            }
            await set(stream.begin$, get(settings$), signal);
          })(),
        ]);
        signal.throwIfAborted();
        if (restored.status === "rejected" && get(current$)) {
          await set(captureFailed$, restored.reason, signal);
        }
      }
    }
    throw error;
  });
}

function createSessionRefreshGraph(nodes: SessionRefreshNodes) {
  const { current$, stream } = nodes;
  const refreshIntent$ = state<RefreshIntent | null>(null);
  const restartExclusive$ = createSessionRestart(nodes, refreshIntent$);
  const refresh$ = command(
    async (
      { get, set },
      prepare$: Command<Promise<void>, []>,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (get(refreshIntent$)) {
        throw new CdpFault(
          "display",
          "Capture preparation is already in progress.",
        );
      }
      const intent = { prepare$ };
      set(refreshIntent$, intent);
      using _intent = {
        [Symbol.dispose]: () => {
          if (get(refreshIntent$) === intent) {
            set(refreshIntent$, null);
          }
        },
      };
      await set(stream.exclusive$, restartExclusive$, signal);
      signal.throwIfAborted();
      if (!get(current$)) {
        throw cancelled();
      }
    },
  );
  return { refresh$ };
}

interface ControllerLinks {
  readonly discoveryFailed$: Command<void, [unknown, AbortSignal]>;
  readonly nativeEvent$: Command<void, [NativeEvent]>;
  readonly beginClosing$: Command<void, []>;
  readonly waitForClosed$: Command<Promise<void>, [AbortSignal]>;
  readonly discoveryChanged$: Command<void, [AbortSignal]>;
  readonly discovery$: Computed<ReturnType<
    typeof createTargetDiscovery
  > | null>;
  readonly captureFailed$: Command<
    Promise<void>,
    [SelectionOwner, unknown, AbortSignal]
  >;
  readonly captureStarted$: Command<
    void,
    [SelectionOwner, CaptureSettings, AbortSignal]
  >;
  readonly selectedSession$: Computed<SelectedSession | null>;
  readonly refreshCapture$: Command<
    Promise<void>,
    [Command<Promise<void>, []>, AbortSignal]
  >;
  readonly displaySettled$: Command<void, []>;
  readonly displayRecovery$: Computed<ViewerError | null>;
  readonly displayGraph$: Computed<ReturnType<typeof createDisplaySync> | null>;
  readonly display$: Computed<DisplayState>;
  readonly input$: Computed<ReturnType<typeof createInputSession> | null>;
  readonly canCreate$: Computed<boolean>;
  readonly navigation$: Computed<ViewerNavigation | null>;
  readonly history$: Computed<Promise<ViewerHistory | null>>;
  readonly navigationScope$: Computed<object | null>;
  readonly cancelCapture$: Command<void, []>;
  readonly configureCapture$: Command<Promise<void>, [AbortSignal]>;
  readonly scheduleCapture$: Command<void, []>;
  readonly waitRetirement$: Command<Promise<void>, [string, AbortSignal]>;
  readonly reconcileRetirement$: Command<
    PromiseSettledResult<void> | null,
    [Retirement, RetirementReceipts?]
  >;
  readonly detachAttached$: Command<void, [AttachedSelection]>;
  readonly finishRetirement$: Command<
    Promise<void>,
    [SelectedSession, Retirement, InputStop, AbortSignal]
  >;
  readonly retireCurrent$: Command<void, [InputStop, boolean, boolean?]>;
  readonly streaming$: Command<void, [SelectedSession]>;
  readonly waitReady$: Command<Promise<void>, [SelectionOwner, AbortSignal]>;
  readonly waitSelection$: Command<
    Promise<SelectionOutcome>,
    [SelectionOwner, AbortSignal]
  >;
  readonly attach$: Command<Promise<void>, [SelectionOwner, AbortSignal]>;
  readonly selectTab$: Command<Promise<void>, [string, AbortSignal]>;
  readonly select$: Command<Promise<SelectionOutcome>, [string, AbortSignal]>;
  readonly revalidateSelection$: Command<void, [SelectionOwner]>;
  readonly refreshFavicon$: Command<
    Promise<void>,
    [SelectedSession, AbortSignal]
  >;
  readonly event$: Command<Promise<void>, [CdpEvent, CdpClient, AbortSignal]>;
  readonly followActiveTarget$: Command<Promise<void>, [string, AbortSignal]>;
  readonly disconnected$: Command<void, [CdpFault, CdpClient]>;
  readonly createFrames$: Command<CdpClient, []>;
  readonly ensureFrames$: Command<Promise<CdpClient>, [AbortSignal]>;
  readonly start$: Command<Promise<void>, [AbortSignal]>;
  readonly cancelCreation$: Command<void, [object]>;
  readonly createTab$: Command<Promise<string>, [AbortSignal]>;
  readonly creatingTab$: Computed<boolean>;
  readonly closeTab$: Command<Promise<void>, [string, AbortSignal]>;
  readonly navigate$: Command<
    Promise<NavigationReceipt>,
    [NavigationAction, AbortSignal]
  >;
  readonly retryStartingGraph$: Computed<{
    readonly selected: SelectedSession;
    readonly owner: object;
    readonly starting$: Command<void, []>;
  } | null>;
  readonly retryImage$: Command<Promise<void>, [AbortSignal]>;
  readonly changeCapture$: Command<
    Promise<void>,
    [ViewerCaptureOptions, AbortSignal]
  >;
  readonly changeWindowSizeSync$: Command<
    Promise<DisplayModeResult>,
    [WindowSizeSync, AbortSignal]
  >;
  readonly measure$: Command<void, [DisplaySize | null]>;
  readonly syncDisplay$: Command<Promise<void>, [AbortSignal]>;
  readonly restoreSelection$: Command<Promise<void>, [AbortSignal]>;
  readonly reconcileSelection$: Command<
    Promise<SelectionOutcome>,
    [AbortSignal]
  >;
  readonly pause$: Command<Promise<void>, [boolean, AbortSignal]>;
  readonly revokeAuthority$: Command<void, []>;
  readonly refreshAuthority$: Command<Promise<void>, [AbortSignal]>;
  readonly rejectFavicon$: Command<void, [string, string]>;
  readonly dispose$: Command<void, []>;
}

function createControllerAtoms(canvas: HTMLCanvasElement) {
  const resetOwner$ = resetSignal();
  const resetSelection$ = resetSignal();
  const resetCreate$ = resetSignal();
  const sink = createCanvasRenderer(canvas);
  const clientState$ = state<CdpClient | null>(null);
  const nativeState$ = state<OkouBrowserClient | null>(null);
  const closingState$ = state(false);
  const disconnectingState$ = state(false);
  const closedState$ = state<PromiseSettledResult<void> | null>(null);
  const framesState$ = state<CdpClient | null>(null);
  const connectedState$ = state(false);
  const disposedState$ = state(false);
  const startedState$ = state(false);
  const bootstrapping$ = state(true);
  const chosenOnce$ = state(false);
  const selection = createSelectionLifecycle();
  const crashedSelection$ = state<{
    readonly owner: SelectionOwner;
    readonly intent: object;
  } | null>(null);
  const retirements$ = state<ReadonlyMap<string, Retirement>>(new Map());
  const wakeListeners$ = state<ReadonlySet<() => void>>(new Set());
  const displaySize$ = state<DisplaySize | null>(null);
  const captureSize$ = state<DisplaySize | null>(null);
  const captureStartedState$ = state<CaptureSettings | null>(null);
  const captureUpdated$ = state(-Infinity);
  const captureChange$ = state<CaptureChange | null>(null);
  const captureScheduled$ = state(false);
  const faviconPending$ = state<object | null>(null);
  const faviconAvailable$ = state(true);
  const targetRevision$ = state(0);
  const extensionRevision$ = state(0);
  const readinessFailure$ = state<unknown>(null);
  const authorityRevoked$ = state(false);
  const closingTargets$ = state<ReadonlySet<string>>(new Set());
  const creationOwner$ = state<object | null>(null);
  return {
    resetOwner$,
    resetSelection$,
    resetCreate$,
    sink,
    clientState$,
    nativeState$,
    closingState$,
    disconnectingState$,
    closedState$,
    framesState$,
    connectedState$,
    disposedState$,
    startedState$,
    bootstrapping$,
    chosenOnce$,
    selection,
    crashedSelection$,
    selectedOwner$: selection.owner$,
    attachedState$: selection.attachment$,
    retirements$,
    wakeListeners$,
    displaySize$,
    captureSize$,
    captureStartedState$,
    captureUpdated$,
    captureChange$,
    captureScheduled$,
    faviconPending$,
    faviconAvailable$,
    targetRevision$,
    extensionRevision$,
    readinessFailure$,
    authorityRevoked$,
    closingTargets$,
    creationOwner$,
  };
}

function createControllerState(
  model: ViewerSignals,
  connection: BrowserConnection,
  canvas: HTMLCanvasElement,
  authority$: Computed<boolean>,
  nativeHost: NativeInputHost,
) {
  const atoms = createControllerAtoms(canvas);
  const {
    clientState$,
    connectedState$,
    disposedState$,
    captureSize$,
    captureStartedState$,
    wakeListeners$,
  } = atoms;
  const connected$ = computed((get) => {
    return get(connectedState$) && !get(disposedState$);
  });
  const available$ = computed((get) => {
    return get(connected$) && get(authority$) && !get(model.intent$).paused;
  });
  const crashed$ = computed((get) => {
    const crash = get(atoms.crashedSelection$);
    return crash &&
      get(model.selectedTabId$) === crash.owner.targetId &&
      get(model.intent$).selection === crash.intent
      ? crash
      : null;
  });
  const settings$ = computed((get) => {
    return captureSettings(get(model.capture$), get(captureSize$));
  });
  const capturePending$ = computed((get) => {
    const started = get(captureStartedState$);
    return !started || !sameCaptureSettings(started, get(settings$));
  });
  const wake$ = command(({ get, set }) => {
    const listeners = get(wakeListeners$);
    set(wakeListeners$, new Set());
    for (const listener of listeners) {
      listener();
    }
  });
  const waitEvent$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const event = createDeferredPromise<void>(signal);
      const listener = () => {
        if (!event.settled()) {
          event.resolve();
        }
      };
      set(wakeListeners$, new Set(get(wakeListeners$)).add(listener));
      using _listener = {
        [Symbol.dispose]: () => {
          const listeners = new Set(get(wakeListeners$));
          listeners.delete(listener);
          set(wakeListeners$, listeners);
        },
      };
      await event.promise;
      signal.throwIfAborted();
    },
  );
  const assertAvailable$ = command(({ get }, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(available$)) {
      throw cancelled();
    }
  });
  const directory$ = computed((get) => {
    const client = get(clientState$);
    const native = get(atoms.nativeState$);
    return client && native
      ? createTargetDirectory(client, connection.windowId, native)
      : null;
  });
  const creation$ = computed((get) => {
    const client = get(clientState$);
    const directory = get(directory$);
    const native = get(atoms.nativeState$);
    return client && directory && native
      ? createTabCreation(client, directory, {
          native,
          windowId: connection.windowId,
          current$: available$,
        })
      : null;
  });
  return {
    model,
    connection,
    authority$,
    nativeHost,
    ...atoms,
    connected$,
    available$,
    crashed$,
    settings$,
    capturePending$,
    wake$,
    waitEvent$,
    assertAvailable$,
    directory$,
    creation$,
  };
}
type ControllerContext = ReturnType<typeof createControllerState>;

function createDiscoveryGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<
  ControllerLinks,
  "discoveryFailed$" | "discoveryChanged$" | "discovery$"
> {
  const {
    model,
    bootstrapping$,
    chosenOnce$,
    readinessFailure$,
    closingTargets$,
    connected$,
    available$,
    wake$,
    directory$,
    nativeHost,
  } = context;
  const discoveryFailed$ = command(
    ({ get, set }, error: unknown, signal: AbortSignal): void => {
      if (signal.aborted || !get(connected$)) {
        return;
      }
      set(readinessFailure$, error);
      set(context.connectedState$, false);
      set(model.setConnected$, false);
      set(get(links$).retireCurrent$, "target-replaced", false);
      set(model.transition$, {
        type: "discovery-failed",
        error: diagnostic(error),
      });
      set(wake$);
      set(get(links$).beginClosing$);
    },
  );
  const discoveryChanged$ = command(
    ({ get, set }, signal: AbortSignal): void => {
      if (signal.aborted || !get(connected$)) {
        return;
      }
      const snapshot = get(model.snapshot$);
      let selected = snapshot.selectedTargetId;
      if (
        selected &&
        !snapshot.targets.some((target) => {
          return target.id === selected;
        }) &&
        !get(closingTargets$).has(selected)
      ) {
        set(get(links$).retireCurrent$, "target-replaced", false, true);
        set(model.transition$, {
          type: "target-lost",
          error: diagnostic(
            new CdpFault(
              "target-unavailable",
              "The selected target is no longer available in this scope.",
            ),
          ),
        });
        // Resume the existing initial-selection path after losing this selection.
        set(chosenOnce$, false);
        selected = null;
      }
      if (
        selected &&
        !get(get(links$).selectedSession$) &&
        !get(model.imageRecovery$) &&
        !get(context.crashed$) &&
        !get(context.creationOwner$) &&
        get(available$)
      ) {
        detach(
          set(get(links$).selectTab$, selected, signal),
          Reason.DomCallback,
          "browser revalidated selection",
        );
      } else if (
        !selected &&
        !get(context.creationOwner$) &&
        !get(chosenOnce$) &&
        !get(bootstrapping$) &&
        snapshot.targets[0] &&
        get(available$)
      ) {
        detach(
          set(get(links$).selectTab$, snapshot.targets[0].id, signal),
          Reason.DomCallback,
          "browser discovered selection",
        );
      } else if (
        !selected &&
        !snapshot.targets.length &&
        !get(context.creationOwner$)
      ) {
        set(model.transition$, { type: "target-lost", error: null });
      }
      set(nativeHost.synchronize$);
      set(wake$);
    },
  );
  const invalidated$ = command(({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(connected$)) {
      return;
    }
    set(get(links$).retireCurrent$, "target-replaced", true, true);
  });
  const discovery$ = computed((get) => {
    const directory = get(directory$);
    return directory
      ? createTargetDiscovery(
          directory,
          {
            inventoryState$: model.inventoryState$,
            snapshot$: model.snapshot$,
            intent$: model.intent$,
            inventory$: model.inventoryUpdate$,
          },
          {
            invalidated$,
            changed$: discoveryChanged$,
            failed$: discoveryFailed$,
          },
        )
      : null;
  });
  return { discoveryFailed$, discoveryChanged$, discovery$ };
}

function createCaptureRecoveryGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "captureFailed$"> {
  const { model, sink, retirements$, readinessFailure$, wake$, nativeHost } =
    context;
  const captureFailed$ = command(
    async (
      { get, set },
      owner: SelectionOwner,
      error: unknown,
      signal: AbortSignal,
    ): Promise<void> => {
      const selected = get(get(links$).selectedSession$);
      if (
        !selected ||
        selected.attached.owner !== owner ||
        selected.attached.frames !== get(context.framesState$) ||
        !get(selected.current$)
      ) {
        return;
      }
      const fault = diagnostic(error);
      const method = fault.request?.method;
      set(selected.failure$, error);
      if (
        fault.kind !== "frame" &&
        !(
          fault.kind === "protocol" &&
          (method === "Page.startScreencast" ||
            method === "Page.stopScreencast")
        )
      ) {
        set(readinessFailure$, error);
        set(get(links$).retireCurrent$, "target-replaced", false, true);
        set(model.transition$, { type: "failed", error: fault });
        set(wake$);
        return;
      }
      if (
        get(retirements$).size >= 512 &&
        !get(retirements$).has(owner.targetId)
      ) {
        selected.attached.client.close(
          new CdpFault("protocol", "Too many unconfirmed capture owners."),
        );
        return;
      }
      const recoveryOwner = {};
      const retirement: Retirement = {
        owner: recoveryOwner,
        session: selected,
        receipts: null,
      };
      set(
        retirements$,
        new Map(get(retirements$)).set(owner.targetId, retirement),
      );
      set(selected.stream.suspend$);
      set(selected.painted$, false);
      const display = get(get(links$).displayGraph$);
      if (display) {
        set(display.setSuspended$, true);
      }
      set(selected.geometry.suspendPresentation$);
      sink.reset();
      // A retained transition preview is not a live image after decode failure.
      set(model.transition$, { type: "stopped", retainFrame: true });
      set(model.transition$, {
        type: "image-failed",
        owner: recoveryOwner,
        targetId: owner.targetId,
        error: fault,
      });
      set(nativeHost.synchronize$);
      set(wake$);
      const [input, capture, displayReceipt] = await Promise.allSettled([
        set(selected.input.suspend$, selected.attached.client.signal),
        set(selected.stream.quiesce$, selected.attached.frames.signal),
        ...(display
          ? [set(display.waitForIdle$, selected.attached.client.signal)]
          : []),
      ]);
      signal.throwIfAborted();
      set(get(links$).reconcileRetirement$, retirement, {
        input,
        capture,
        display: displayReceipt,
      });
      signal.throwIfAborted();
    },
  );
  return { captureFailed$ };
}

function createSelectedSessionsGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "captureStarted$" | "selectedSession$"> {
  const {
    sink,
    selectedOwner$,
    attachedState$,
    captureStartedState$,
    captureUpdated$,
    available$,
    settings$,
    directory$,
    nativeHost,
  } = context;
  const captureStarted$ = command(
    (
      { get, set },
      owner: SelectionOwner,
      settings: CaptureSettings,
      signal: AbortSignal,
    ): void => {
      signal.throwIfAborted();
      if (get(selectedOwner$) !== owner) {
        return;
      }
      set(captureUpdated$, performance.now());
      set(captureStartedState$, settings);
      set(get(links$).scheduleCapture$);
    },
  );
  const selectedSession$: Computed<SelectedSession | null> = computed((get) => {
    const attached = get(attachedState$);
    const directory = get(directory$);
    if (!attached || !directory) {
      return null;
    }
    const current$ = computed((get) => {
      const discovery = get(get(links$).discovery$);
      return (
        get(available$) &&
        get(selectedOwner$) === attached.owner &&
        !!discovery &&
        get(discovery.ready$) &&
        get(discovery.selectedTargetId$) === attached.owner.targetId
      );
    });
    return createSelectedSession(attached, current$, {
      sink,
      directory,
      nativeHost,
      settings$,
      failed$: get(links$).captureFailed$,
      started$: captureStarted$,
    });
  });
  return { captureStarted$, selectedSession$ };
}

function createDisplayGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<
  ControllerLinks,
  | "refreshCapture$"
  | "displaySettled$"
  | "displayRecovery$"
  | "displayGraph$"
  | "display$"
  | "input$"
  | "canCreate$"
> {
  const {
    model,
    connection,
    clientState$,
    connected$,
    available$,
    capturePending$,
  } = context;
  const refreshCapture$ = command(
    async (
      { get, set },
      prepare$: Command<Promise<void>, []>,
      signal: AbortSignal,
    ): Promise<void> => {
      const selected = get(get(links$).selectedSession$);
      if (!selected || !get(selected.current$)) {
        throw cancelled();
      }
      await set(selected.refresh$, prepare$, signal);
      set(get(links$).scheduleCapture$);
    },
  );
  const displaySettled$ = command(({ get, set }) => {
    if (get(connected$)) {
      set(get(links$).scheduleCapture$);
    }
  });
  const displayGraph$ = computed((get) => {
    const client = get(clientState$);
    return client
      ? createDisplaySync(client, {
          windowId: connection.windowId ?? null,
          capturePending$,
          refresh$: refreshCapture$,
          settled$: displaySettled$,
        })
      : null;
  });
  const displayRecovery$ = computed((get): ViewerError | null => {
    const display = get(displayGraph$);
    const recovery = display && get(connected$) ? get(display.recovery$) : null;
    return recovery ? diagnostic(recovery.result.error) : null;
  });
  const display$ = computed((get): DisplayState => {
    const display = get(displayGraph$);
    return display
      ? get(display.state$)
      : { ready: false, pending: false, pointerBlocked: false };
  });
  const input$ = computed((get) => {
    const selected = get(get(links$).selectedSession$);
    const image = get(model.imageRecovery$);
    return selected &&
      get(selected.current$) &&
      get(selected.painted$) &&
      get(selected.inputReady$) &&
      get(selected.input.available$) &&
      (!image || image.phase === "presented")
      ? selected.input
      : null;
  });
  const canCreate$ = computed((get) => {
    if (!get(available$)) {
      return false;
    }
    if (get(input$) !== null) {
      return true;
    }
    const discovery = get(get(links$).discovery$);
    const snapshot = get(model.snapshot$);
    return (
      !!discovery &&
      get(discovery.ready$) &&
      snapshot.selectedTargetId === null &&
      snapshot.targets.length === 0
    );
  });
  return {
    refreshCapture$,
    displaySettled$,
    displayRecovery$,
    displayGraph$,
    display$,
    input$,
    canCreate$,
  };
}

function createCaptureGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<
  ControllerLinks,
  "cancelCapture$" | "configureCapture$" | "scheduleCapture$"
> {
  const {
    displaySize$,
    captureStartedState$,
    captureUpdated$,
    captureChange$,
    captureScheduled$,
    settings$,
    capturePending$,
    assertAvailable$,
    nativeHost,
  } = context;
  const resetCaptureDeadline$ = resetSignal();
  const cancelCapture$ = command(({ set }) => {
    set(resetCaptureDeadline$);
    set(captureScheduled$, false);
    set(captureChange$, null);
  });
  const configureCapture$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      set(assertAvailable$, signal);
      set(cancelCapture$);
      const selected = get(get(links$).selectedSession$);
      if (!selected || !get(selected.current$)) {
        throw cancelled();
      }
      if (!get(capturePending$)) {
        return;
      }
      const requested = get(settings$);
      set(selected.painted$, false);
      set(nativeHost.synchronize$);
      await set(selected.stream.configure$, requested, signal);
      signal.throwIfAborted();
      if (
        !get(selected.current$) ||
        !sameCaptureSettings(requested, get(settings$))
      ) {
        throw cancelled();
      }
      await set(get(links$).waitReady$, selected.attached.owner, signal);
      signal.throwIfAborted();
      if (!sameCaptureSettings(requested, get(settings$))) {
        throw cancelled();
      }
    },
  );
  const scheduleCapture$: Command<void, []> = command(({ get, set }) => {
    const selected = get(get(links$).selectedSession$);
    const size = get(displaySize$);
    if (
      !selected ||
      !get(selected.current$) ||
      !size ||
      ![size.width, size.height, size.dpr].every(positive) ||
      get(get(links$).display$).pending
    ) {
      return;
    }
    const settings = get(settings$);
    const started = get(captureStartedState$);
    if (started && sameCaptureSettings(started, settings)) {
      set(cancelCapture$);
      return;
    }
    const now = performance.now();
    const previous = get(captureChange$);
    if (
      previous &&
      sameCaptureSettings(previous.settings, settings) &&
      get(captureScheduled$)
    ) {
      return;
    }
    const change = { settings, first: previous?.first ?? now, last: now };
    set(captureChange$, change);
    const deadline = Math.max(
      get(captureUpdated$) + 150,
      Math.min(change.last + 200, change.first + 1000),
    );
    // Each schedule replaces the previous deadline; only the latest can fire.
    timeout(
      () => {
        set(captureScheduled$, false);
        if (!get(selected.current$)) {
          return;
        }
        if (performance.now() - get(captureUpdated$) < 150) {
          set(scheduleCapture$);
        } else {
          detach(
            set(configureCapture$, selected.attached.frames.signal),
            Reason.DomCallback,
            "browser capture resize",
          );
        }
      },
      Math.max(0, Math.ceil(deadline - now)),
      { signal: set(resetCaptureDeadline$, selected.attached.frames.signal) },
    );
    set(captureScheduled$, true);
  });
  return { cancelCapture$, configureCapture$, scheduleCapture$ };
}

function createRetirementReceiptsGraph(context: ControllerContext) {
  const {
    model,
    disposedState$,
    closingState$,
    retirements$,
    wake$,
    waitEvent$,
  } = context;
  const reconcileRetirement$ = command(
    (
      { get, set },
      retirement: Retirement,
      receipts?: RetirementReceipts,
    ): PromiseSettledResult<void> | null => {
      const targetId = retirement.session.attached.owner.targetId;
      if (get(retirements$).get(targetId) !== retirement) {
        return null;
      }
      const evidence = receipts ?? retirement.receipts;
      if (!evidence) {
        return null;
      }
      const { input, capture, display } = evidence;
      // A native end supersedes only this capture's error, never other effects.
      const result: PromiseSettledResult<void> =
        input.status === "rejected"
          ? input
          : capture.status === "rejected" &&
              !get(retirement.session.stream.stopped$)
            ? capture
            : display?.status === "rejected"
              ? display
              : { status: "fulfilled", value: undefined };
      if (result.status === "rejected" && !receipts) {
        return result;
      }
      const remaining = new Map(get(retirements$));
      if (result.status === "fulfilled") {
        remaining.delete(targetId);
      } else if (receipts) {
        remaining.set(targetId, { ...retirement, receipts });
      }
      set(retirements$, remaining);
      const image = get(model.imageRecovery$);
      if (!get(disposedState$) && image?.owner === retirement.owner) {
        set(model.transition$, {
          type: "image-settled",
          owner: image.owner,
          ready: result.status === "fulfilled",
        });
      }
      set(wake$);
      return result;
    },
  );
  const waitRetirement$ = command(
    async (
      { get, set },
      targetId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      while (true) {
        signal.throwIfAborted();
        const fence = get(retirements$).get(targetId);
        if (!fence) {
          return;
        }
        const result = set(reconcileRetirement$, fence);
        if (result?.status === "rejected") {
          throw result.reason;
        }
        if (result?.status === "fulfilled") {
          return;
        }
        await set(waitEvent$, signal);
      }
    },
  );
  const detachAttached$ = command((_, attached: AttachedSelection) => {
    if (attached.frames !== attached.client) {
      attached.frames.notify("Target.detachFromTarget", {
        sessionId: attached.frameSessionId,
      });
    }
    attached.client.notify("Target.detachFromTarget", {
      sessionId: attached.sessionId,
    });
  });
  const finishRetirement$ = command(
    async (
      { get, set },
      selected: SelectedSession,
      retirement: Retirement,
      reason: InputStop,
      signal: AbortSignal,
    ): Promise<void> => {
      const [input, capture] = await Promise.allSettled([
        set(
          selected.input.retire$,
          reason === "disconnected" ? "disposed" : reason,
          selected.attached.client.signal,
        ),
        set(selected.stream.dispose$, selected.attached.frames.signal),
      ]);
      signal.throwIfAborted();
      // Once closing begins, the transport close owns session detachment.
      if (!get(closingState$)) {
        set(detachAttached$, selected.attached);
      }
      set(reconcileRetirement$, retirement, { input, capture });
      signal.throwIfAborted();
      // The fence retains uncertainty; the existing detached owner reports the
      // original input failure only after detachment and waiter publication.
      if (input.status === "rejected") {
        throw input.reason;
      }
    },
  );
  return {
    reconcileRetirement$,
    waitRetirement$,
    detachAttached$,
    finishRetirement$,
  };
}

function createRetirementsGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<
  ControllerLinks,
  | "reconcileRetirement$"
  | "waitRetirement$"
  | "detachAttached$"
  | "finishRetirement$"
  | "retireCurrent$"
> {
  const {
    model,
    resetSelection$,
    resetCreate$,
    sink,
    disposedState$,
    selection,
    retirements$,
    captureStartedState$,
    creationOwner$,
    wake$,
    nativeHost,
  } = context;
  const receipts = createRetirementReceiptsGraph(context);
  const retireCurrent$: Command<void, [InputStop, boolean, boolean?]> = command(
    (
      { get, set },
      reason: InputStop,
      retainFrame: boolean,
      preserveCreation = false,
    ) => {
      const selected = get(get(links$).selectedSession$);
      if (selected) {
        const image = get(model.imageRecovery$);
        const fence: Retirement = {
          owner: image?.owner ?? {},
          session: selected,
          receipts: null,
        };
        const previous = get(retirements$).get(
          selected.attached.owner.targetId,
        );
        if (!previous?.receipts) {
          set(
            retirements$,
            new Map(get(retirements$)).set(
              selected.attached.owner.targetId,
              fence,
            ),
          );
        }
        if (image && !get(disposedState$)) {
          set(model.transition$, {
            type: "image-failed",
            owner: image.owner,
            targetId: image.targetId,
            error: image.error,
          });
        }
        selected.frameLease.retire();
        set(selected.input.revoke$);
        set(selected.stream.suspend$);
        set(selected.geometry.cancelPresentation$);
        detach(
          set(
            receipts.finishRetirement$,
            selected,
            fence,
            reason,
            selected.attached.client.signal,
          ),
          Reason.DomCallback,
          "browser original session retirement",
        );
      }
      set(resetSelection$);
      if (!preserveCreation) {
        set(resetCreate$);
        set(creationOwner$, null);
      }
      set(selection.clear$);
      set(captureStartedState$, null);
      set(get(links$).cancelCapture$);
      const display = get(get(links$).displayGraph$);
      if (display) {
        set(display.setTarget$, null);
        set(display.setSuspended$, false);
      }
      if (retainFrame) {
        sink.invalidate();
      } else {
        sink.reset();
      }
      set(model.transition$, { type: "stopped", retainFrame });
      set(nativeHost.synchronize$);
      set(wake$);
    },
  );
  return { ...receipts, retireCurrent$ };
}

function createReadinessGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "streaming$" | "waitReady$" | "waitSelection$"> {
  const {
    model,
    selectedOwner$,
    readinessFailure$,
    available$,
    wake$,
    waitEvent$,
    nativeHost,
  } = context;
  const streaming$ = command(({ get, set }, selected: SelectedSession) => {
    if (
      !get(selected.current$) ||
      !get(selected.painted$) ||
      !get(selected.inputReady$)
    ) {
      return;
    }
    const image = get(model.imageRecovery$);
    if (image) {
      const decision = set(model.transition$, {
        type: "image-painted",
        owner: image.owner,
      });
      if (decision?.resumeDisplay) {
        const display = get(get(links$).displayGraph$);
        if (display) {
          set(display.setSuspended$, false);
        }
      }
    } else {
      const display = get(get(links$).displayGraph$);
      if (display) {
        set(display.setSuspended$, false);
      }
      set(model.transition$, { type: "streaming" });
    }
    set(nativeHost.synchronize$);
    set(wake$);
    detach(
      set(
        get(links$).refreshFavicon$,
        selected,
        selected.attached.client.signal,
      ),
      Reason.DomCallback,
      "browser favicon observation",
    );
  });
  const waitReady$ = command(
    async (
      { get, set },
      owner: SelectionOwner,
      signal: AbortSignal,
    ): Promise<void> => {
      while (true) {
        signal.throwIfAborted();
        if (!get(available$) || get(selectedOwner$) !== owner) {
          throw cancelled();
        }
        const selected = get(get(links$).selectedSession$);
        if (selected?.attached.owner === owner) {
          const failure = get(selected.failure$);
          if (failure) {
            throw failure;
          }
          if (
            get(selected.current$) &&
            get(selected.painted$) &&
            get(selected.inputReady$)
          ) {
            return;
          }
        }
        const failure = get(readinessFailure$);
        if (failure) {
          throw failure;
        }
        await set(waitEvent$, signal);
      }
    },
  );
  const waitSelection$: ControllerLinks["waitSelection$"] = command(
    async (
      { get, set },
      owner: SelectionOwner,
      signal: AbortSignal,
    ): Promise<SelectionOutcome> => {
      while (true) {
        signal.throwIfAborted();
        const result = get(owner.completion$);
        if (result?.status === "fulfilled") {
          return result.value;
        }
        if (result?.status === "rejected") {
          throw result.reason;
        }
        await set(context.waitEvent$, signal);
      }
    },
  );
  return { streaming$, waitReady$, waitSelection$ };
}

function detachLateAttachment(source: CdpClient, value: unknown) {
  if (isRecord(value) && typeof value.sessionId === "string") {
    source.notify("Target.detachFromTarget", { sessionId: value.sessionId });
  }
}

function attachmentSessionId(value: unknown, message: string): string {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    !value.sessionId
  ) {
    throw new CdpFault("protocol", message);
  }
  return value.sessionId;
}

function createAttachmentAdmission(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { selectedOwner$, available$, waitEvent$, clientState$, directory$ } =
    context;
  const assertCurrent$ = command(
    ({ get }, owner: SelectionOwner, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (!get(available$) || get(selectedOwner$) !== owner) {
        throw cancelled();
      }
    },
  );
  const waitForDiscovery$ = command(
    async ({ get, set }, owner: SelectionOwner, signal: AbortSignal) => {
      const discovery = get(get(links$).discovery$)!;
      while (!get(discovery.ready$)) {
        set(assertCurrent$, owner, signal);
        await set(waitEvent$, signal);
      }
      set(assertCurrent$, owner, signal);
    },
  );
  const activate$ = command(
    async ({ get, set }, owner: SelectionOwner, signal: AbortSignal) => {
      const client = get(clientState$)!;
      const directory = get(directory$)!;
      await set(waitForDiscovery$, owner, signal);
      await set(get(links$).waitRetirement$, owner.targetId, signal);
      set(assertCurrent$, owner, signal);
      await set(directory.assertMember$, owner.targetId, signal);
      signal.throwIfAborted();
      set(assertCurrent$, owner, signal);
      await client.request(
        "Target.activateTarget",
        { targetId: owner.targetId },
        undefined,
        undefined,
        signal,
      );
      set(assertCurrent$, owner, signal);
      await set(directory.assertMember$, owner.targetId, signal);
      signal.throwIfAborted();
      set(assertCurrent$, owner, signal);
    },
  );
  return { assertCurrent$, activate$ };
}

function createAttachmentInitialization(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
  assertCurrent$: Command<void, [SelectionOwner, AbortSignal]>,
) {
  const { wake$, nativeHost } = context;
  const enable$ = command(
    async (
      { set },
      owner: SelectionOwner,
      client: CdpClient,
      sessionId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      await client.request(
        "Inspector.enable",
        undefined,
        sessionId,
        undefined,
        signal,
      );
      set(assertCurrent$, owner, signal);
      await client.request(
        "Page.enable",
        undefined,
        sessionId,
        undefined,
        signal,
      );
      set(assertCurrent$, owner, signal);
    },
  );
  const initialize$ = command(
    async (
      { get, set },
      attached: AttachedSelection,
      signal: AbortSignal,
    ): Promise<void> => {
      const { owner, client, frames, sessionId } = attached;
      const selected = get(get(links$).selectedSession$)!;
      const [inputResult, captureResult] = await Promise.allSettled([
        set(selected.input.start$, client.signal),
        set(selected.stream.start$, frames.signal),
      ]);
      signal.throwIfAborted();
      set(assertCurrent$, owner, signal);
      if (inputResult.status === "rejected") {
        throw inputResult.reason;
      }
      set(selected.inputReady$, true);
      set(nativeHost.synchronize$);
      set(get(links$).streaming$, selected);
      if (captureResult.status === "rejected") {
        throw captureResult.reason;
      }
      const display = get(get(links$).displayGraph$);
      if (display) {
        set(display.setTarget$, {
          targetId: owner.targetId,
          sessionId,
          geometry: selected.geometry,
          current: selected.frameLease.current,
        });
      }
      set(wake$);
    },
  );
  return { enable$, initialize$ };
}

function createAttachmentGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "attach$"> {
  const { clientState$, selection, settings$, directory$, nativeHost } =
    context;
  const { assertCurrent$, activate$ } = createAttachmentAdmission(
    context,
    links$,
  );
  const { enable$, initialize$ } = createAttachmentInitialization(
    context,
    links$,
    assertCurrent$,
  );
  const attach$ = command(
    async (
      { get, set },
      owner: SelectionOwner,
      signal: AbortSignal,
    ): Promise<void> => {
      const client = get(clientState$)!;
      const frames = await set(get(links$).ensureFrames$, signal);
      set(assertCurrent$, owner, signal);
      const directory = get(directory$)!;
      await set(activate$, owner, signal);
      let sessionId: string | null = null;
      let frameSessionId: string | null = null;
      let published = false;
      using _unpublished = {
        [Symbol.dispose]: () => {
          set(selection.release$, owner);
          if (published) {
            return;
          }
          if (frameSessionId && frames !== client) {
            frames.notify("Target.detachFromTarget", {
              sessionId: frameSessionId,
            });
          }
          if (sessionId) {
            client.notify("Target.detachFromTarget", { sessionId });
          }
        },
      };
      const attached: unknown = await client.request(
        "Target.attachToTarget",
        { targetId: owner.targetId, flatten: true },
        undefined,
        (value) => {
          detachLateAttachment(client, value);
        },
        signal,
      );
      // Record a successful native receipt before checking operation cancellation.
      sessionId = attachmentSessionId(
        attached,
        "The browser returned an invalid target session.",
      );
      set(assertCurrent$, owner, signal);
      if (!set(selection.receive$, owner, { client, sessionId })) {
        throw cancelled();
      }
      if (frames === client) {
        frameSessionId = sessionId;
      } else {
        await set(directory.assertMember$, owner.targetId, signal);
        signal.throwIfAborted();
        set(assertCurrent$, owner, signal);
        const frameAttached: unknown = await frames.request(
          "Target.attachToTarget",
          { targetId: owner.targetId, flatten: true },
          undefined,
          (value) => {
            detachLateAttachment(frames, value);
          },
          signal,
        );
        frameSessionId = attachmentSessionId(
          frameAttached,
          "The browser returned an invalid frame session.",
        );
        set(assertCurrent$, owner, signal);
        if (
          !set(selection.receive$, owner, {
            client: frames,
            sessionId: frameSessionId,
          })
        ) {
          throw cancelled();
        }
      }
      await set(directory.assertMember$, owner.targetId, signal);
      signal.throwIfAborted();
      set(assertCurrent$, owner, signal);
      await set(enable$, owner, client, sessionId, signal);
      const attachment: AttachedSelection = {
        owner,
        client,
        frames,
        sessionId,
        frameSessionId,
        settings: get(settings$),
      };
      if (!set(selection.publish$, attachment)) {
        throw cancelled();
      }
      set(nativeHost.synchronize$);
      published = true;
      return set(initialize$, attachment, signal);
    },
  );
  return { attach$ };
}

function createSelectionRevalidation(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const {
    model,
    selectedOwner$,
    available$,
    directory$,
    closingTargets$,
    clientState$,
  } = context;
  const revalidateSelection$ = command(
    ({ get, set }, owner: SelectionOwner) => {
      if (
        get(selectedOwner$) !== owner ||
        get(closingTargets$).has(owner.targetId)
      ) {
        return;
      }
      set(get(links$).retireCurrent$, "target-replaced", false, true);
      const discovery = get(get(links$).discovery$);
      if (discovery) {
        detach(
          set(discovery.refresh$, get(clientState$)!.signal),
          Reason.DomCallback,
          "browser selected target revalidation",
        );
      }
    },
  );
  const confirmLostSelection$ = command(
    async (
      { get, set },
      owner: SelectionOwner,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const directory = get(directory$)!;
      const [resolution] = await Promise.allSettled([
        set(directory.resolve$, owner.targetId, signal),
      ]);
      signal.throwIfAborted();
      if (
        get(selectedOwner$) !== owner ||
        !get(available$) ||
        resolution.status === "rejected"
      ) {
        return false;
      }
      if (resolution.value.kind === "absent") {
        return true;
      }
      if (resolution.value.kind !== "present") {
        return false;
      }
      const [membership] = await Promise.allSettled([
        set(directory.contains$, owner.targetId, signal),
      ]);
      signal.throwIfAborted();
      return (
        get(selectedOwner$) === owner &&
        get(available$) &&
        membership.status === "fulfilled" &&
        !membership.value
      );
    },
  );

  const confirmFailedSelection$ = command(
    async (
      { get, set },
      owner: SelectionOwner,
      error: unknown,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (
        get(selectedOwner$) !== owner ||
        !get(available$) ||
        get(model.imageRecovery$) ||
        (error instanceof CdpFault && error.kind === "unsupported-capability")
      ) {
        return;
      }
      if (await set(confirmLostSelection$, owner, signal)) {
        set(revalidateSelection$, owner);
      }
    },
  );
  return { revalidateSelection$, confirmFailedSelection$ };
}

function createSelectionAttempt(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
  confirmFailedSelection$: Command<
    Promise<void>,
    [SelectionOwner, unknown, AbortSignal]
  >,
) {
  const {
    model,
    resetSelection$,
    clientState$,
    disposedState$,
    selectedOwner$,
    readinessFailure$,
    wake$,
  } = context;
  return command(
    async (
      { get, set },
      owner: SelectionOwner,
      signal: AbortSignal,
    ): Promise<SelectionOutcome> => {
      const client = get(clientState$)!;
      const operation = set(resetSelection$, client.signal, signal);
      const abort = () => {
        if (get(selectedOwner$) === owner) {
          set(get(links$).retireCurrent$, "target-replaced", false);
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
      using _abort = {
        [Symbol.dispose]: () => {
          signal.removeEventListener("abort", abort);
        },
      };
      const [result] = await Promise.allSettled([
        (async () => {
          await set(get(links$).attach$, owner, operation);
          await set(get(links$).waitReady$, owner, operation);
        })(),
      ]);
      if (signal.aborted) {
        set(owner.finish$, { status: "rejected", reason: signal.reason });
        set(wake$);
      }
      signal.throwIfAborted();
      if (result.status === "rejected" && !operation.aborted) {
        // Failed or cancelled confirmation never replaces the primary error.
        await Promise.allSettled([
          set(confirmFailedSelection$, owner, result.reason, operation),
        ]);
      }
      // Publish the attempt's result before cleanup can cancel or replace its owner.
      let completion: PromiseSettledResult<SelectionOutcome>;
      if (signal.aborted) {
        completion = { status: "rejected", reason: signal.reason };
      } else if (client.signal.aborted) {
        completion = { status: "rejected", reason: client.signal.reason };
      } else if (operation.aborted || get(selectedOwner$) !== owner) {
        completion = { status: "fulfilled", value: "superseded" };
      } else {
        completion =
          result.status === "fulfilled"
            ? { status: "fulfilled", value: "ready" }
            : result;
      }
      set(owner.finish$, completion);
      set(wake$);
      signal.throwIfAborted();
      client.signal.throwIfAborted();
      if (completion.status === "fulfilled") {
        return completion.value;
      }
      if (get(selectedOwner$) === owner && !get(disposedState$)) {
        const selected = get(get(links$).selectedSession$);
        if (selected && get(model.imageRecovery$)) {
          set(selected.failure$, completion.reason);
          set(wake$);
        } else {
          set(readinessFailure$, completion.reason);
          set(get(links$).retireCurrent$, "target-replaced", false);
          set(model.transition$, {
            type: "failed",
            error: diagnostic(completion.reason),
          });
        }
      }
      signal.throwIfAborted();
      throw completion.reason;
    },
  );
}

function createSelectionGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "selectTab$" | "select$" | "revalidateSelection$"> {
  const {
    model,
    chosenOnce$,
    selection,
    extensionRevision$,
    readinessFailure$,
    assertAvailable$,
  } = context;
  const { revalidateSelection$, confirmFailedSelection$ } =
    createSelectionRevalidation(context, links$);
  const attempt$ = createSelectionAttempt(
    context,
    links$,
    confirmFailedSelection$,
  );
  const select$: ControllerLinks["select$"] = command(
    async (
      { get, set },
      targetId: string,
      signal: AbortSignal,
    ): Promise<SelectionOutcome> => {
      set(assertAvailable$, signal);
      const target = get(model.snapshot$).targets.find((target) => {
        return target.id === targetId;
      });
      if (!target) {
        throw new CdpFault(
          "target-unavailable",
          "The target is no longer available in this scope.",
        );
      }
      const previous = get(get(links$).selectedSession$);
      if (
        previous?.attached.owner.targetId === targetId &&
        get(previous.current$) &&
        get(previous.painted$) &&
        get(previous.inputReady$) &&
        !get(model.imageRecovery$)
      ) {
        return "ready";
      }
      set(chosenOnce$, true);
      set(extensionRevision$, (value) => {
        return value + 1;
      });
      const preview =
        !target.blank &&
        (get(model.presentation$).status === "streaming" ||
          get(model.presentation$).loadingPreview);
      set(get(links$).retireCurrent$, "target-replaced", preview);
      set(context.crashedSelection$, null);
      set(readinessFailure$, null);
      set(model.transition$, {
        type: "select",
        targetId,
        paused: false,
        preview,
      });
      const owner = set(selection.begin$, targetId);
      return await set(attempt$, owner, signal);
    },
  );
  const selectTab$: ControllerLinks["selectTab$"] = command(
    async ({ set }, targetId: string, signal: AbortSignal): Promise<void> => {
      const outcome = await set(select$, targetId, signal);
      signal.throwIfAborted();
      if (outcome === "superseded") {
        throw cancelled();
      }
    },
  );
  return { select$, selectTab$, revalidateSelection$ };
}

function createFaviconGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "refreshFavicon$"> {
  const { model, faviconPending$, faviconAvailable$ } = context;
  const refreshFavicon$ = command(
    async (
      { get, set },
      selected: SelectedSession,
      signal: AbortSignal,
    ): Promise<void> => {
      const document = get(selected.favicon$);
      if (
        signal.aborted ||
        !get(selected.current$) ||
        !get(selected.painted$) ||
        !get(selected.inputReady$) ||
        !document.wanted ||
        !get(faviconAvailable$) ||
        get(faviconPending$)
      ) {
        return;
      }
      const request = {};
      const readingDocument = {
        ...document,
        wanted: false,
        waiting: !document.ready,
      };
      set(selected.favicon$, readingDocument);
      set(faviconPending$, request);
      using _request = {
        [Symbol.dispose]: () => {
          if (get(faviconPending$) === request) {
            set(faviconPending$, null);
          }
          const current = get(get(links$).selectedSession$);
          if (current) {
            detach(
              set(refreshFavicon$, current, current.attached.client.signal),
              Reason.DomCallback,
              "browser successor favicon",
            );
          }
        },
      };
      const [result] = await Promise.allSettled([
        readFavicon(selected.attached.client, selected.attached.sessionId),
      ]);
      signal.throwIfAborted();
      if (result.status === "fulfilled") {
        if (
          get(selected.current$) &&
          get(selected.favicon$) === readingDocument &&
          result.value !== undefined
        ) {
          set(selected.favicon$, {
            wanted: false,
            waiting: false,
            ready: true,
          });
          set(model.setFavicon$, {
            targetId: selected.attached.owner.targetId,
            url: result.value,
          });
        }
        return;
      }
      const error: unknown = result.reason;
      if (
        !(error instanceof CdpFault) ||
        error.code === undefined ||
        error.code === -32_601
      ) {
        set(faviconAvailable$, false);
      }
      if (
        get(selected.current$) &&
        get(selected.favicon$) === readingDocument
      ) {
        set(selected.favicon$, { wanted: false, waiting: false, ready: true });
        set(model.setFavicon$, {
          targetId: selected.attached.owner.targetId,
          url: null,
        });
      }
    },
  );
  return { refreshFavicon$ };
}

function createSessionEvent(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { model } = context;
  return command(({ get, set }, event: CdpEvent, selected: SelectedSession) => {
    set(selected.geometry.event$, event.method);
    set(selected.input.event$, event);
    set(model.reconcileAddress$, selected.navigation.scope);
    const inputError = get(selected.input.error$);
    if (inputError) {
      set(model.update$, { error: diagnostic(inputError) });
    }
    const params = event.params;
    if (
      event.method === "Page.frameStartedNavigating" &&
      typeof params.frameId === "string"
    ) {
      set(selected.stream.navigationStarted$, params.frameId);
    } else if (
      event.method === "Page.frameNavigated" &&
      isRecord(params.frame) &&
      typeof params.frame.id === "string"
    ) {
      set(selected.stream.navigationFinished$, params.frame.id);
      if (!params.frame.parentId) {
        const restored = params.type === "BackForwardCacheRestore";
        set(selected.favicon$, {
          wanted: restored,
          waiting: !restored,
          ready: restored,
        });
        set(model.setFavicon$, {
          targetId: selected.attached.owner.targetId,
          url: null,
        });
        if (restored) {
          detach(
            set(
              get(links$).refreshFavicon$,
              selected,
              selected.attached.client.signal,
            ),
            Reason.DomCallback,
            "browser restored favicon",
          );
        }
      }
    } else if (
      [
        "Page.frameStoppedLoading",
        "Page.frameDetached",
        "Page.navigatedWithinDocument",
      ].includes(event.method) &&
      typeof params.frameId === "string"
    ) {
      set(selected.stream.navigationFinished$, params.frameId);
    }
    if (
      event.method === "Page.domContentEventFired" &&
      !get(selected.favicon$).ready
    ) {
      const document = get(selected.favicon$);
      set(selected.favicon$, {
        ready: true,
        waiting: false,
        wanted: document.waiting || document.wanted,
      });
      detach(
        set(
          get(links$).refreshFavicon$,
          selected,
          selected.attached.client.signal,
        ),
        Reason.DomCallback,
        "browser document favicon",
      );
    }
  });
}

function createScreencastEvent(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { framesState$ } = context;
  return command(({ get, set }, event: CdpEvent, source: CdpClient) => {
    const selected = get(get(links$).selectedSession$);
    const id = event.sessionId;
    const params = event.params;
    if (
      id &&
      source === get(framesState$) &&
      Number.isSafeInteger(params.sessionId)
    ) {
      source.notify(
        "Page.screencastFrameAck",
        { sessionId: params.sessionId as number },
        id,
      );
    }
    if (
      !selected ||
      source !== selected.attached.frames ||
      id !== selected.attached.frameSessionId ||
      !get(selected.current$) ||
      !get(selected.stream.acceptingFrames$) ||
      typeof params.data !== "string"
    ) {
      return;
    }
    const receipt = set(selected.geometry.frame$, params.metadata);
    if (!receipt) {
      return;
    }
    set(
      selected.stream.push$,
      params.data,
      (raster: Viewport) => {
        if (!get(selected.current$)) {
          return;
        }
        set(selected.geometry.paintFrame$, receipt, raster);
        if (!get(selected.painted$)) {
          set(selected.painted$, true);
          set(get(links$).streaming$, selected);
        }
      },
      (raster: Viewport) => {
        return (
          get(selected.current$) &&
          set(selected.geometry.acceptFrame$, receipt, raster)
        );
      },
      selected.attached.frames.signal,
    );
  });
}

function createDetachedEvent(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { closingTargets$, selection } = context;
  return command(
    (
      { get, set },
      event: CdpEvent,
      source: CdpClient,
      selected: SelectedSession | null,
    ) => {
      const owner = get(selection.owner$);
      if (!owner || get(closingTargets$).has(owner.targetId)) {
        return;
      }
      const matches = get(selection.sessions$).some((session) => {
        return (
          session.client === source &&
          session.sessionId === event.params.sessionId
        );
      });
      if (matches) {
        if (selected && source === selected.attached.frames) {
          set(selected.stream.detached$);
        }
        // Received sessions belong to this selection even before input starts.
        set(get(links$).revalidateSelection$, owner);
      }
    },
  );
}

function createRetiredSessionEvents(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { model, retirements$, connected$ } = context;
  return command(
    (
      { get, set },
      event: CdpEvent,
      source: CdpClient,
      selected: SelectedSession | null,
    ) => {
      for (const retirement of get(retirements$).values()) {
        const original = retirement.session;
        if (
          original !== selected &&
          source === original.attached.client &&
          event.sessionId === original.attached.sessionId
        ) {
          set(original.input.event$, event);
        }
        if (
          event.method !== "Target.detachedFromTarget" ||
          source !== original.attached.frames ||
          event.params.sessionId !== original.attached.frameSessionId
        ) {
          continue;
        }
        set(original.stream.detached$);
        const result = set(get(links$).reconcileRetirement$, retirement);
        if (result?.status !== "fulfilled") {
          continue;
        }
        const targetId = original.attached.owner.targetId;
        if (
          selected ||
          !get(connected$) ||
          get(model.selectedTabId$) !== targetId
        ) {
          continue;
        }
        const discovery = get(get(links$).discovery$);
        if (discovery) {
          detach(
            set(discovery.refresh$, original.attached.client.signal),
            Reason.DomCallback,
            "browser confirmed capture retirement",
          );
        }
      }
    },
  );
}

function createProtocolEventDispatch(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
  followActiveTarget$: ControllerLinks["followActiveTarget$"],
) {
  const { clientState$, disposedState$, targetRevision$, wake$ } = context;
  const retiredEvent$ = createRetiredSessionEvents(context, links$);
  const detachedEvent$ = createDetachedEvent(context, links$);
  const sessionEvent$ = createSessionEvent(context, links$);
  const screencastEvent$ = createScreencastEvent(context, links$);
  const crashedEvent$ = createCrashedEvent(context, links$);
  return command(
    async (
      { get, set },
      event: CdpEvent,
      source: CdpClient,
      signal: AbortSignal,
    ): Promise<void> => {
      const selected = get(get(links$).selectedSession$);
      set(retiredEvent$, event, source, selected);
      if (get(disposedState$)) {
        return;
      }
      set(crashedEvent$, event, source);
      if (
        source === get(clientState$) &&
        selected &&
        event.sessionId === selected.attached.sessionId
      ) {
        set(sessionEvent$, event, selected);
      }
      if (event.method === "Page.screencastFrame") {
        set(screencastEvent$, event, source);
        return;
      }
      if (event.method === "Target.detachedFromTarget") {
        set(detachedEvent$, event, source, selected);
      }
      if (source !== get(clientState$)) {
        return;
      }
      if (
        event.method === "BrowserUse.activeTargetChanged" &&
        event.sessionId === undefined &&
        typeof event.params.targetId === "string"
      ) {
        await set(followActiveTarget$, event.params.targetId, signal);
        return;
      }
      if (
        event.sessionId === undefined &&
        [
          "Target.targetCreated",
          "Target.targetInfoChanged",
          "Target.targetDestroyed",
        ].includes(event.method)
      ) {
        set(targetRevision$, (value) => {
          return value + 1;
        });
        const discovery = get(get(links$).discovery$);
        if (discovery) {
          await set(discovery.event$, event, signal);
        }
        set(wake$);
      }
    },
  );
}

function createCrashedEvent(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { model, selection, clientState$, crashedSelection$, closingTargets$ } =
    context;
  return command(({ get, set }, event: CdpEvent, source: CdpClient) => {
    const owner = get(selection.owner$);
    if (!owner || get(closingTargets$).has(owner.targetId)) {
      return;
    }
    const sessions = get(selection.sessions$);
    if (
      event.method === "Target.targetCrashed" &&
      event.sessionId === undefined &&
      source === get(clientState$) &&
      event.params.targetId === owner.targetId
    ) {
      // Target IDs do not identify a session incarnation. Ask the current
      // Inspector to re-announce its own crash state; a healthy successor stays live.
      const session = sessions.find((receipt) => {
        return receipt.client === source;
      });
      if (session) {
        source.notify("Inspector.enable", undefined, session.sessionId);
      }
      return;
    }
    if (
      event.method !== "Inspector.targetCrashed" ||
      !sessions.some((receipt) => {
        return (
          receipt.client === source && receipt.sessionId === event.sessionId
        );
      })
    ) {
      return;
    }
    set(crashedSelection$, { owner, intent: get(model.intent$).selection });
    // Crash is not detach evidence. Original input/capture receipts retain
    // their normal retirement fence, independently of this recovery observation.
    set(get(links$).retireCurrent$, "target-replaced", false, true);
    set(model.transition$, {
      type: "failed",
      error: {
        kind: "target-crashed",
        message: "The selected browser page crashed.",
      },
    });
  });
}

function createActiveTargetFollowing(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const {
    model,
    clientState$,
    targetRevision$,
    extensionRevision$,
    available$,
    directory$,
  } = context;
  return command(
    async (
      { get, set },
      targetId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      if (
        !get(available$) ||
        !get(model.snapshot$).targets.some((target) => {
          return target.id === targetId;
        })
      ) {
        return;
      }
      const request = get(extensionRevision$) + 1;
      set(extensionRevision$, request);
      if (get(model.selectedTabId$) === targetId) {
        return;
      }
      const intent = get(model.intent$);
      const revision = get(targetRevision$);
      const current = () => {
        return (
          get(available$) &&
          get(extensionRevision$) === request &&
          get(model.intent$) === intent &&
          get(targetRevision$) === revision
        );
      };
      const [result] = await Promise.allSettled([
        (async () => {
          const reply: unknown = await get(clientState$)!.request(
            "Target.getTargetInfo",
            { targetId },
            undefined,
            undefined,
            signal,
          );
          if (
            !current() ||
            !isRecord(reply) ||
            !isRecord(reply.targetInfo) ||
            reply.targetInfo.targetId !== targetId ||
            reply.targetInfo.type !== "page" ||
            reply.targetInfo.subtype === "prerender"
          ) {
            return;
          }
          await set(get(directory$)!.assertMember$, targetId, signal);
          if (current()) {
            await set(get(links$).selectTab$, targetId, signal);
          }
        })(),
      ]);
      signal.throwIfAborted();
      if (result.status === "rejected") {
        return;
      }
    },
  );
}

function createFramesDisconnectionHandling(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { model, framesState$, retirements$, selectedOwner$, wake$ } = context;
  return command(({ get, set }, fault: CdpFault, source: CdpClient) => {
    set(framesState$, null);
    // Closing a CDP socket ends only its own sessions. It cannot acknowledge
    // an input/navigation effect sent on the surviving control connection.
    const selected = get(get(links$).selectedSession$);
    if (selected?.attached.frames === source) {
      set(selected.stream.detached$);
    }
    for (const retirement of get(retirements$).values()) {
      if (retirement.session.attached.frames === source) {
        set(retirement.session.stream.detached$);
        set(get(links$).reconcileRetirement$, retirement);
      }
    }
    const owner = get(selectedOwner$);
    // An already-settling/blocked image retains every original receipt.
    const image = get(model.imageRecovery$);
    if (!owner || (image && get(retirements$).has(owner.targetId))) {
      set(wake$);
      return;
    }
    const recoveryOwner = image?.owner ?? {};
    set(model.transition$, {
      type: "image-failed",
      owner: recoveryOwner,
      targetId: owner.targetId,
      error: diagnostic(
        new CdpFault("frame", fault.message, undefined, undefined, {
          cause: fault,
        }),
      ),
    });
    set(get(links$).retireCurrent$, "target-replaced", false, true);
    // Admission can lose frames before a selected input/capture graph exists.
    if (!selected) {
      set(model.transition$, {
        type: "image-settled",
        owner: recoveryOwner,
        ready: true,
      });
    }
    set(wake$);
  });
}

function createDisconnectionHandling(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): ControllerLinks["disconnected$"] {
  const {
    model,
    clientState$,
    framesState$,
    connectedState$,
    disposedState$,
    closingState$,
    disconnectingState$,
    readinessFailure$,
    wake$,
  } = context;
  const framesDisconnected$ = createFramesDisconnectionHandling(
    context,
    links$,
  );
  return command(({ get, set }, fault: CdpFault, source: CdpClient) => {
    if (get(disposedState$) || get(closingState$) || get(disconnectingState$)) {
      return;
    }
    if (source !== get(clientState$)) {
      if (source !== get(framesState$)) {
        return;
      }
      if (get(connectedState$)) {
        set(framesDisconnected$, fault, source);
        return;
      }
    }
    set(disconnectingState$, true);
    const established = get(connectedState$);
    if (established) {
      captureSentryLogError("Browser", [
        "Browser viewer disconnected",
        fault,
        sentryLogContext({
          tags: { browser_event: "established-disconnect" },
          contexts: {
            browser_viewer: {
              kind: fault.kind,
              role: source === get(clientState$) ? "control" : "frames",
            },
            ...(fault.connection
              ? { browser_connection: { ...fault.connection } }
              : {}),
          },
        }),
      ]);
    }
    set(connectedState$, false);
    set(readinessFailure$, fault);
    set(get(links$).retireCurrent$, "disconnected", false);
    const display = get(get(links$).displayGraph$);
    if (display) {
      set(display.close$);
    }
    const discovery = get(get(links$).discovery$);
    if (discovery) {
      set(discovery.close$);
    }
    set(model.transition$, {
      type: "disconnected",
      established,
      error: diagnostic(fault),
    });
    set(wake$);
    // A dead control cannot drain. Other losses retain control long enough to write releases.
    if (
      source === get(clientState$) &&
      fault.kind !== "extension" &&
      fault.kind !== "scope"
    ) {
      get(framesState$)?.close(fault);
    }
    set(get(links$).beginClosing$);
  });
}

function createEventsGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<
  ControllerLinks,
  "event$" | "followActiveTarget$" | "disconnected$" | "nativeEvent$"
> {
  const followActiveTarget$ = createActiveTargetFollowing(context, links$);
  const event$ = createProtocolEventDispatch(
    context,
    links$,
    followActiveTarget$,
  );
  const disconnected$ = createDisconnectionHandling(context, links$);
  const nativeEvent$ = command(({ get, set }, event: NativeEvent) => {
    if (get(context.disposedState$) || get(context.closingState$)) {
      return;
    }
    const client = get(context.clientState$);
    const directory = get(context.directory$);
    if (!client || !directory) {
      return;
    }
    const windowId = context.connection.windowId;
    if (
      event.kind === "window-removed" &&
      windowId !== null &&
      event.windowId === windowId
    ) {
      set(
        disconnected$,
        new CdpFault("scope", "The assigned browser window is unavailable."),
        client,
      );
      return;
    }
    if (!changesMembership(event, windowId ?? undefined)) {
      return;
    }
    set(directory.invalidate$);
    const discovery = get(get(links$).discovery$);
    if (discovery) {
      detach(
        set(discovery.refresh$, client.signal),
        Reason.DomCallback,
        "browser native membership validation",
      );
    }
  });
  return { event$, followActiveTarget$, disconnected$, nativeEvent$ };
}

function createFramesConnectionGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "createFrames$" | "ensureFrames$"> {
  const { connection, framesState$, clientState$, assertAvailable$ } = context;
  const createFrames$ = command(({ get, set }): CdpClient => {
    const lifetime = get(clientState$)!.signal;
    const frames = createCdpClient(
      connection.cdpUrl,
      { role: "frames" },
      lifetime,
    );
    set(framesState$, frames);
    frames.onEvent((event) => {
      detach(
        set(get(links$).event$, event, frames, lifetime),
        Reason.DomCallback,
        "browser video event",
      );
    });
    frames.onDisconnected((fault) => {
      set(get(links$).disconnected$, fault, frames);
    });
    return frames;
  });
  const ensureFrames$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<CdpClient> => {
      set(assertAvailable$, signal);
      const frames = get(framesState$) ?? set(createFrames$);
      // Selection cancellation stops waiting; the controller still owns the
      // socket, so another selection can reuse it and unmount will close it.
      const cancellation = createDeferredPromise<void>(
        { rejection: "owner" },
        signal,
      );
      using _wait = {
        [Symbol.dispose]: () => {
          if (!cancellation.settled()) {
            cancellation.resolve();
          }
        },
      };
      await Promise.race([frames.opened, cancellation.promise]);
      signal.throwIfAborted();
      set(assertAvailable$, signal);
      if (get(framesState$) !== frames) {
        throw cancelled();
      }
      return frames;
    },
  );
  return { createFrames$, ensureFrames$ };
}

function createConnectionBootstrap(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Command<Promise<SelectionOutcome>, [AbortSignal]> {
  const {
    model,
    connection,
    authority$,
    resetOwner$,
    clientState$,
    nativeState$,
    closingState$,
    framesState$,
    connectedState$,
    bootstrapping$,
    displaySize$,
    readinessFailure$,
    assertAvailable$,
  } = context;
  return command(async ({ get, set }, signal: AbortSignal) => {
    validateConfiguration(connection.cdpUrl, connection.windowId ?? undefined);
    const transport = get(model.transport$);
    if (transport !== "shared" && transport !== "split") {
      throw new CdpFault("configuration", "The transport mode is invalid.");
    }
    set(
      model.configure$,
      connection.windowId !== null && connection.windowId !== undefined,
    );
    // Keep the wire independent of admission/DOM cancellation until releases are written.
    const lifetime = set(resetOwner$);
    const client = createCdpClient(
      connection.cdpUrl,
      { role: "control" },
      lifetime,
    );
    set(clientState$, client);
    set(framesState$, client);
    client.onEvent((event) => {
      detach(
        set(get(links$).event$, event, client, lifetime),
        Reason.DomCallback,
        "browser protocol event",
      );
    });
    client.onDisconnected((fault) => {
      set(get(links$).disconnected$, fault, client);
    });
    if (transport === "split") {
      set(get(links$).createFrames$);
    }
    await Promise.all([client.opened, get(framesState$)!.opened]);
    signal.throwIfAborted();
    const native = await connectNative(
      client,
      connection.extension.runtimeId,
      signal,
    );
    if (get(closingState$) || signal.aborted) {
      await native.close();
      signal.throwIfAborted();
      throw cancelled();
    }
    set(nativeState$, native);
    native.onEvent((event) => {
      set(get(links$).nativeEvent$, event);
    });
    const unavailable = () => {
      set(get(links$).disconnected$, nativeFault(native.signal.reason), client);
    };
    native.signal.addEventListener("abort", unavailable, {
      once: true,
      signal: client.signal,
    });
    if (native.signal.aborted) {
      unavailable();
      throw nativeFault(native.signal.reason);
    }
    await client.request(
      "Target.setDiscoverTargets",
      { discover: true },
      undefined,
      undefined,
      signal,
    );
    set(connectedState$, true);
    set(model.setConnected$, true);
    const display = get(get(links$).displayGraph$)!;
    set(display.setMode$, get(model.windowSizeSync$));
    set(display.measure$, get(displaySize$));
    set(display.setSuspended$, !get(authority$) || get(model.intent$).paused);
    set(display.start$, client.signal);
    await set(get(get(links$).discovery$)!.start$, client.signal);
    signal.throwIfAborted();
    set(bootstrapping$, false);
    const failure = get(readinessFailure$);
    if (failure) {
      throw failure;
    }
    set(assertAvailable$, signal);
    const first = get(model.snapshot$).targets[0];
    if (first) {
      return set(get(links$).select$, first.id, signal);
    }
    set(model.transition$, { type: "target-lost", error: null });
    return "ready" as const;
  });
}

function createConnectionGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "start$"> {
  const {
    model,
    disposedState$,
    startedState$,
    bootstrapping$,
    selectedOwner$,
    readinessFailure$,
    connected$,
    wake$,
  } = context;
  const bootstrap$ = createConnectionBootstrap(context, links$);
  const start$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (get(startedState$)) {
        const owner = get(selectedOwner$);
        if (owner) {
          await set(get(links$).waitReady$, owner, signal);
        } else if (!get(connected$)) {
          throw get(readinessFailure$) ?? cancelled();
        }
        return;
      }
      set(startedState$, true);
      signal.addEventListener(
        "abort",
        () => {
          set(get(links$).dispose$);
        },
        { once: true },
      );
      using _bootstrap = {
        [Symbol.dispose]: () => {
          set(bootstrapping$, false);
          set(wake$);
        },
      };
      let [result] = await Promise.allSettled([set(bootstrap$, signal)]);
      signal.throwIfAborted();
      while (
        result.status === "fulfilled" &&
        result.value === "superseded" &&
        !get(disposedState$) &&
        get(connected$)
      ) {
        // Selection ownership can change while the connection is opening.
        [result] = await Promise.allSettled([
          set(get(links$).reconcileSelection$, signal),
        ]);
        signal.throwIfAborted();
      }
      if (result.status === "fulfilled" && result.value === "superseded") {
        set(get(links$).dispose$);
        throw get(readinessFailure$) ?? cancelled();
      }
      if (result.status === "rejected") {
        if (!get(disposedState$) && !isAbortError(result.reason)) {
          set(readinessFailure$, result.reason);
          if (!get(model.imageRecovery$)) {
            set(model.transition$, {
              type: "failed",
              error: diagnostic(result.reason),
            });
          }
        }
        set(wake$);
        set(get(links$).dispose$);
        if (signal.aborted) {
          throw cancelled();
        }
        throw result.reason;
      }
      signal.throwIfAborted();
    },
  );
  return { start$ };
}

interface CreatedTabPublication {
  readonly client: CdpClient;
  readonly intent: ViewerIntent;
  readonly creation: object;
}

function createTabPublication(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { model, creationOwner$, targetRevision$, assertAvailable$ } = context;
  return command(
    async (
      { get, set },
      createdId: string,
      publication: CreatedTabPublication,
      signal: AbortSignal,
    ): Promise<string> => {
      const { client, intent, creation } = publication;
      signal.throwIfAborted();
      set(assertAvailable$, signal);
      if (
        get(creationOwner$) !== creation ||
        get(model.intent$).selection !== intent.selection
      ) {
        throw cancelled();
      }
      const discovery = get(get(links$).discovery$)!;
      const observation = set(discovery.beginCreation$, createdId);
      const reply = await client.request(
        "Target.getTargetInfo",
        { targetId: createdId },
        undefined,
        undefined,
        signal,
      );
      signal.throwIfAborted();
      set(assertAvailable$, signal);
      if (
        get(creationOwner$) !== creation ||
        get(model.intent$).selection !== intent.selection
      ) {
        throw cancelled();
      }
      const created = pageTarget(reply.targetInfo);
      if (
        !created ||
        created.id !== createdId ||
        reply.targetInfo.url !== "about:blank" ||
        !set(discovery.created$, created, observation, client.signal)
      ) {
        throw new CdpFault(
          "tab",
          "The new tab is no longer available in this scope.",
        );
      }
      await set(discovery.refresh$, client.signal);
      signal.throwIfAborted();
      set(assertAvailable$, signal);
      if (
        get(creationOwner$) !== creation ||
        get(model.intent$).selection !== intent.selection
      ) {
        throw cancelled();
      }
      set(creationOwner$, null);
      set(targetRevision$, (value) => {
        return value + 1;
      });
      set(model.resetAddress$);
      await set(get(links$).selectTab$, createdId, signal);
      return createdId;
    },
  );
}

function createCreationResumption(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { model, creationOwner$, clientState$, available$ } = context;
  return command(
    async (
      { get, set },
      creation: object,
      intent: ViewerIntent,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (
        get(creationOwner$) !== creation ||
        get(model.intent$).selection !== intent.selection ||
        !get(available$)
      ) {
        return;
      }
      const discovery = get(get(links$).discovery$);
      const client = get(clientState$);
      if (!discovery || !client) {
        return;
      }
      // The validation itself stays on the original wire; this observer may cancel.
      await set(discovery.refresh$, client.signal);
      signal.throwIfAborted();
      if (
        get(creationOwner$) !== creation ||
        get(model.intent$).selection !== intent.selection ||
        !get(available$)
      ) {
        return;
      }
      set(creationOwner$, null);
      await set(get(links$).restoreSelection$, signal);
    },
  );
}

function createTabCreationGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const {
    model,
    resetCreate$,
    clientState$,
    creationOwner$,
    assertAvailable$,
    creation$,
  } = context;
  const publish$ = createTabPublication(context, links$);
  const resume$ = createCreationResumption(context, links$);
  const creatingTab$ = computed((get) => {
    return get(creationOwner$) !== null;
  });
  const cancelCreation$ = command(({ get, set }, owner: object) => {
    if (get(creationOwner$) === owner) {
      set(resetCreate$);
      set(creationOwner$, null);
    }
  });
  const createTab$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<string> => {
      set(assertAvailable$, signal);
      if (!get(get(links$).canCreate$)) {
        throw cancelled();
      }
      const intent = get(model.intent$);
      const client = get(clientState$)!;
      const nativeCreation = get(creation$)!;
      const operation = set(resetCreate$, client.signal, signal);
      const creation = {};
      set(creationOwner$, creation);
      using _creation = {
        [Symbol.dispose]: () => {
          if (get(creationOwner$) === creation) {
            set(creationOwner$, null);
          }
        },
      };
      let createdId: string | null = null;
      const [result] = await Promise.allSettled([
        (async (): Promise<string> => {
          createdId = await set(nativeCreation.open$, operation);
          return set(
            publish$,
            createdId,
            {
              client,
              intent,
              creation,
            },
            signal,
          );
        })(),
      ]);
      if (signal.aborted) {
        if (createdId) {
          throw new CreatedTabFault(createdId, cancelled());
        }
        if (
          result.status === "rejected" &&
          result.reason instanceof CreatedTabFault
        ) {
          throw result.reason;
        }
        throw cancelled();
      }
      if (result.status === "fulfilled") {
        return result.value;
      }
      if (createdId === null) {
        // Rejected native opens never authorize publication of a merely known target ID.
        // Native invalidation may have retired Example while creation suppressed restore.
        const [resumed] = await Promise.allSettled([
          set(resume$, creation, intent, signal),
        ]);
        signal.throwIfAborted();
        if (resumed.status === "rejected" && isAbortError(resumed.reason)) {
          throw resumed.reason;
        }
      }
      if (createdId && !(result.reason instanceof CreatedTabFault)) {
        throw new CreatedTabFault(createdId, result.reason);
      }
      if (signal.aborted && !(result.reason instanceof CreatedTabFault)) {
        throw cancelled();
      }
      throw result.reason;
    },
  );
  return { cancelCreation$, createTab$, creatingTab$ };
}

function createTabClosingGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const {
    model,
    clientState$,
    targetRevision$,
    closingTargets$,
    assertAvailable$,
    directory$,
  } = context;
  const closeTab$ = command(
    async (
      { get, set },
      targetId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      set(assertAvailable$, signal);
      const snapshot = get(model.snapshot$);
      const index = snapshot.targets.findIndex((target) => {
        return target.id === targetId;
      });
      if (index === -1) {
        throw new CdpFault(
          "target-unavailable",
          "The tab is no longer available in this scope.",
        );
      }
      const selectionIntent = get(model.intent$).selection;
      const client = get(clientState$)!;
      const directory = get(directory$)!;
      const discovery = get(get(links$).discovery$)!;
      set(closingTargets$, new Set(get(closingTargets$)).add(targetId));
      using _closing = {
        [Symbol.dispose]: () => {
          const closing = new Set(get(closingTargets$));
          closing.delete(targetId);
          set(closingTargets$, closing);
          set(get(links$).discoveryChanged$, client.signal);
        },
      };
      await set(directory.assertMember$, targetId, signal);
      signal.throwIfAborted();
      set(assertAvailable$, signal);
      const receipt = await client.request(
        "Target.closeTarget",
        { targetId },
        undefined,
        undefined,
        signal,
      );
      if (!receipt.success) {
        throw new CdpFault("tab", "The browser did not close the tab.");
      }
      set(assertAvailable$, signal);
      set(model.inventoryUpdate$, { type: "retired", id: targetId });
      set(targetRevision$, (value) => {
        return value + 1;
      });
      set(model.update$, { error: null });
      if (
        get(model.selectedTabId$) === targetId &&
        get(model.intent$).selection === selectionIntent
      ) {
        const preceding = new Set(
          snapshot.targets.slice(0, index).map((target) => {
            return target.id;
          }),
        );
        const targets = get(model.snapshot$).targets;
        const next =
          targets.find((target) => {
            return !preceding.has(target.id);
          }) ?? targets.at(-1);
        if (next) {
          detach(
            set(get(links$).selectTab$, next.id, client.signal),
            Reason.DomCallback,
            "browser close successor",
          );
        } else {
          set(get(links$).retireCurrent$, "target-replaced", false);
          set(model.transition$, { type: "target-lost", error: null });
        }
      }
      set(discovery.removed$, targetId, client.signal);
      if (
        get(model.snapshot$).targets.some((target) => {
          return target.id === targetId;
        })
      ) {
        throw new CdpFault(
          "tab",
          "The closed tab inventory could not be confirmed.",
        );
      }
    },
  );
  return { closeTab$ };
}

function createTabsGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<
  ControllerLinks,
  "cancelCreation$" | "createTab$" | "creatingTab$" | "closeTab$"
> {
  return {
    ...createTabCreationGraph(context, links$),
    ...createTabClosingGraph(context, links$),
  };
}

function createCrashedPageReload(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { crashed$, clientState$, directory$, assertAvailable$ } = context;
  return command(
    async ({ get, set }, signal: AbortSignal): Promise<NavigationReceipt> => {
      set(assertAvailable$, signal);
      const crash = get(crashed$);
      if (!crash) {
        throw cancelled();
      }
      const targetId = crash.owner.targetId;
      const client = get(clientState$)!;
      const directory = get(directory$)!;
      const current = () => {
        signal.throwIfAborted();
        if (get(crashed$) !== crash) {
          throw cancelled();
        }
        set(assertAvailable$, signal);
      };
      // Never use a crash or a reload to erase unconfirmed original input effects.
      await set(get(links$).waitRetirement$, targetId, signal);
      current();
      await set(directory.assertMember$, targetId, signal);
      current();
      let sessionId: string | null = null;
      using _attachment = {
        [Symbol.dispose]: () => {
          if (sessionId) {
            client.notify("Target.detachFromTarget", { sessionId });
          }
        },
      };
      const attached: unknown = await client.request(
        "Target.attachToTarget",
        { targetId, flatten: true },
        undefined,
        (value) => {
          detachLateAttachment(client, value);
        },
        signal,
      );
      sessionId = attachmentSessionId(
        attached,
        "The browser returned an invalid recovery session.",
      );
      current();
      await set(directory.assertMember$, targetId, signal);
      current();
      // This is the user's explicit Reload, issued once. Reattachment alone
      // cannot revive a retained crashed renderer, and must not replay navigation.
      await client.request(
        "Page.reload",
        undefined,
        sessionId,
        undefined,
        signal,
      );
      current();
      client.notify("Target.detachFromTarget", { sessionId });
      sessionId = null;
      await set(get(links$).selectTab$, targetId, signal);
      return { kind: "ack" };
    },
  );
}

function createNavigationGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<
  ControllerLinks,
  "navigate$" | "navigation$" | "history$" | "navigationScope$"
> {
  const { assertAvailable$ } = context;
  const reloadCrashed$ = createCrashedPageReload(context, links$);
  const navigation$ = computed((get) => {
    const selected = get(get(links$).selectedSession$);
    return selected && get(selected.current$)
      ? get(selected.navigation.navigation$)
      : null;
  });
  const history$ = computed(async (get): Promise<ViewerHistory | null> => {
    const selected = get(get(links$).selectedSession$);
    return selected && get(selected.current$)
      ? await get(selected.navigation.history$)
      : null;
  });
  const navigationScope$ = computed((get) => {
    const selected = get(get(links$).selectedSession$);
    return selected && get(selected.current$)
      ? selected.navigation.scope
      : null;
  });
  const navigate$ = command(
    async (
      { get, set },
      navigation: NavigationAction,
      signal: AbortSignal,
    ): Promise<NavigationReceipt> => {
      set(assertAvailable$, signal);
      if (navigation === "reload" && get(context.crashed$)) {
        return await set(reloadCrashed$, signal);
      }
      const input = get(get(links$).input$);
      if (!input) {
        throw new CdpFault("input", "Remote input is unavailable.");
      }
      return await set(input.navigate$, navigation, signal);
    },
  );
  return { navigate$, navigation$, history$, navigationScope$ };
}

function createImageRetryGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "retryStartingGraph$" | "retryImage$"> {
  const {
    model,
    selectedOwner$,
    framesState$,
    wake$,
    assertAvailable$,
    nativeHost,
  } = context;
  const retryStartingGraph$ = computed((get) => {
    const selected = get(get(links$).selectedSession$);
    const image = get(model.imageRecovery$);
    if (!selected || !image) {
      return null;
    }
    return {
      selected,
      owner: image.owner,
      starting$: command(({ set }) => {
        set(model.transition$, { type: "image-starting", owner: image.owner });
      }),
    };
  });
  const retryImage$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      set(assertAvailable$, signal);
      const image = get(model.imageRecovery$);
      if (!image || (image.phase !== "ready" && image.phase !== "settling")) {
        throw new CdpFault("frame", "The live image is not ready to retry.");
      }
      const selected = get(get(links$).selectedSession$);
      if (
        !selected ||
        selected.attached.owner.targetId !== image.targetId ||
        selected.attached.frames !== get(framesState$)
      ) {
        await set(get(links$).waitRetirement$, image.targetId, signal);
        await set(get(links$).selectTab$, image.targetId, signal);
        return;
      }
      const abort = () => {
        if (get(selectedOwner$) === selected.attached.owner) {
          set(get(links$).retireCurrent$, "target-replaced", false);
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      using _abort = {
        [Symbol.dispose]: () => {
          signal.removeEventListener("abort", abort);
        },
      };
      const [result] = await Promise.allSettled([
        (async () => {
          await set(get(links$).waitRetirement$, image.targetId, signal);
          set(assertAvailable$, signal);
          const settled = get(model.imageRecovery$);
          if (settled?.owner !== image.owner || settled.phase !== "ready") {
            throw cancelled();
          }
          set(selected.failure$, null);
          set(selected.painted$, false);
          set(nativeHost.synchronize$);
          set(model.transition$, {
            type: "image-retrying",
            owner: image.owner,
          });
          const retry = get(retryStartingGraph$);
          if (
            !retry ||
            retry.selected !== selected ||
            retry.owner !== image.owner
          ) {
            throw cancelled();
          }
          await set(
            selected.stream.retry$,
            selected.prepareRetry$,
            retry.starting$,
            signal,
          );
          signal.throwIfAborted();
          if (!get(selected.current$)) {
            throw cancelled();
          }
          const decision = set(model.transition$, {
            type: "image-released",
            owner: image.owner,
          });
          if (decision?.resumeDisplay) {
            const display = get(get(links$).displayGraph$);
            if (display) {
              set(display.setSuspended$, false);
            }
          }
          set(wake$);
          await set(get(links$).waitReady$, selected.attached.owner, signal);
        })(),
      ]);
      signal.throwIfAborted();
      if (result.status === "rejected") {
        if (get(selected.current$)) {
          set(model.transition$, {
            type: "image-blocked",
            owner: image.owner,
            error: diagnostic(result.reason),
          });
        }
        set(wake$);
        if (signal.aborted) {
          throw cancelled();
        }
        throw result.reason;
      }
      signal.throwIfAborted();
    },
  );
  return { retryStartingGraph$, retryImage$ };
}

function createDisplaySettingsGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const {
    model,
    disposedState$,
    displaySize$,
    captureSize$,
    assertAvailable$,
  } = context;
  const changeCapture$ = command(
    async (
      { get, set },
      options: ViewerCaptureOptions,
      signal: AbortSignal,
    ): Promise<void> => {
      set(assertAvailable$, signal);
      set(model.setCapture$, capturePreferences(options));
      if (get(get(links$).selectedSession$)) {
        await set(get(links$).configureCapture$, signal);
      }
    },
  );
  const changeWindowSizeSync$ = command(
    async (
      { get, set },
      mode: WindowSizeSync,
      signal: AbortSignal,
    ): Promise<DisplayModeResult> => {
      set(assertAvailable$, signal);
      set(model.setWindowSizeSync$, mode);
      const display = get(get(links$).displayGraph$);
      if (!display) {
        throw cancelled();
      }
      const result = await set(display.changeMode$, mode, signal);
      set(assertAvailable$, signal);
      if (get(model.windowSizeSync$) !== mode) {
        throw cancelled();
      }
      return result;
    },
  );
  const measure$ = command(({ get, set }, size: DisplaySize | null) => {
    if (get(disposedState$)) {
      return;
    }
    set(displaySize$, size);
    const display = get(get(links$).displayGraph$);
    if (display) {
      set(display.measure$, size);
    }
    if (size && [size.width, size.height, size.dpr].every(positive)) {
      set(captureSize$, size);
      set(get(links$).scheduleCapture$);
    } else {
      set(get(links$).cancelCapture$);
    }
  });
  const syncDisplay$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      set(assertAvailable$, signal);
      const display = get(get(links$).displayGraph$);
      if (!display) {
        throw cancelled();
      }
      await set(display.syncDisplay$, signal);
      set(assertAvailable$, signal);
    },
  );
  return { changeCapture$, changeWindowSizeSync$, measure$, syncDisplay$ };
}

function createSelectionSettingsGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const {
    model,
    authority$,
    disposedState$,
    chosenOnce$,
    selectedOwner$,
    available$,
    readinessFailure$,
  } = context;
  const restore$: ControllerLinks["reconcileSelection$"] = command(
    async ({ get, set }, signal: AbortSignal): Promise<SelectionOutcome> => {
      if (!get(available$)) {
        return "ready";
      }
      if (get(context.crashed$)) {
        set(model.transition$, {
          type: "failed",
          error: {
            kind: "target-crashed",
            message: "The selected browser page crashed.",
          },
        });
        return "ready";
      }
      const targetId = get(model.selectedTabId$);
      if (
        targetId &&
        get(model.snapshot$).targets.some((target) => {
          return target.id === targetId;
        })
      ) {
        return set(get(links$).select$, targetId, signal);
      }
      const discovery = get(get(links$).discovery$);
      if (discovery) {
        await set(discovery.refresh$, get(context.clientState$)!.signal);
        signal.throwIfAborted();
      }
      const owner = get(selectedOwner$);
      if (owner) {
        return set(get(links$).waitSelection$, owner, signal);
      }
      const first = get(model.snapshot$).targets[0];
      if (first && !get(chosenOnce$)) {
        return set(get(links$).select$, first.id, signal);
      }
      return "ready";
    },
  );
  const reconcileSelection$: ControllerLinks["reconcileSelection$"] = command(
    async ({ get, set }, signal: AbortSignal): Promise<SelectionOutcome> => {
      signal.throwIfAborted();
      if (get(context.crashed$)) {
        return "ready";
      }
      const failure = get(readinessFailure$);
      if (failure) {
        throw failure;
      }
      const owner = get(selectedOwner$);
      return await (owner
        ? set(get(links$).waitSelection$, owner, signal)
        : set(restore$, signal));
    },
  );
  const restoreSelection$: ControllerLinks["restoreSelection$"] = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      const outcome = await set(restore$, signal);
      signal.throwIfAborted();
      if (outcome === "superseded") {
        throw cancelled();
      }
    },
  );
  const pause$ = command(
    async (
      { get, set },
      paused: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (get(disposedState$)) {
        throw cancelled();
      }
      if (get(model.intent$).paused === paused) {
        return;
      }
      set(get(links$).retireCurrent$, "paused", false);
      set(model.transition$, { type: "pause", paused });
      const display = get(get(links$).displayGraph$);
      if (display) {
        set(display.setSuspended$, paused || !get(authority$));
      }
      if (!paused) {
        await set(restoreSelection$, signal);
      }
      signal.throwIfAborted();
    },
  );
  return { reconcileSelection$, restoreSelection$, pause$ };
}

function createAuthoritySettingsGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { model, authority$, disposedState$, authorityRevoked$, wake$ } =
    context;
  // Retirement writes its releases synchronously. Reattaching a target still
  // waits for that target's own retirement; revocation never does.
  const revokeAuthority$ = command(({ get, set }) => {
    if (get(disposedState$)) {
      return;
    }
    set(authorityRevoked$, true);
    set(get(links$).retireCurrent$, "target-replaced", true);
    const display = get(get(links$).displayGraph$);
    if (display) {
      set(display.setSuspended$, true);
    }
    set(wake$);
  });
  const refreshAuthority$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (!get(authority$)) {
        set(revokeAuthority$);
        return;
      }
      if (get(disposedState$)) {
        throw cancelled();
      }
      if (!get(authorityRevoked$)) {
        return;
      }
      set(authorityRevoked$, false);
      const display = get(get(links$).displayGraph$);
      if (display) {
        set(display.setSuspended$, get(model.intent$).paused);
      }
      await set(get(links$).restoreSelection$, signal);
    },
  );
  return { revokeAuthority$, refreshAuthority$ };
}

function createSettingsGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<
  ControllerLinks,
  | "changeCapture$"
  | "changeWindowSizeSync$"
  | "measure$"
  | "syncDisplay$"
  | "restoreSelection$"
  | "reconcileSelection$"
  | "pause$"
  | "revokeAuthority$"
  | "refreshAuthority$"
  | "rejectFavicon$"
> {
  const { model } = context;
  const display = createDisplaySettingsGraph(context, links$);
  const selection = createSelectionSettingsGraph(context, links$);
  const authority = createAuthoritySettingsGraph(context, links$);
  const rejectFavicon$ = command(
    ({ set }, targetId: string, iconUrl: string) => {
      set(model.rejectFavicon$, targetId, iconUrl);
    },
  );
  return { ...display, ...selection, ...authority, rejectFavicon$ };
}

function createDisposalGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "dispose$" | "beginClosing$" | "waitForClosed$"> {
  const {
    model,
    resetOwner$,
    sink,
    clientState$,
    nativeState$,
    framesState$,
    connectedState$,
    disposedState$,
    disconnectingState$,
    readinessFailure$,
    closingState$,
    closedState$,
    retirements$,
    wake$,
    waitEvent$,
  } = context;
  const resetClosing$ = resetSignal();
  const closeTransport$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const [result] = await Promise.allSettled([
        (async () => {
          // Retirement wrote its input releases when it began, so detaching
          // now follows them on the wire. The peer can vanish at any moment, so
          // closing never waits for their acknowledgement.
          for (const retirement of get(retirements$).values()) {
            if (!retirement.receipts) {
              set(get(links$).detachAttached$, retirement.session.attached);
            }
          }
          // Revoke native observers before terminating the original sockets.
          // Bootstrap and bridge cleanup may both be waiting on this failing
          // peer; closing the wire rejects those waits and releases its CDP
          // sessions without closing any remote tab or window.
          const failure = get(readinessFailure$);
          const fault =
            get(disconnectingState$) && failure instanceof CdpFault
              ? failure
              : undefined;
          const nativeClosed = get(nativeState$)?.close();
          get(framesState$)?.close(fault);
          get(clientState$)?.close(fault);
          await nativeClosed;
        })(),
      ]);
      signal.throwIfAborted();
      // The ended sockets have rejected their pending receipts. Let native
      // cleanup settle before aborting their owner, preserving those failures.
      set(resetOwner$, AbortSignal.abort());
      // Publish only after local retirement, never after a peer acknowledgement.
      set(closedState$, result);
      set(wake$);
      set(resetClosing$, AbortSignal.abort());
    },
  );
  const beginClosing$ = command(({ get, set }) => {
    if (get(closingState$)) {
      return;
    }
    set(closingState$, true);
    const signal = set(resetClosing$);
    detach(
      set(closeTransport$, signal),
      Reason.DomCallback,
      "browser original transport retirement",
    );
  });
  const dispose$: Command<void, []> = command(({ get, set }) => {
    if (get(disposedState$)) {
      return;
    }
    set(disposedState$, true);
    set(get(links$).retireCurrent$, "disposed", false);
    const display = get(get(links$).displayGraph$);
    if (display) {
      set(display.close$);
    }
    const discovery = get(get(links$).discovery$);
    if (discovery) {
      set(discovery.close$);
    }
    set(connectedState$, false);
    set(model.transition$, { type: "closed" });
    sink.dispose();
    set(wake$);
    set(beginClosing$);
  });
  const waitForClosed$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      while (true) {
        signal.throwIfAborted();
        const result = get(closedState$);
        if (result?.status === "fulfilled") {
          return;
        }
        if (result?.status === "rejected") {
          throw result.reason;
        }
        await set(waitEvent$, signal);
      }
    },
  );
  return { dispose$, beginClosing$, waitForClosed$ };
}

/** Compose static domain graphs, never a Store or accessor facade. */
export function createBrowserController(
  model: ViewerSignals,
  connection: BrowserConnection,
  canvas: HTMLCanvasElement,
  authority$: Computed<boolean>,
  nativeHost: NativeInputHost,
) {
  const context = createControllerState(
    model,
    connection,
    canvas,
    authority$,
    nativeHost,
  );
  const links$: Computed<ControllerLinks> = computed(() => {
    return graph;
  });
  const discovery = createDiscoveryGraph(context, links$);
  const captureRecovery = createCaptureRecoveryGraph(context, links$);
  const selectedSessions = createSelectedSessionsGraph(context, links$);
  const display = createDisplayGraph(context, links$);
  const capture = createCaptureGraph(context, links$);
  const retirements = createRetirementsGraph(context, links$);
  const readiness = createReadinessGraph(context, links$);
  const attachment = createAttachmentGraph(context, links$);
  const selection = createSelectionGraph(context, links$);
  const favicon = createFaviconGraph(context, links$);
  const events = createEventsGraph(context, links$);
  const framesConnection = createFramesConnectionGraph(context, links$);
  const connectionActions = createConnectionGraph(context, links$);
  const tabs = createTabsGraph(context, links$);
  const navigation = createNavigationGraph(context, links$);
  const imageRetry = createImageRetryGraph(context, links$);
  const settings = createSettingsGraph(context, links$);
  const disposal = createDisposalGraph(context, links$);
  const graph: ControllerLinks = {
    ...discovery,
    ...captureRecovery,
    ...selectedSessions,
    ...display,
    ...capture,
    ...retirements,
    ...readiness,
    ...attachment,
    ...selection,
    ...favicon,
    ...events,
    ...framesConnection,
    ...connectionActions,
    ...tabs,
    ...navigation,
    ...imageRetry,
    ...settings,
    ...disposal,
  };
  return {
    start$: graph.start$,
    dispose$: graph.dispose$,
    waitForClosed$: graph.waitForClosed$,
    selectTab$: graph.selectTab$,
    createTab$: graph.createTab$,
    creatingTab$: graph.creatingTab$,
    closeTab$: graph.closeTab$,
    navigate$: graph.navigate$,
    retryImage$: graph.retryImage$,
    changeCapture$: graph.changeCapture$,
    changeWindowSizeSync$: graph.changeWindowSizeSync$,
    syncDisplay$: graph.syncDisplay$,
    measure$: graph.measure$,
    pause$: graph.pause$,
    revokeAuthority$: graph.revokeAuthority$,
    refreshAuthority$: graph.refreshAuthority$,
    rejectFavicon$: graph.rejectFavicon$,
    input$: graph.input$,
    canCreate$: graph.canCreate$,
    navigation$: graph.navigation$,
    history$: graph.history$,
    navigationScope$: graph.navigationScope$,
    display$: graph.display$,
    displayRecovery$: graph.displayRecovery$,
  };
}
