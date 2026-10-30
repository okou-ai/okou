import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import {
  createDeferredPromise,
  detach,
  isAbortError,
  Reason,
  resetSignal,
  scheduleTimeout,
} from "../../utils.ts";
import {
  createCdpClient,
  type CdpClient,
  type CdpEvent,
} from "../cdp/client.ts";
import {
  CdpFault,
  diagnostic,
  isRecord,
  validateConfiguration,
} from "../cdp/errors.ts";
import { createTargetDirectory, type TargetDirectory } from "../cdp/targets.ts";
import { CreatedTabFault, openTab } from "../cdp/tabs.ts";
import { createInputSession } from "../input/session.ts";
import { navigationAddress } from "../input/address.ts";
import type { InputStop } from "../input/lifecycle.ts";
import {
  positive,
  type DisplaySize,
  type Viewport,
} from "../display/geometry.ts";
import { createDisplayViewport } from "../display/viewport.ts";
import { createDisplaySync, type DisplayState } from "../display/sync.ts";
import { captureBoundary } from "../display/capture-boundary.ts";
import { createCanvasRenderer, type FrameSink } from "../render/canvas.ts";
import type { ViewerSignals } from "./model.ts";
import type { ViewerIntent } from "./lifecycle.ts";
import type {
  BrowserConnection,
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

interface SelectionOwner {
  readonly targetId: string;
}
interface AttachedSelection {
  readonly owner: SelectionOwner;
  readonly client: CdpClient;
  readonly frames: CdpClient;
  readonly sessionId: string;
  readonly frameSessionId: string;
  readonly settings: CaptureSettings;
}
interface FaviconDocument {
  readonly wanted: boolean;
  readonly waiting: boolean;
  readonly ready: boolean;
}
interface Retirement {
  readonly owner: object;
  readonly session: SelectedSession;
  readonly phase: "pending" | "blocked";
  readonly error?: unknown;
}
interface CaptureChange {
  readonly settings: CaptureSettings;
  readonly first: number;
  readonly last: number;
}
type Navigation = "back" | "forward" | "reload" | { url: string };
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
  const { sink, directory, settings$, failed$, started$ } = host;
  const frameLease = createFrameLease(sink);
  const geometry = createDisplayViewport();
  const input = createInputSession(
    attached.client,
    attached.sessionId,
    current$,
    geometry,
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
      await directory.assertMember(attached.owner.targetId);
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
      await directory.assertMember(attached.owner.targetId);
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
    painted$,
    captureFailed$,
  });
  return {
    attached,
    current$,
    geometry,
    input,
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
  readonly painted$: State<boolean>;
  readonly captureFailed$: Command<Promise<void>, [unknown, AbortSignal]>;
}
type RefreshIntent = { readonly prepare$: Command<Promise<void>, []> };

function createSessionRestart(
  nodes: SessionRefreshNodes,
  refreshIntent$: State<RefreshIntent | null>,
) {
  const { attached, current$, settings$, stream, painted$, captureFailed$ } =
    nodes;
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
        await set(stream.begin$, get(settings$), !get(painted$), signal);
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
            await set(stream.begin$, get(settings$), !get(painted$), signal);
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
  readonly displayFailed$: Command<void, [CdpFault]>;
  readonly displaySynchronized$: Command<void, []>;
  readonly displayGraph$: Computed<ReturnType<typeof createDisplaySync> | null>;
  readonly display$: Computed<DisplayState>;
  readonly input$: Computed<ReturnType<typeof createInputSession> | null>;
  readonly navigation$: Computed<import("./types.ts").ViewerNavigation | null>;
  readonly cancelCapture$: Command<void, []>;
  readonly configureCapture$: Command<Promise<void>, [AbortSignal]>;
  readonly scheduleCapture$: Command<void, []>;
  readonly waitRetirement$: Command<Promise<void>, [string, AbortSignal]>;
  readonly detachAttached$: Command<void, [AttachedSelection]>;
  readonly finishRetirement$: Command<
    Promise<void>,
    [SelectedSession, Retirement, InputStop, AbortSignal]
  >;
  readonly retireCurrent$: Command<void, [InputStop, boolean]>;
  readonly streaming$: Command<void, [SelectedSession]>;
  readonly waitReady$: Command<Promise<void>, [SelectionOwner, AbortSignal]>;
  readonly attach$: Command<Promise<void>, [SelectionOwner, AbortSignal]>;
  readonly selectTab$: Command<Promise<void>, [string, AbortSignal]>;
  readonly refreshFavicon$: Command<
    Promise<void>,
    [SelectedSession, AbortSignal]
  >;
  readonly event$: Command<Promise<void>, [CdpEvent, CdpClient, AbortSignal]>;
  readonly followActiveTarget$: Command<Promise<void>, [string, AbortSignal]>;
  readonly disconnected$: Command<void, [CdpFault, CdpClient]>;
  readonly start$: Command<Promise<void>, [AbortSignal]>;
  readonly cancelCreation$: Command<void, [object]>;
  readonly createTab$: Command<Promise<string>, [AbortSignal]>;
  readonly closeTab$: Command<Promise<void>, [string, AbortSignal]>;
  readonly navigate$: Command<Promise<void>, [Navigation, AbortSignal]>;
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
    Promise<void>,
    [WindowSizeSync, AbortSignal]
  >;
  readonly measure$: Command<void, [DisplaySize | null]>;
  readonly syncDisplay$: Command<Promise<void>, [AbortSignal]>;
  readonly restoreSelection$: Command<Promise<void>, [AbortSignal]>;
  readonly pause$: Command<Promise<void>, [boolean, AbortSignal]>;
  readonly revokeAuthority$: Command<Promise<void>, [AbortSignal]>;
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
  const framesState$ = state<CdpClient | null>(null);
  const connectedState$ = state(false);
  const disposedState$ = state(false);
  const startedState$ = state(false);
  const bootstrapping$ = state(true);
  const chosenOnce$ = state(false);
  const selectedOwner$ = state<SelectionOwner | null>(null);
  const attachedState$ = state<AttachedSelection | null>(null);
  const retirements$ = state<ReadonlyMap<string, Retirement>>(new Map());
  const wakeListeners$ = state<ReadonlySet<() => void>>(new Set());
  const displaySize$ = state<DisplaySize | null>(null);
  const captureSize$ = state<DisplaySize | null>(null);
  const captureStartedState$ = state<CaptureSettings | null>(null);
  const captureUpdated$ = state(-Infinity);
  const captureChange$ = state<CaptureChange | null>(null);
  const captureDeadline$ = state<(() => void) | null>(null);
  const displayError$ = state<ViewerError | null>(null);
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
    framesState$,
    connectedState$,
    disposedState$,
    startedState$,
    bootstrapping$,
    chosenOnce$,
    selectedOwner$,
    attachedState$,
    retirements$,
    wakeListeners$,
    displaySize$,
    captureSize$,
    captureStartedState$,
    captureUpdated$,
    captureChange$,
    captureDeadline$,
    displayError$,
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
    return client
      ? createTargetDirectory(client, connection.windowId ?? undefined)
      : null;
  });
  return {
    model,
    connection,
    authority$,
    ...atoms,
    connected$,
    available$,
    settings$,
    capturePending$,
    wake$,
    waitEvent$,
    assertAvailable$,
    directory$,
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
    connection,
    bootstrapping$,
    chosenOnce$,
    readinessFailure$,
    closingTargets$,
    connected$,
    available$,
    wake$,
    directory$,
  } = context;
  const discoveryFailed$ = command(
    ({ get, set }, error: unknown, signal: AbortSignal): void => {
      if (signal.aborted || !get(connected$)) {
        return;
      }
      set(readinessFailure$, error);
      set(get(links$).retireCurrent$, "target-replaced", false);
      set(model.transition$, {
        type: "discovery-failed",
        error: diagnostic(error),
      });
      set(wake$);
    },
  );
  const discoveryChanged$ = command(
    ({ get, set }, signal: AbortSignal): void => {
      if (signal.aborted || !get(connected$)) {
        return;
      }
      const snapshot = get(model.snapshot$);
      const selected = snapshot.selectedTargetId;
      if (
        selected &&
        !snapshot.targets.some((target) => {
          return target.id === selected;
        }) &&
        !get(closingTargets$).has(selected)
      ) {
        set(get(links$).retireCurrent$, "target-replaced", false);
        set(model.transition$, {
          type: "target-lost",
          error: diagnostic(
            new CdpFault(
              "target-unavailable",
              "The selected target is no longer available in this scope.",
            ),
          ),
        });
      } else if (
        !selected &&
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
      } else if (!selected && !snapshot.targets.length) {
        set(model.transition$, { type: "target-lost", error: null });
      }
      set(wake$);
    },
  );
  const discovery$ = computed((get) => {
    const directory = get(directory$);
    return directory
      ? createTargetDiscovery(
          directory,
          {
            inventoryState$: model.inventoryState$,
            snapshot$: model.snapshot$,
            inventory$: model.inventoryUpdate$,
          },
          {
            scoped:
              connection.windowId !== null && connection.windowId !== undefined,
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
  const {
    model,
    sink,
    disposedState$,
    retirements$,
    readinessFailure$,
    wake$,
  } = context;
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
        set(get(links$).retireCurrent$, "target-replaced", false);
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
        phase: "pending",
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
      set(wake$);
      const cleanups = await Promise.allSettled([
        set(selected.input.suspend$, selected.attached.client.signal),
        set(selected.stream.quiesce$, selected.attached.frames.signal),
        ...(display
          ? [set(display.waitForIdle$, selected.attached.client.signal)]
          : []),
      ]);
      signal.throwIfAborted();
      const cleanup = cleanups.find(
        (receipt): receipt is PromiseRejectedResult => {
          return receipt.status === "rejected";
        },
      );
      // Cleanup receipts are published before the finite resource operation ends.
      if (get(retirements$).get(owner.targetId) === retirement) {
        const next = new Map(get(retirements$));
        if (!cleanup) {
          next.delete(owner.targetId);
        } else {
          next.set(owner.targetId, {
            ...retirement,
            phase: "blocked",
            error: cleanup.reason,
          });
        }
        set(retirements$, next);
      }
      if (!get(disposedState$)) {
        set(model.transition$, {
          type: "image-settled",
          owner: recoveryOwner,
          ready: !cleanup,
        });
      }
      set(wake$);
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
    connection,
    sink,
    selectedOwner$,
    attachedState$,
    captureStartedState$,
    captureUpdated$,
    available$,
    settings$,
    directory$,
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
        get(discovery.active$) &&
        (connection.windowId === null ||
          connection.windowId === undefined ||
          get(discovery.selectedTargetId$) === attached.owner.targetId)
      );
    });
    return createSelectedSession(attached, current$, {
      sink,
      directory,
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
  | "displayFailed$"
  | "displaySynchronized$"
  | "displayGraph$"
  | "display$"
  | "input$"
  | "navigation$"
> {
  const {
    model,
    connection,
    clientState$,
    displayError$,
    connected$,
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
  const displayFailed$ = command(({ get, set }, error: CdpFault) => {
    if (!get(connected$)) {
      return;
    }
    const fault = diagnostic(error);
    set(displayError$, fault);
    set(model.update$, { error: fault });
    set(get(links$).scheduleCapture$);
  });
  const displaySynchronized$ = command(({ get, set }) => {
    const error = get(displayError$);
    if (error && get(model.snapshot$).error === error) {
      set(model.update$, { error: null });
    }
    set(displayError$, null);
    set(get(links$).scheduleCapture$);
  });
  const displayGraph$ = computed((get) => {
    const client = get(clientState$);
    return client
      ? createDisplaySync(client, {
          windowId: connection.windowId ?? null,
          capturePending$,
          refresh$: refreshCapture$,
          failed$: displayFailed$,
          synchronized$: displaySynchronized$,
        })
      : null;
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
  const navigation$ = computed((get) => {
    const selected = get(get(links$).selectedSession$);
    return selected && get(selected.current$)
      ? (get(selected.input.navigation$) ??
          get(model.snapshot$).navigation ??
          null)
      : null;
  });
  return {
    refreshCapture$,
    displayFailed$,
    displaySynchronized$,
    displayGraph$,
    display$,
    input$,
    navigation$,
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
    captureDeadline$,
    settings$,
    capturePending$,
    assertAvailable$,
  } = context;
  const cancelCapture$ = command(({ get, set }) => {
    get(captureDeadline$)?.();
    set(captureDeadline$, null);
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
      get(captureDeadline$)
    ) {
      return;
    }
    const change = { settings, first: previous?.first ?? now, last: now };
    set(captureChange$, change);
    get(captureDeadline$)?.();
    const deadline = Math.max(
      get(captureUpdated$) + 150,
      Math.min(change.last + 200, change.first + 1000),
    );
    const cancel = scheduleTimeout(
      () => {
        if (get(captureDeadline$) !== cancel) {
          return;
        }
        set(captureDeadline$, null);
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
      selected.attached.frames.signal,
    );
    set(captureDeadline$, () => {
      return cancel;
    });
  });
  return { cancelCapture$, configureCapture$, scheduleCapture$ };
}

function createRetirementReceiptsGraph(context: ControllerContext) {
  const { model, disposedState$, retirements$, wake$, waitEvent$ } = context;
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
        if (fence.phase === "blocked") {
          throw (
            fence.error ??
            new CdpFault(
              "input",
              "The previous input or capture cleanup could not be confirmed.",
            )
          );
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
      const targetId = selected.attached.owner.targetId;
      const receipts = await Promise.allSettled([
        set(
          selected.input.retire$,
          reason === "disconnected" ? "disposed" : reason,
          selected.attached.client.signal,
        ),
        set(selected.stream.dispose$, selected.attached.frames.signal),
      ]);
      signal.throwIfAborted();
      const result = receipts.find(
        (receipt): receipt is PromiseRejectedResult => {
          return receipt.status === "rejected";
        },
      );
      set(detachAttached$, selected.attached);
      if (get(retirements$).get(targetId) === retirement) {
        const fences = new Map(get(retirements$));
        if (!result) {
          fences.delete(targetId);
        } else {
          fences.set(targetId, {
            ...retirement,
            phase: "blocked",
            error: result.reason,
          });
        }
        set(retirements$, fences);
      }
      const image = get(model.imageRecovery$);
      if (!get(disposedState$) && image?.owner === retirement.owner) {
        set(model.transition$, {
          type: "image-settled",
          owner: image.owner,
          ready: !result,
        });
      }
      set(wake$);
      signal.throwIfAborted();
    },
  );
  return { waitRetirement$, detachAttached$, finishRetirement$ };
}

function createRetirementsGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<
  ControllerLinks,
  "waitRetirement$" | "detachAttached$" | "finishRetirement$" | "retireCurrent$"
> {
  const {
    model,
    resetSelection$,
    resetCreate$,
    sink,
    clientState$,
    disposedState$,
    selectedOwner$,
    attachedState$,
    retirements$,
    captureStartedState$,
    creationOwner$,
    wake$,
  } = context;
  const receipts = createRetirementReceiptsGraph(context);
  const retireCurrent$: Command<void, [InputStop, boolean]> = command(
    ({ get, set }, reason: InputStop, retainFrame: boolean) => {
      const selected = get(get(links$).selectedSession$);
      if (selected) {
        const image = get(model.imageRecovery$);
        const fence: Retirement = {
          owner: image?.owner ?? {},
          session: selected,
          phase: "pending",
        };
        const previous = get(retirements$).get(
          selected.attached.owner.targetId,
        );
        if (previous?.phase !== "blocked") {
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
      set(resetCreate$);
      set(creationOwner$, null);
      set(selectedOwner$, null);
      set(attachedState$, null);
      set(captureStartedState$, null);
      set(get(links$).cancelCapture$);
      const discovery = get(get(links$).discovery$);
      const client = get(clientState$);
      if (discovery && client) {
        set(discovery.watch$, null, client.signal);
      }
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
      set(wake$);
    },
  );
  return { ...receipts, retireCurrent$ };
}

function createReadinessGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "streaming$" | "waitReady$"> {
  const {
    model,
    selectedOwner$,
    readinessFailure$,
    available$,
    wake$,
    waitEvent$,
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
    set(model.update$, { navigation: get(selected.input.navigation$) });
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
  return { streaming$, waitReady$ };
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

function createAttachmentAdmission(context: ControllerContext) {
  const { selectedOwner$, available$ } = context;
  return command(({ get }, owner: SelectionOwner, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(available$) || get(selectedOwner$) !== owner) {
      throw cancelled();
    }
  });
}

function createAttachmentInitialization(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
  assertCurrent$: Command<void, [SelectionOwner, AbortSignal]>,
) {
  const { wake$ } = context;
  return command(
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
}

function createAttachmentGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "attach$"> {
  const { clientState$, framesState$, attachedState$, settings$, directory$ } =
    context;
  const assertCurrent$ = createAttachmentAdmission(context);
  const initialize$ = createAttachmentInitialization(
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
      const frames = get(framesState$)!;
      const directory = get(directory$)!;
      await set(get(links$).waitRetirement$, owner.targetId, signal);
      set(assertCurrent$, owner, signal);
      await directory.assertMember(owner.targetId);
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
      await directory.assertMember(owner.targetId);
      signal.throwIfAborted();
      set(assertCurrent$, owner, signal);
      let sessionId: string | null = null;
      let frameSessionId: string | null = null;
      let published = false;
      using _unpublished = {
        [Symbol.dispose]: () => {
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
      if (frames === client) {
        frameSessionId = sessionId;
      } else {
        await directory.assertMember(owner.targetId);
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
      }
      await directory.assertMember(owner.targetId);
      signal.throwIfAborted();
      set(assertCurrent$, owner, signal);
      await client.request(
        "Page.enable",
        undefined,
        sessionId,
        undefined,
        signal,
      );
      set(assertCurrent$, owner, signal);
      const selection: AttachedSelection = {
        owner,
        client,
        frames,
        sessionId,
        frameSessionId,
        settings: get(settings$),
      };
      set(attachedState$, selection);
      published = true;
      return set(initialize$, selection, signal);
    },
  );
  return { attach$ };
}

function createSelectionGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "selectTab$"> {
  const {
    model,
    resetSelection$,
    clientState$,
    disposedState$,
    chosenOnce$,
    selectedOwner$,
    extensionRevision$,
    readinessFailure$,
    wake$,
    assertAvailable$,
  } = context;
  const selectTab$: Command<Promise<void>, [string, AbortSignal]> = command(
    async (
      { get, set },
      targetId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      set(assertAvailable$, signal);
      if (
        !get(model.snapshot$).targets.some((target) => {
          return target.id === targetId;
        })
      ) {
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
        return;
      }
      set(chosenOnce$, true);
      set(extensionRevision$, (value) => {
        return value + 1;
      });
      const preview =
        get(model.presentation$).status === "streaming" ||
        get(model.presentation$).loadingPreview;
      set(get(links$).retireCurrent$, "target-replaced", preview);
      set(readinessFailure$, null);
      set(model.transition$, {
        type: "select",
        targetId,
        paused: false,
        preview,
      });
      const owner: SelectionOwner = { targetId };
      set(selectedOwner$, owner);
      const client = get(clientState$)!;
      const operation = set(resetSelection$, client.signal, signal);
      const discovery = get(get(links$).discovery$);
      if (discovery) {
        set(discovery.watch$, targetId, client.signal);
      }
      const abort = () => {
        if (get(selectedOwner$) === owner) {
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
          await set(get(links$).attach$, owner, operation);
          await set(get(links$).waitReady$, owner, operation);
        })(),
      ]);
      signal.throwIfAborted();
      if (result.status === "fulfilled") {
        signal.throwIfAborted();
        return;
      }
      if (get(selectedOwner$) === owner && !get(disposedState$)) {
        const selected = get(get(links$).selectedSession$);
        if (selected && get(model.imageRecovery$)) {
          set(selected.failure$, result.reason);
          set(wake$);
        } else {
          set(get(links$).retireCurrent$, "target-replaced", false);
          if (!isAbortError(result.reason)) {
            set(model.transition$, {
              type: "failed",
              error: diagnostic(result.reason),
            });
          }
        }
      }
      if (signal.aborted || operation.aborted) {
        throw cancelled();
      }
      throw result.reason;
    },
  );
  return { selectTab$ };
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

function documentEventUrl(event: CdpEvent): string | null {
  const params = event.params;
  if (
    event.method === "Page.frameNavigated" &&
    isRecord(params.frame) &&
    !params.frame.parentId &&
    typeof params.frame.url === "string"
  ) {
    return params.frame.url;
  }
  if (
    event.method === "Page.navigatedWithinDocument" &&
    typeof params.url === "string"
  ) {
    return params.url;
  }
  return null;
}

function createSessionEvent(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { model } = context;
  return command(({ get, set }, event: CdpEvent, selected: SelectedSession) => {
    set(selected.geometry.event$, event.method);
    set(selected.input.event$, event);
    const inputError = get(selected.input.error$);
    const navigation = get(selected.input.navigation$);
    set(model.update$, {
      ...(navigation ? { navigation } : {}),
      ...(inputError ? { error: diagnostic(inputError) } : {}),
    });
    const params = event.params;
    const documentUrl = documentEventUrl(event);
    if (documentUrl !== null) {
      const previous = get(model.navigation$);
      set(model.update$, {
        navigation: {
          url: documentUrl,
          canGoBack: previous?.canGoBack ?? false,
          canGoForward: previous?.canGoForward ?? false,
        },
      });
    }
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
  const { model, closingTargets$ } = context;
  return command(
    (
      { get, set },
      event: CdpEvent,
      source: CdpClient,
      selected: SelectedSession,
    ) => {
      const expected =
        source === selected.attached.client
          ? selected.attached.sessionId
          : selected.attached.frameSessionId;
      if (
        event.params.sessionId === expected &&
        !get(closingTargets$).has(selected.attached.owner.targetId)
      ) {
        set(get(links$).retireCurrent$, "target-replaced", false);
        set(model.transition$, {
          type: "target-lost",
          error: diagnostic(
            new CdpFault("target-unavailable", "The selected target detached."),
          ),
        });
      }
    },
  );
}

function createVideoLossCleanup(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const { clientState$, retirements$ } = context;
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const original = get(clientState$);
    using _original = {
      [Symbol.dispose]: () => {
        original?.close();
      },
    };
    await Promise.allSettled(
      [...get(retirements$).keys()].map((targetId) => {
        return set(get(links$).waitRetirement$, targetId, signal);
      }),
    );
    signal.throwIfAborted();
  });
}

function createProtocolEventDispatch(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
  followActiveTarget$: ControllerLinks["followActiveTarget$"],
) {
  const { clientState$, disposedState$, retirements$, targetRevision$, wake$ } =
    context;
  const detachedEvent$ = createDetachedEvent(context, links$);
  const sessionEvent$ = createSessionEvent(context, links$);
  const screencastEvent$ = createScreencastEvent(context, links$);
  return command(
    async (
      { get, set },
      event: CdpEvent,
      source: CdpClient,
      signal: AbortSignal,
    ): Promise<void> => {
      if (get(disposedState$)) {
        return;
      }
      const selected = get(get(links$).selectedSession$);
      for (const retirement of get(retirements$).values()) {
        const original = retirement.session;
        if (
          original !== selected &&
          source === original.attached.client &&
          event.sessionId === original.attached.sessionId
        ) {
          set(original.input.event$, event);
        }
      }
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
      if (event.method === "Target.detachedFromTarget" && selected) {
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
          await get(directory$)!.assertMember(targetId);
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
    readinessFailure$,
    wake$,
  } = context;
  const videoLossCleanup$ = createVideoLossCleanup(context, links$);
  return command(({ get, set }, fault: CdpFault, source: CdpClient) => {
    if (get(disposedState$)) {
      return;
    }
    const established = get(connectedState$);
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
    if (source === get(clientState$)) {
      get(framesState$)?.close();
    } else {
      const original = get(clientState$);
      if (original) {
        detach(
          set(videoLossCleanup$, original.signal),
          Reason.DomCallback,
          "browser original control cleanup after video loss",
        );
      }
    }
  });
}

function createEventsGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "event$" | "followActiveTarget$" | "disconnected$"> {
  const followActiveTarget$ = createActiveTargetFollowing(context, links$);
  const event$ = createProtocolEventDispatch(
    context,
    links$,
    followActiveTarget$,
  );
  const disconnected$ = createDisconnectionHandling(context, links$);
  return { event$, followActiveTarget$, disconnected$ };
}

function createConnectionBootstrap(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const {
    model,
    connection,
    authority$,
    resetOwner$,
    clientState$,
    framesState$,
    connectedState$,
    bootstrapping$,
    displaySize$,
    readinessFailure$,
    assertAvailable$,
  } = context;
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    validateConfiguration(connection.cdpUrl, connection.windowId ?? undefined);
    const transport = get(model.transport$);
    if (transport !== "shared" && transport !== "split") {
      throw new CdpFault("configuration", "The transport mode is invalid.");
    }
    set(
      model.configure$,
      connection.windowId !== null && connection.windowId !== undefined,
    );
    const lifetime = set(resetOwner$, signal);
    const client = createCdpClient(connection.cdpUrl, lifetime);
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
      const frames = createCdpClient(connection.cdpUrl, lifetime);
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
    }
    await Promise.all([client.opened, get(framesState$)!.opened]);
    signal.throwIfAborted();
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
    detach(
      set(display.start$, client.signal),
      Reason.Daemon,
      "browser automatic display synchronization",
    );
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
      await set(get(links$).selectTab$, first.id, signal);
    } else {
      set(model.transition$, { type: "target-lost", error: null });
    }
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
      const [result] = await Promise.allSettled([set(bootstrap$, signal)]);
      signal.throwIfAborted();
      set(bootstrapping$, false);
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
  readonly directory: TargetDirectory;
  readonly source: SelectedSession | null;
  readonly sourceDocument: number | undefined;
  readonly intent: ViewerIntent;
  readonly creation: object;
  readonly unwatch: () => void;
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
      const {
        client,
        directory,
        source,
        sourceDocument,
        intent,
        creation,
        unwatch,
      } = publication;
      signal.throwIfAborted();
      set(assertAvailable$, signal);
      if (
        get(creationOwner$) !== creation ||
        get(model.intent$) !== intent ||
        (source &&
          (get(get(links$).selectedSession$) !== source ||
            get(source.input.owner$)?.document !== sourceDocument))
      ) {
        throw cancelled();
      }
      const discovery = get(get(links$).discovery$)!;
      const observation = set(discovery.beginCreation$, createdId);
      const targets = await directory.list();
      signal.throwIfAborted();
      set(assertAvailable$, signal);
      if (get(creationOwner$) !== creation || get(model.intent$) !== intent) {
        throw cancelled();
      }
      const created = targets.find((target) => {
        return target.id === createdId;
      });
      if (
        !created ||
        !set(discovery.created$, created, observation, client.signal)
      ) {
        throw new CdpFault(
          "tab",
          "The new tab is no longer available in this scope.",
        );
      }
      set(creationOwner$, null);
      unwatch();
      set(targetRevision$, (value) => {
        return value + 1;
      });
      set(model.resetAddress$);
      await set(get(links$).selectTab$, createdId, signal);
      return createdId;
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
    directory$,
  } = context;
  const publish$ = createTabPublication(context, links$);
  const cancelCreation$ = command(({ get, set }, owner: object) => {
    if (get(creationOwner$) === owner) {
      set(resetCreate$);
      set(creationOwner$, null);
    }
  });
  const createTab$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<string> => {
      set(assertAvailable$, signal);
      const source = get(get(links$).selectedSession$);
      if (source && !get(get(links$).input$)) {
        throw new CdpFault(
          "tab",
          "The selected page is not ready to create a tab.",
        );
      }
      if (!source && !get(model.controls$).emptyUnscoped) {
        throw new CdpFault(
          "tab",
          "A tab cannot be created in the current scope.",
        );
      }
      const intent = get(model.intent$);
      const client = get(clientState$)!;
      const directory = get(directory$)!;
      const operation = set(resetCreate$, client.signal, signal);
      const creation = {};
      set(creationOwner$, creation);
      const current = () => {
        return !operation.aborted;
      };
      const sourceDocument = source
        ? get(source.input.owner$)?.document
        : undefined;
      const unwatch = client.onEvent((event) => {
        if (
          source &&
          event.sessionId === source.attached.sessionId &&
          ((event.method === "Page.frameNavigated" &&
            isRecord(event.params.frame) &&
            !event.params.frame.parentId) ||
            event.method === "Runtime.executionContextsCleared")
        ) {
          set(cancelCreation$, creation);
        }
      });
      using _creation = {
        [Symbol.dispose]: () => {
          unwatch();
          if (get(creationOwner$) === creation) {
            set(creationOwner$, null);
          }
        },
      };
      let createdId: string | null = null;
      const [result] = await Promise.allSettled([
        (async (): Promise<string> => {
          createdId = await openTab(
            client,
            directory,
            source
              ? {
                  targetId: source.attached.owner.targetId,
                  sessionId: source.attached.sessionId,
                }
              : null,
            current,
          );
          return set(
            publish$,
            createdId,
            {
              client,
              directory,
              source,
              sourceDocument,
              intent,
              creation,
              unwatch,
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
      if (createdId && !(result.reason instanceof CreatedTabFault)) {
        throw new CreatedTabFault(createdId, result.reason);
      }
      if (signal.aborted && !(result.reason instanceof CreatedTabFault)) {
        throw cancelled();
      }
      throw result.reason;
    },
  );
  return { cancelCreation$, createTab$ };
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
      await directory.assertMember(targetId);
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
      set(model.inventoryUpdate$, { type: "closed", id: targetId });
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
      detach(
        set(discovery.removed$, targetId, client.signal),
        Reason.DomCallback,
        "browser closed inventory refresh",
      );
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
): Pick<ControllerLinks, "cancelCreation$" | "createTab$" | "closeTab$"> {
  return {
    ...createTabCreationGraph(context, links$),
    ...createTabClosingGraph(context, links$),
  };
}

function createNavigationGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "navigate$"> {
  const { model, assertAvailable$ } = context;
  const navigate$ = command(
    async (
      { get, set },
      navigation: Navigation,
      signal: AbortSignal,
    ): Promise<void> => {
      set(assertAvailable$, signal);
      const input = get(get(links$).input$);
      if (!input) {
        throw new CdpFault("input", "Remote input is unavailable.");
      }
      const previous = get(model.navigation$);
      await set(input.navigate$, navigation, signal);
      // Own-document replacement is not navigation cancellation. Publish the
      // successful receipt without awaiting old-owner jobs or a later load event.
      if (
        typeof navigation !== "string" &&
        get(model.navigation$) === previous
      ) {
        const url = navigationAddress(navigation.url);
        if (url) {
          set(model.update$, {
            navigation: {
              url,
              canGoBack: !!previous?.url || !!previous?.canGoBack,
              canGoForward: false,
            },
          });
        }
      }
    },
  );
  return { navigate$ };
}

function createImageRetryGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
): Pick<ControllerLinks, "retryStartingGraph$" | "retryImage$"> {
  const { model, selectedOwner$, wake$, assertAvailable$ } = context;
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
      if (!selected || selected.attached.owner.targetId !== image.targetId) {
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
    ): Promise<void> => {
      set(assertAvailable$, signal);
      set(model.setWindowSizeSync$, mode);
      const display = get(get(links$).displayGraph$);
      if (!display) {
        throw cancelled();
      }
      set(display.setMode$, mode);
      await set(display.waitForIdle$, signal);
      signal.throwIfAborted();
      if (get(model.windowSizeSync$) !== mode) {
        throw cancelled();
      }
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
  } = context;
  const restoreSelection$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (!get(available$)) {
        return;
      }
      const targetId = get(model.selectedTabId$);
      if (
        targetId &&
        get(model.snapshot$).targets.some((target) => {
          return target.id === targetId;
        })
      ) {
        await set(get(links$).selectTab$, targetId, signal);
        return;
      }
      const discovery = get(get(links$).discovery$);
      if (discovery) {
        await set(discovery.refresh$, signal);
      }
      const owner = get(selectedOwner$);
      if (owner) {
        await set(get(links$).waitReady$, owner, signal);
        return;
      }
      const first = get(model.snapshot$).targets[0];
      if (first && !get(chosenOnce$)) {
        await set(get(links$).selectTab$, first.id, signal);
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
  return { restoreSelection$, pause$ };
}

function createAuthoritySettingsGraph(
  context: ControllerContext,
  links$: Computed<ControllerLinks>,
) {
  const {
    model,
    authority$,
    disposedState$,
    retirements$,
    authorityRevoked$,
    wake$,
  } = context;
  const revokeAuthority$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
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
      // Admission is already false. These waits are original resource cleanup, not new business writes.
      await Promise.all(
        [...get(retirements$).keys()].map((targetId) => {
          return set(get(links$).waitRetirement$, targetId, signal);
        }),
      );
      signal.throwIfAborted();
    },
  );
  const refreshAuthority$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (!get(authority$)) {
        await set(revokeAuthority$, signal);
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
): Pick<ControllerLinks, "dispose$"> {
  const {
    model,
    resetOwner$,
    sink,
    clientState$,
    framesState$,
    connectedState$,
    disposedState$,
    wake$,
  } = context;
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
    set(resetOwner$);
    get(framesState$)?.close();
    get(clientState$)?.close();
    set(wake$);
  });
  return { dispose$ };
}

/** Compose static domain graphs, never a Store or accessor facade. */
export function createBrowserController(
  model: ViewerSignals,
  connection: BrowserConnection,
  canvas: HTMLCanvasElement,
  authority$: Computed<boolean>,
) {
  const context = createControllerState(model, connection, canvas, authority$);
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
    selectTab$: graph.selectTab$,
    createTab$: graph.createTab$,
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
    navigation$: graph.navigation$,
    display$: graph.display$,
    goBack$: command(({ set }, signal: AbortSignal) => {
      return set(graph.navigate$, "back", signal);
    }),
    goForward$: command(({ set }, signal: AbortSignal) => {
      return set(graph.navigate$, "forward", signal);
    }),
    reloadPage$: command(({ set }, signal: AbortSignal) => {
      return set(graph.navigate$, "reload", signal);
    }),
  };
}
