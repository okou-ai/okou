import { command, computed, state, type Command, type Computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  createDeferredPromise,
  isAbortError,
  onRef,
  Reason,
  resetSignal,
  setLoop,
  type DeferredPromise,
} from "../utils.ts";
import { detachBrowser } from "./reporting.ts";
import { pageSignal$ } from "../page-signal.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { logger } from "../log.ts";
import type {
  AddressSubmitNotice,
  BrowserConnection,
  BrowserSignals,
} from "./browser.ts";
import { CdpFault } from "./cdp/errors.ts";
import { monotonicNow } from "../../lib/time.ts";
import { measureDisplay, observeDisplay } from "./display.ts";
import { constrainDisplay, type DisplaySize } from "./display/geometry.ts";
import { createToolbarFocus, type ToolbarNodes } from "./focus.ts";
import { navigationAddress } from "./input/address.ts";
import { createNativeInput } from "./input/native.ts";
import {
  NavigationFault,
  type BrowserNavigationAction,
} from "./navigation/action.ts";
import { createTabStripLayout, type TabStripMotion } from "./tab-strip.ts";
import { createBrowserController } from "./viewer/controller.ts";
import { diagnostic } from "./viewer/diagnostic.ts";
import { createViewerSignals } from "./viewer/model.ts";
import {
  createViewerRecovery,
  sameRecoveryBinding,
  type RecoveryIntent,
  type RecoveryTarget,
  type RecoveryView,
} from "./recovery.ts";
import type {
  NavigationReceipt,
  ViewerCaptureOptions,
  ViewerTransport,
  WindowSizeSync,
} from "./viewer/types.ts";

const L = logger("Browser");

interface Mounted<E extends HTMLElement> {
  readonly node: E;
}
interface BrowserNodes {
  readonly canvas: Mounted<HTMLCanvasElement>;
  readonly input: Mounted<HTMLInputElement>;
  readonly toolbar: Mounted<HTMLDivElement>;
  readonly tabs: Mounted<HTMLDivElement>;
  readonly address: Mounted<HTMLInputElement>;
  readonly surface: Mounted<HTMLDivElement>;
}
interface BrowserIdentity {
  readonly connection: BrowserConnection;
  readonly nodes: BrowserNodes;
  readonly generation: number;
}
interface PresentedFrame {
  readonly identity: BrowserIdentity;
  readonly targetId: string;
}
type Controller = ReturnType<typeof createBrowserController>;
interface NativeLease {
  readonly identity: BrowserIdentity;
  readonly controller: Controller;
  readonly resetRetirement$: ReturnType<typeof resetSignal>;
}
interface RecoveryAttempt {
  readonly request: Promise<BrowserConnection | null>;
  readonly generation: number;
  readonly nodes: BrowserNodes;
  readonly completion: DeferredPromise<void>;
}
type ConnectionObservation = Command<
  Promise<void>,
  [Promise<BrowserConnection | null>, BrowserNodes | null, AbortSignal]
>;

function cancelled(): DOMException {
  return new DOMException("The browser operation was cancelled.", "AbortError");
}
function sameConnection(
  left: BrowserConnection | null,
  right: BrowserConnection,
): boolean {
  return (
    left?.cdpUrl === right.cdpUrl &&
    left.instanceId === right.instanceId &&
    left.windowId === right.windowId &&
    left.extension.id === right.extension.id &&
    left.extension.runtimeId === right.extension.runtimeId &&
    left.extension.version === right.extension.version
  );
}
function sameIdentity(
  left: BrowserIdentity,
  right: BrowserIdentity | null,
): boolean {
  if (
    !right ||
    left.generation !== right.generation ||
    !sameConnection(left.connection, right.connection)
  ) {
    return false;
  }
  const before = left.nodes;
  const after = right.nodes;
  return (
    before.canvas === after.canvas &&
    before.input === after.input &&
    before.toolbar === after.toolbar &&
    before.tabs === after.tabs &&
    before.address === after.address &&
    before.surface === after.surface
  );
}

/** Real ref owners publish DOM identity, never AbortSignals, into state. */
function createNodeRef<E extends HTMLElement>(
  released$: Command<void, [object]>,
  connectionChanged$: Command<void, []>,
) {
  const mountedState$ = state<Mounted<E> | null>(null);
  const mounted$ = computed((get) => {
    return get(mountedState$);
  });
  const mount$ = command(({ get, set }, node: E, signal: AbortSignal) => {
    const previous = get(mountedState$);
    if (previous) {
      set(released$, previous);
    }
    const mounted = { node };
    set(mountedState$, mounted);
    set(connectionChanged$);
    signal.addEventListener(
      "abort",
      () => {
        if (get(mountedState$) === mounted) {
          set(mountedState$, null);
        }
        set(released$, mounted);
        set(connectionChanged$);
      },
      { once: true },
    );
  });
  return { mounted$, mount$, ref$: onRef(mount$) };
}

function createRuntimeState(
  connection$: Computed<Promise<BrowserConnection | null>>,
) {
  const installed$ = state<NativeLease | null>(null);
  const addressConnection$ = state<BrowserConnection | null>(null);
  const presentedFrame$ = state<PresentedFrame | null>(null);
  const retiring$ = state<ReadonlySet<NativeLease>>(new Set());
  const recoveryNotification$ = state<(() => void) | null>(null);
  const recoveryChanged$ = command(({ get }) => {
    get(recoveryNotification$)?.();
  });
  const resetAutomatic$ = resetSignal();
  const recoveryTarget$ = state<RecoveryTarget | null>(null);
  // Bootstrap's own selections must not renew a spent recovery episode.
  const recoveryIntent$ = state<RecoveryIntent>({ retiredFailure: null });
  const remoteNavigation$ = computed((get) => {
    const lease = get(installed$);
    return lease ? get(lease.controller.navigation$) : null;
  });
  const remoteNavigationScope$ = computed((get) => {
    const lease = get(installed$);
    return lease ? get(lease.controller.navigationScope$) : null;
  });
  const creationReadySource$ = computed((get) => {
    const lease = get(installed$);
    return lease !== null && get(lease.controller.canCreate$);
  });
  const connectedSource$ = computed((get) => {
    const lease = get(installed$);
    return lease !== null && get(lease.controller.connected$);
  });
  const model = createViewerSignals(
    remoteNavigation$,
    remoteNavigationScope$,
    creationReadySource$,
    connectedSource$,
    recoveryChanged$,
  );
  const cancelAutomatic$ = command(({ get, set }) => {
    // Intent replacement and old-fault retirement are one publication.
    set(recoveryIntent$, {
      retiredFailure:
        get(model.imageRecovery$)?.owner ?? get(model.snapshot$).error,
    });
    set(resetAutomatic$, AbortSignal.abort(cancelled()));
    set(recoveryTarget$, null);
  });
  const confirmedRequest$ = state<
    Promise<BrowserConnection | null> | undefined
  >(undefined);
  const liveConnection$ = state<BrowserConnection | null>(null);
  const generation$ = state(0);
  const observer$ = state<object | null>(null);
  const recovery$ = state<RecoveryAttempt | null>(null);
  const resetRecovery$ = resetSignal();
  const inViewport$ = state(true);
  const documentHidden$ = state(document.hidden);
  const resetNativeOwner$ = resetSignal();
  const resetObservation$ = resetSignal();
  const changeNotification$ = state<DeferredPromise<void> | null>(null);
  const connectionChanged$ = command(({ get, set }) => {
    set(resetObservation$, AbortSignal.abort(cancelled()));
    const notification = get(changeNotification$);
    if (notification && !notification.settled()) {
      notification.resolve();
    }
    set(recoveryChanged$);
  });
  // Pending parent authority is revoked synchronously, before React ref commit.
  const authority$ = computed((get) => {
    return (
      get(connection$) === get(confirmedRequest$) &&
      get(liveConnection$) !== null
    );
  });
  const pending$ = computed((get) => {
    return get(connection$) !== get(confirmedRequest$);
  });
  const paused$ = computed((get) => {
    return get(documentHidden$) || !get(inViewport$);
  });
  return {
    connection$,
    model,
    confirmedRequest$,
    liveConnection$,
    generation$,
    observer$,
    recovery$,
    resetRecovery$,
    recoveryNotification$,
    recoveryChanged$,
    resetAutomatic$,
    recoveryTarget$,
    recoveryIntent$,
    cancelAutomatic$,
    installed$,
    addressConnection$,
    presentedFrame$,
    retiring$,
    inViewport$,
    documentHidden$,
    resetNativeOwner$,
    resetObservation$,
    changeNotification$,
    connectionChanged$,
    authority$,
    pending$,
    paused$,
  };
}
type RuntimeState = ReturnType<typeof createRuntimeState>;

/** Observes accepted pixels, independently of live input or request lifecycle. */
function createFrameObservations(
  context: RuntimeState,
  identity: BrowserIdentity,
) {
  const presentedTarget$ = computed((get) => {
    const frame = get(context.presentedFrame$);
    return frame &&
      frame.identity.nodes.canvas === identity.nodes.canvas &&
      sameRecoveryBinding(frame.identity.connection, identity.connection)
      ? frame.targetId
      : null;
  });
  const framePresented$ = command(({ get, set }, targetId: string) => {
    if (get(context.installed$)?.identity !== identity) {
      return;
    }
    // Frames of the same selected scope do not invalidate React on each paint.
    if (get(presentedTarget$) !== targetId) {
      set(context.presentedFrame$, { identity, targetId });
    }
  });
  const frameCleared$ = command(({ get, set }) => {
    if (get(context.installed$)?.identity === identity) {
      set(context.presentedFrame$, null);
    }
  });
  return { presentedTarget$, framePresented$, frameCleared$ };
}

function createMountedNodeGraph(
  released$: Command<void, [object]>,
  connectionChanged$: Command<void, []>,
) {
  const surface = createNodeRef<HTMLDivElement>(released$, connectionChanged$);
  const canvas = createNodeRef<HTMLCanvasElement>(
    released$,
    connectionChanged$,
  );
  const inputNode = createNodeRef<HTMLInputElement>(
    released$,
    connectionChanged$,
  );
  const toolbar = createNodeRef<HTMLDivElement>(released$, connectionChanged$);
  const tabs = createNodeRef<HTMLDivElement>(released$, connectionChanged$);
  const address = createNodeRef<HTMLInputElement>(
    released$,
    connectionChanged$,
  );
  const nodes$ = computed((get): BrowserNodes | null => {
    const canvasNode = get(canvas.mounted$);
    const proxy = get(inputNode.mounted$);
    const toolbarNode = get(toolbar.mounted$);
    const tabsNode = get(tabs.mounted$);
    const addressNode = get(address.mounted$);
    const surfaceNode = get(surface.mounted$);
    return canvasNode &&
      proxy &&
      toolbarNode &&
      tabsNode &&
      addressNode &&
      surfaceNode
      ? {
          canvas: canvasNode,
          input: proxy,
          toolbar: toolbarNode,
          tabs: tabsNode,
          address: addressNode,
          surface: surfaceNode,
        }
      : null;
  });
  const toolbarNodes$ = computed((get) => {
    const toolbarNode = get(toolbar.mounted$)?.node;
    const tabsNode = get(tabs.mounted$)?.node;
    const addressNode = get(address.mounted$)?.node;
    return toolbarNode && tabsNode && addressNode
      ? { toolbar: toolbarNode, tabs: tabsNode, address: addressNode }
      : null;
  });
  return {
    surface,
    canvas,
    inputNode,
    toolbar,
    tabs,
    address,
    nodes$,
    toolbarNodes$,
  };
}

/** DOM incarnation and immutable connection identity determine the child graph. */
function createControllerGraph(
  context: RuntimeState,
  identity$: Computed<BrowserIdentity | null>,
  native: ReturnType<typeof createNativeInput>,
) {
  const { model, installed$, authority$ } = context;
  return computed((get): NativeLease | null => {
    const identity = get(identity$);
    const installed = get(installed$);
    if (installed && sameIdentity(installed.identity, identity)) {
      return installed;
    }
    // An ended lease is not a reusable controller, even if its connection and
    // DOM identity are unchanged. The current native owner is canonical.
    const restoration = get(context.recoveryTarget$);
    return identity
      ? {
          identity,
          resetRetirement$: resetSignal(),
          controller: createBrowserController(
            model,
            identity.connection,
            identity.nodes.canvas.node,
            {
              authority$,
              nativeHost: native,
              selectionChanged$: context.cancelAutomatic$,
              ...createFrameObservations(context, identity),
              preferredTargetId:
                restoration &&
                sameRecoveryBinding(restoration.binding, identity.connection)
                  ? restoration.targetId
                  : null,
            },
          ),
        }
      : null;
  });
}

function createDOMFocus(
  context: RuntimeState,
  nodes$: Computed<ToolbarNodes | null>,
) {
  const authority$ = computed((get): object | null => {
    return get(context.authority$) ? get(context.installed$) : null;
  });
  const selection$ = computed((get) => {
    return get(context.model.intent$).selection;
  });
  return createToolbarFocus(nodes$, {
    authority$,
    selection$,
    tabs$: context.model.tabs$,
    selectedTabId$: context.model.selectedTabId$,
    tabLayout$: context.model.tabLayout$,
  });
}

function createDOMGraph(
  context: RuntimeState,
  onPageInput$?: Command<void, []>,
) {
  const {
    installed$,
    resetNativeOwner$,
    liveConnection$,
    generation$,
    authority$,
  } = context;
  const retireLease$ = command(({ get, set }, lease: NativeLease) => {
    if (get(installed$) === lease) {
      set(resetNativeOwner$, AbortSignal.abort(cancelled()));
    } else {
      set(lease.controller.dispose$);
    }
  });
  const released$ = command(({ get, set }, mounted: object) => {
    const frame = get(context.presentedFrame$);
    if (
      frame &&
      Object.values(frame.identity.nodes).some((node) => {
        return node === mounted;
      })
    ) {
      const canvas = frame.identity.nodes.canvas.node;
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      set(context.presentedFrame$, null);
    }
    const lease = get(installed$);
    if (!lease) {
      return;
    }
    const nodes = lease.identity.nodes;
    if (
      [
        nodes.surface,
        nodes.canvas,
        nodes.input,
        nodes.toolbar,
        nodes.tabs,
        nodes.address,
      ].some((owner) => {
        return owner === mounted;
      })
    ) {
      set(retireLease$, lease);
    }
  });
  const {
    surface,
    canvas,
    inputNode,
    toolbar,
    tabs,
    address,
    nodes$,
    toolbarNodes$,
  } = createMountedNodeGraph(released$, context.connectionChanged$);
  const clearFrame$ = command(({ get, set }) => {
    const node = get(canvas.mounted$)?.node;
    node?.getContext("2d")?.clearRect(0, 0, node.width, node.height);
    set(context.presentedFrame$, null);
  });
  const focus = createDOMFocus(context, toolbarNodes$);
  const toolbarRef$ = onRef(
    command(({ set }, node: HTMLDivElement, signal: AbortSignal) => {
      set(toolbar.mount$, node, signal);
      set(focus.listen$, node, signal);
    }),
  );
  const identity$ = computed((get): BrowserIdentity | null => {
    const connection = get(liveConnection$);
    const nodes = get(nodes$);
    return connection && nodes
      ? { connection, nodes, generation: get(generation$) }
      : null;
  });
  const selectedInput$ = computed((get) => {
    const lease = get(installed$);
    return lease ? get(lease.controller.input$) : null;
  });
  const native = createNativeInput(
    selectedInput$,
    focus.release$,
    onPageInput$,
  );
  const controllerGraph$ = createControllerGraph(context, identity$, native);
  const requireController$ = command(
    ({ get }, signal: AbortSignal): NativeLease => {
      signal.throwIfAborted();
      const lease = get(installed$);
      if (
        !get(authority$) ||
        !lease ||
        !sameIdentity(lease.identity, get(identity$))
      ) {
        throw cancelled();
      }
      return lease;
    },
  );
  return {
    retireLease$,
    clearFrame$,
    surface,
    canvas,
    inputNode,
    toolbar: { ...toolbar, ref$: toolbarRef$ },
    tabs,
    address,
    nodes$,
    focus,
    identity$,
    controllerGraph$,
    selectedInput$,
    native,
    requireController$,
  };
}
type RuntimeGraph = ReturnType<typeof createDOMGraph>;

/** Native event boundaries pass their original owner explicitly to commands. */
function createNativeObservations(context: RuntimeState, graph: RuntimeGraph) {
  const { installed$, retiring$ } = context;
  const { native, focus } = graph;
  const finishRetirement$ = command(
    async ({ get, set }, lease: NativeLease, signal: AbortSignal) => {
      const [closed] = await Promise.allSettled([
        set(lease.controller.waitForClosed$, signal),
      ]);
      signal.throwIfAborted();
      const remaining = new Set(get(retiring$));
      remaining.delete(lease);
      set(retiring$, remaining);
      set(lease.resetRetirement$, AbortSignal.abort(cancelled()));
      if (closed.status === "rejected") {
        throw closed.reason;
      }
    },
  );
  const releaseNative$ = command(({ get, set }, lease: NativeLease) => {
    set(lease.controller.dispose$);
    if (!get(retiring$).has(lease)) {
      set(retiring$, new Set(get(retiring$)).add(lease));
      const retirement = set(lease.resetRetirement$);
      detachBrowser(
        set(finishRetirement$, lease, retirement),
        Reason.DomCallback,
        "browser native retirement",
      );
    }
    if (get(installed$) !== lease) {
      return;
    }
    set(native.dispose$);
    set(focus.revoke$, lease);
    set(installed$, null);
  });
  const measure$ = command(
    ({ get, set }, lease: NativeLease, size: DisplaySize | null) => {
      if (get(installed$) === lease) {
        set(lease.controller.measure$, size);
      }
    },
  );
  return { releaseNative$, measure$ };
}

/** Native startup keeps its DOM owner even if a request observer is replaced. */
function createNativeMount(context: RuntimeState, graph: RuntimeGraph) {
  const { model, paused$ } = context;
  const { retireLease$, native } = graph;
  const observations = createNativeObservations(context, graph);
  return command(
    async (
      { get, set },
      lease: NativeLease,
      owner: AbortSignal,
    ): Promise<void> => {
      owner.throwIfAborted();
      const nodes = lease.identity.nodes;
      owner.addEventListener(
        "abort",
        () => {
          set(observations.releaseNative$, lease);
        },
        { once: true },
      );
      const [setup] = await Promise.allSettled([
        (async () => {
          const addressConnection = get(context.addressConnection$);
          if (
            addressConnection &&
            !sameRecoveryBinding(addressConnection, lease.identity.connection)
          ) {
            set(model.detachAddress$);
          }
          set(context.addressConnection$, lease.identity.connection);
          set(model.transition$, { type: "reset" });
          set(model.configure$, lease.identity.connection.windowId !== null);
          set(
            native.bind$,
            nodes.surface.node,
            nodes.canvas.node,
            nodes.input.node,
            owner,
          );
          observeDisplay(
            nodes.canvas.node,
            (size) => {
              set(observations.measure$, lease, size);
            },
            owner,
          );
          await set(lease.controller.pause$, get(paused$), owner);
        })(),
      ]);
      owner.throwIfAborted();
      if (setup.status === "rejected") {
        if (!isAbortError(setup.reason)) {
          if (!diagnostic(setup.reason).transient) {
            set(graph.clearFrame$);
          }
          set(model.transition$, {
            type: "failed",
            error: diagnostic(setup.reason),
          });
        }
        set(retireLease$, lease);
        throw setup.reason;
      }
      const [started] = await Promise.allSettled([
        set(lease.controller.start$, owner),
      ]);
      owner.throwIfAborted();
      if (started.status === "rejected") {
        if (
          !isAbortError(started.reason) &&
          !diagnostic(started.reason).transient
        ) {
          set(graph.clearFrame$);
        }
        // The descriptor observer may already be suspended or replaced. Native
        // failure must still retire this lease through its own mount owner.
        set(retireLease$, lease);
        throw started.reason;
      }
    },
  );
}

/** Required onRef owners cancel this stable reset; no signal enters state. */
function createNativeLifecycle(context: RuntimeState, graph: RuntimeGraph) {
  const { installed$, retiring$, authority$, resetNativeOwner$ } = context;
  const { controllerGraph$, identity$, retireLease$ } = graph;
  const mount$ = createNativeMount(context, graph);
  const install$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<NativeLease> => {
      signal.throwIfAborted();
      if (!get(authority$)) {
        throw cancelled();
      }
      const resource = get(controllerGraph$);
      if (!resource) {
        throw cancelled();
      }
      const previous = get(installed$);
      if (previous && sameIdentity(previous.identity, resource.identity)) {
        return previous;
      }
      if (previous) {
        set(retireLease$, previous);
      }
      // A retiring incarnation of this resource must finish before reuse. A
      // confirmed distinct resource owns independent sockets and must not wait.
      for (const retiring of get(retiring$)) {
        if (
          sameConnection(
            retiring.identity.connection,
            resource.identity.connection,
          )
        ) {
          await set(retiring.controller.waitForClosed$, signal);
          signal.throwIfAborted();
        }
      }
      signal.throwIfAborted();
      if (
        !get(authority$) ||
        !sameIdentity(resource.identity, get(identity$))
      ) {
        throw cancelled();
      }
      const owner = set(resetNativeOwner$);
      const lease: NativeLease = resource;
      set(installed$, lease);
      // The mount retains its DOM/native owner if this request reader is replaced.
      const interrupted = createDeferredPromise<void>(signal);
      const [mounted] = await Promise.allSettled([
        Promise.race([set(mount$, lease, owner), interrupted.promise]),
      ]);
      signal.throwIfAborted();
      if (!interrupted.settled()) {
        interrupted.resolve();
      }
      if (mounted.status === "rejected") {
        await set(lease.controller.waitForClosed$, signal);
        throw mounted.reason;
      }
      if (
        get(installed$) !== lease ||
        !get(authority$) ||
        !sameIdentity(lease.identity, get(identity$))
      ) {
        throw cancelled();
      }
      return lease;
    },
  );
  return { install$ };
}
type NativeLifecycle = ReturnType<typeof createNativeLifecycle>;

/** Revalidation revokes old admission before learning a replacement identity. */
function createConnectionResolution(context: RuntimeState) {
  const { installed$, confirmedRequest$ } = context;
  return command(
    async (
      { get, set },
      request: Promise<BrowserConnection | null>,
      signal: AbortSignal,
    ): Promise<BrowserConnection | null> => {
      signal.throwIfAborted();
      const previous = get(installed$);
      // Revoking old admission writes its input releases immediately. Original
      // cleanup stays controller-owned; a reused target waits for its own
      // retirement when it is attached again.
      if (previous && request !== get(confirmedRequest$)) {
        set(previous.controller.revokeAuthority$);
      }
      const interrupted = createDeferredPromise<never>(signal);
      using _interruption = {
        [Symbol.dispose]() {
          if (!interrupted.settled()) {
            interrupted.reject(cancelled());
          }
        },
      };
      const connection = await Promise.race([request, interrupted.promise]);
      signal.throwIfAborted();
      return connection;
    },
  );
}

/** Publish only confirmed descriptors; disposal precedes successor model setup. */
function createConnectionPublication(
  context: RuntimeState,
  graph: RuntimeGraph,
  lifecycle: NativeLifecycle,
) {
  const { installed$, liveConnection$, confirmedRequest$, model } = context;
  const { retireLease$, identity$ } = graph;
  return command(
    async (
      { get, set },
      request: Promise<BrowserConnection | null>,
      connection: BrowserConnection | null,
      nodes: BrowserNodes | null,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (!connection) {
        set(graph.clearFrame$);
        const old = get(installed$);
        if (old) {
          set(retireLease$, old);
        }
        set(liveConnection$, null);
        set(confirmedRequest$, request);
        set(model.transition$, { type: "target-lost", error: null });
        return;
      }
      if (!sameConnection(get(liveConnection$), connection)) {
        const frame = get(context.presentedFrame$);
        if (
          frame &&
          !sameRecoveryBinding(frame.identity.connection, connection)
        ) {
          set(graph.clearFrame$);
        }
        const old = get(installed$);
        if (old) {
          set(retireLease$, old);
        }
        set(liveConnection$, connection);
      }
      set(confirmedRequest$, request);
      if (!nodes) {
        return;
      }
      const existing = get(installed$);
      if (existing && sameIdentity(existing.identity, get(identity$))) {
        await set(existing.controller.refreshAuthority$, signal);
      } else {
        await set(lifecycle.install$, signal);
      }
      signal.throwIfAborted();
      const lease = get(installed$);
      if (!lease || !sameIdentity(lease.identity, get(identity$))) {
        throw cancelled();
      }
      await set(lease.controller.waitForReady$, signal);
      signal.throwIfAborted();
    },
  );
}

/** Current request equality is the authority fence; no mirrored loading state. */
function createConnectionObservers(
  context: RuntimeState,
  graph: RuntimeGraph,
  lifecycle: NativeLifecycle,
  watchRecovery$: Command<Promise<void>, [AbortSignal]>,
) {
  const {
    connection$,
    observer$,
    installed$,
    liveConnection$,
    confirmedRequest$,
    model,
  } = context;
  const { nodes$, retireLease$ } = graph;
  const resolve$ = createConnectionResolution(context);
  const publish$ = createConnectionPublication(context, graph, lifecycle);
  const observeConnection$: ConnectionObservation = command(
    async (
      { get, set },
      request: Promise<BrowserConnection | null>,
      nodes: BrowserNodes | null,
      signal: AbortSignal,
    ) => {
      const observation = {};
      set(observer$, observation);
      const current = () => {
        return (
          !signal.aborted &&
          get(observer$) === observation &&
          get(connection$) === request &&
          get(nodes$) === nodes
        );
      };
      signal.addEventListener(
        "abort",
        () => {
          if (get(observer$) === observation) {
            set(observer$, null);
          }
          // Per-request cleanup must never dispose unchanged native sockets.
        },
        { once: true },
      );
      const [resolved] = await Promise.allSettled([
        set(resolve$, request, signal),
      ]);
      signal.throwIfAborted();
      if (!current()) {
        throw cancelled();
      }
      if (resolved.status === "rejected") {
        const error: unknown = resolved.reason;
        if (!isAbortError(error) && !diagnostic(error).transient) {
          set(graph.clearFrame$);
        }
        const old = get(installed$);
        if (old) {
          set(retireLease$, old);
        }
        set(liveConnection$, null);
        if (isAbortError(error)) {
          throw error;
        }
        set(confirmedRequest$, request);
        set(model.transition$, { type: "failed", error: diagnostic(error) });
        throw error;
      }
      await set(publish$, request, resolved.value, nodes, signal);
      signal.throwIfAborted();
      if (!current()) {
        throw cancelled();
      }
    },
  );
  const attempt$ = createConnectionAttempt(context, graph, observeConnection$);
  return {
    root$: createRootObservation(context, graph, attempt$, watchRecovery$),
  };
}

/** A receipt observes the root's work; Reconnect never becomes a bootstrap owner. */
function createConnectionAttempt(
  context: RuntimeState,
  graph: RuntimeGraph,
  observe$: ConnectionObservation,
): ConnectionObservation {
  return command(
    async (
      { get, set },
      request: Promise<BrowserConnection | null>,
      nodes: BrowserNodes | null,
      signal: AbortSignal,
    ) => {
      const recovery = get(context.recovery$);
      const generation = get(context.generation$);
      const expired = createDeferredPromise<{
        readonly kind: "expired";
        readonly error: CdpFault;
      }>({ rejection: "owner" }, signal);
      const deadline = monotonicNow() + 60_000;
      using _deadline = {
        [Symbol.dispose]() {
          if (!expired.settled()) {
            expired.reject(cancelled());
          }
        },
      };
      setLoop(
        () => {
          if (expired.settled()) {
            return true;
          }
          if (monotonicNow() >= deadline) {
            expired.resolve({
              kind: "expired",
              error: new CdpFault(
                "connection",
                "The browser did not become ready in time. Reconnect the browser.",
              ),
            });
            return true;
          }
          return false;
        },
        1000,
        signal,
        { testIntervalMs: 10 },
      );
      const outcome = await Promise.race([
        (async () => {
          const [result] = await Promise.allSettled([
            set(observe$, request, nodes, signal),
          ]);
          return { kind: "observed", result } as const;
        })(),
        expired.promise,
      ]);
      signal.throwIfAborted();
      if (
        get(context.connection$) !== request ||
        get(graph.nodes$) !== nodes ||
        get(context.generation$) !== generation
      ) {
        throw cancelled();
      }
      const result: PromiseSettledResult<void> =
        outcome.kind === "expired"
          ? {
              status: "rejected",
              reason: outcome.error,
            }
          : outcome.result;
      if (outcome.kind === "expired") {
        // Cancel the parked observer before retiring its resources. Its late API
        // response or paint cannot publish into this or a successor attempt.
        set(context.resetObservation$, AbortSignal.abort(cancelled()));
        const lease = get(context.installed$);
        if (lease) {
          set(graph.retireLease$, lease);
        }
        set(context.liveConnection$, null);
        set(context.confirmedRequest$, request);
        set(context.model.transition$, {
          type: "failed",
          error: diagnostic(outcome.error),
        });
      }
      if (
        recovery &&
        get(context.recovery$) === recovery &&
        !recovery.completion.settled()
      ) {
        if (result.status === "rejected") {
          recovery.completion.reject(result.reason);
        } else {
          recovery.completion.resolve();
        }
      }
      if (result.status === "rejected") {
        throw result.reason;
      }
    },
  );
}

/** Visibility belongs to the mounted surface, independently of native leases. */
function createPauseObservation(
  context: Pick<
    RuntimeState,
    | "paused$"
    | "documentHidden$"
    | "inViewport$"
    | "connectionChanged$"
    | "installed$"
    | "cancelAutomatic$"
    | "recoveryIntent$"
  >,
) {
  return command(
    async (
      { get, set },
      source: "document" | "viewport",
      visible: boolean,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      const previous = get(context.paused$);
      if (source === "document") {
        set(context.documentHidden$, !visible);
      } else {
        set(context.inViewport$, visible);
      }
      const paused = get(context.paused$);
      if (paused === previous) {
        return;
      }
      if (paused) {
        set(context.cancelAutomatic$);
      } else {
        // Resuming explicitly permits retrying the retained failure.
        set(context.recoveryIntent$, { retiredFailure: null });
      }
      // Suspend the request observation, not the native owner or the caller's
      // recovery receipt. Resume rejoins that same root's readiness work.
      set(context.connectionChanged$);
      const lease = get(context.installed$);
      if (lease) {
        await set(lease.controller.pause$, paused, signal);
      }
    },
  );
}

/** Supersession ends receipts even when visibility suspends native work. */
function createRecoverySupersession(
  context: Pick<RuntimeState, "recovery$" | "generation$">,
) {
  return command(
    (
      { get },
      request: Promise<BrowserConnection | null>,
      nodes: BrowserNodes | null,
    ) => {
      const recovery = get(context.recovery$);
      if (
        recovery &&
        !recovery.completion.settled() &&
        (recovery.request !== request ||
          recovery.nodes !== nodes ||
          recovery.generation !== get(context.generation$))
      ) {
        recovery.completion.reject(cancelled());
      }
    },
  );
}

/** The stable real DOM owner and page lifetime settle every parked receipt. */
function createRootObservation(
  context: RuntimeState,
  graph: RuntimeGraph,
  observeConnection$: ConnectionObservation,
  watchRecovery$: Command<Promise<void>, [AbortSignal]>,
) {
  const { installed$, observer$, connection$ } = context;
  const { nodes$, retireLease$ } = graph;
  const updatePause$ = createPauseObservation(context);
  const supersedeRecovery$ = createRecoverySupersession(context);
  return onRef(
    command(
      async ({ get, set }, root: HTMLDivElement, mountSignal: AbortSignal) => {
        const signal = AbortSignal.any([mountSignal, get(pageSignal$)]);
        signal.throwIfAborted();
        set(context.documentHidden$, document.hidden);
        set(context.inViewport$, true);
        document.addEventListener(
          "visibilitychange",
          () => {
            detachBrowser(
              set(updatePause$, "document", !document.hidden, signal),
              Reason.DomCallback,
              "browser visibility",
            );
          },
          { signal },
        );
        let observedCanvas: HTMLCanvasElement | null = null;
        const viewport = new IntersectionObserver((entries) => {
          const entry = entries
            .filter((entry) => {
              return entry.target === observedCanvas;
            })
            .at(-1);
          if (entry) {
            detachBrowser(
              set(updatePause$, "viewport", entry.isIntersecting, signal),
              Reason.DomCallback,
              "browser viewport",
            );
          }
        });
        using _viewport = {
          [Symbol.dispose]() {
            viewport.disconnect();
          },
        };
        signal.addEventListener(
          "abort",
          () => {
            const recovery = get(context.recovery$);
            if (
              recovery &&
              root.contains(recovery.nodes.surface.node) &&
              !recovery.completion.settled()
            ) {
              recovery.completion.reject(cancelled());
            }
            set(context.resetObservation$, AbortSignal.abort(cancelled()));
            set(context.changeNotification$, null);
            const lease = get(installed$);
            if (lease && root.contains(lease.identity.nodes.surface.node)) {
              set(retireLease$, lease);
            }
          },
          { once: true },
        );
        detachBrowser(
          set(watchRecovery$, signal),
          Reason.Daemon,
          "browser recovery owner",
        );
        // Only actual mount and semantic publishers wake reconciliation. Registration
        // precedes the snapshot so notifications cannot fall between read and wait.
        while (!signal.aborted) {
          const notification = createDeferredPromise<void>(signal);
          set(context.changeNotification$, notification);
          const observation = set(context.resetObservation$, signal);
          const nodes = get(nodes$);
          const mountedNodes =
            nodes &&
            Object.values(nodes).every((mounted) => {
              return root.contains(mounted.node);
            })
              ? nodes
              : null;
          const canvas = mountedNodes?.canvas.node ?? null;
          if (canvas !== observedCanvas) {
            if (observedCanvas) {
              viewport.unobserve(observedCanvas);
            }
            observedCanvas = canvas;
            if (canvas) {
              set(context.inViewport$, true);
              viewport.observe(canvas);
            }
          }
          const request = get(connection$);
          set(supersedeRecovery$, request, mountedNodes);
          if (!get(context.paused$)) {
            const [result] = await Promise.allSettled([
              set(observeConnection$, request, mountedNodes, observation),
            ]);
            signal.throwIfAborted();
            if (result.status === "rejected" && !isAbortError(result.reason)) {
              // The coordinator reports only when the current episode stops retrying.
              if (!get(featureSwitch$)[FeatureSwitchKey.BrowserSharedOwner]) {
                L.error("Browser viewer startup failed", result.reason);
              }
              set(observer$, null);
            }
          }
          await notification.promise;
          signal.throwIfAborted();
          if (get(context.changeNotification$) === notification) {
            set(context.changeNotification$, null);
          }
        }
      },
    ),
  );
}

function createTabActions(context: RuntimeState, graph: RuntimeGraph) {
  const { requireController$, focus } = graph;
  const confirmLease$ = command(
    ({ set }, lease: NativeLease, signal: AbortSignal) => {
      if (set(requireController$, signal) !== lease) {
        throw cancelled();
      }
    },
  );
  const selectTab$ = command(
    async ({ set }, targetId: string, signal: AbortSignal) => {
      const lease = set(requireController$, signal);
      set(context.cancelAutomatic$);
      const token = set(focus.beginSelect$, targetId, lease, signal);
      set(context.model.selectAddress$, targetId);
      const [selected] = await Promise.allSettled([
        (async () => {
          await set(lease.controller.selectTab$, targetId, signal);
          set(confirmLease$, lease, signal);
        })(),
      ]);
      signal.throwIfAborted();
      if (selected.status === "rejected") {
        set(focus.cancel$, token);
        throw selected.reason;
      }
      set(focus.selected$, token);
    },
  );
  const createTab$ = command(
    async ({ set }, signal: AbortSignal): Promise<string> => {
      const lease = set(requireController$, signal);
      set(context.cancelAutomatic$);
      const [created] = await Promise.allSettled([
        (async () => {
          const creation = set(lease.controller.createTab$, signal);
          set(focus.newAddress$);
          const targetId = await creation;
          set(confirmLease$, lease, signal);
          return targetId;
        })(),
      ]);
      signal.throwIfAborted();
      if (created.status === "rejected") {
        throw created.reason;
      }
      return created.value;
    },
  );
  const closeTab$ = command(
    async ({ set }, targetId: string, signal: AbortSignal) => {
      const lease = set(requireController$, signal);
      set(context.cancelAutomatic$);
      const token = set(focus.beginClose$, targetId, lease, signal);
      const [closed] = await Promise.allSettled([
        (async () => {
          await set(lease.controller.closeTab$, targetId, signal);
          set(confirmLease$, lease, signal);
        })(),
      ]);
      signal.throwIfAborted();
      if (closed.status === "rejected") {
        set(focus.cancel$, token);
        throw closed.reason;
      }
      // Positive close/inventory receipt never waits for successor pixels.
      set(focus.closed$, token);
    },
  );
  return { selectTab$, createTab$, closeTab$ };
}

function createNavigationActions(context: RuntimeState, graph: RuntimeGraph) {
  const { model } = context;
  const { requireController$ } = graph;
  const noticeState$ = state<AddressSubmitNotice | null>(null);
  const addressSubmitNotice$ = computed((get) => {
    return get(noticeState$);
  });
  const notifyAddressSubmit$ = command(
    ({ set }, kind: AddressSubmitNotice["kind"] | null) => {
      set(noticeState$, kind ? { kind } : null);
    },
  );
  const canSubmitAddress$ = computed((get) => {
    const lease = get(context.installed$);
    return (
      get(context.authority$) &&
      lease !== null &&
      !get(lease.controller.creatingTab$) &&
      get(graph.selectedInput$) !== null &&
      get(model.controls$).streaming &&
      get(model.addressTargetMatches$)
    );
  });
  const execute$ = command(
    async (
      { get, set },
      lease: NativeLease,
      action: BrowserNavigationAction,
      signal: AbortSignal,
    ): Promise<NavigationReceipt> => {
      if (action !== "submit-address") {
        return await set(lease.controller.navigate$, action, signal);
      }
      const scope = get(lease.controller.navigationScope$);
      if (!scope) {
        throw cancelled();
      }
      const url = navigationAddress(get(model.address$));
      if (!url) {
        throw new CdpFault("input", "Enter a valid page address.");
      }
      const submission = set(model.prepareAddress$, scope);
      const receipt = await set(lease.controller.navigate$, { url }, signal);
      set(model.acceptAddress$, submission, receipt);
      return receipt;
    },
  );
  const navigate$ = command(
    async (
      { get, set },
      action: BrowserNavigationAction,
      signal: AbortSignal,
    ): Promise<NavigationReceipt> => {
      const lease = set(requireController$, signal);
      if (action === "submit-address" && !get(canSubmitAddress$)) {
        set(notifyAddressSubmit$, "preparing");
        return { kind: "unavailable" };
      }
      const scope = get(lease.controller.navigationScope$);
      const [result] = await Promise.allSettled([
        set(execute$, lease, action, signal),
      ]);
      signal.throwIfAborted();
      if (result.status === "rejected") {
        if (isAbortError(result.reason)) {
          throw result.reason;
        }
        throw new NavigationFault(scope, result.reason);
      }
      return result.value;
    },
  );
  return {
    navigate$,
    canSubmitAddress$,
    addressSubmitNotice$,
    notifyAddressSubmit$,
  };
}

function createConfigurationActions(
  context: RuntimeState,
  graph: RuntimeGraph,
  reloadConnection$: Command<void, []>,
) {
  const {
    model,
    connection$,
    generation$,
    installed$,
    authority$,
    recovery$,
    resetRecovery$,
  } = context;
  const { requireController$, nodes$, native } = graph;
  const waitForRecovery$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      signal.throwIfAborted();
      const nodes = get(nodes$);
      if (!nodes) {
        throw cancelled();
      }
      const operation = set(resetRecovery$, signal);
      const recovery: RecoveryAttempt = {
        request: get(connection$),
        generation: get(generation$),
        nodes,
        completion: createDeferredPromise<void>(
          { rejection: "owner" },
          operation,
        ),
      };
      set(recovery$, recovery);
      using _recovery = {
        [Symbol.dispose]: () => {
          if (get(recovery$) === recovery) {
            set(recovery$, null);
          }
          if (!recovery.completion.settled()) {
            recovery.completion.reject(cancelled());
          }
        },
      };
      set(context.connectionChanged$);
      await recovery.completion.promise;
      signal.throwIfAborted();
      operation.throwIfAborted();
    },
  );
  const reconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(nodes$)) {
      throw cancelled();
    }
    const lease = get(installed$);
    if (
      !get(authority$) ||
      !lease ||
      !get(lease.controller.canRetryDiscovery$)
    ) {
      set(generation$, (value) => {
        return value + 1;
      });
    }
    set(reloadConnection$);
    await set(waitForRecovery$, signal);
  });
  const retryImage$ = command(async ({ set }, signal: AbortSignal) => {
    const lease = set(requireController$, signal);
    await set(lease.controller.retryImage$, signal);
  });
  const changeCapture$ = command(
    async ({ set }, options: ViewerCaptureOptions, signal: AbortSignal) => {
      const lease = set(requireController$, signal);
      await set(lease.controller.changeCapture$, options, signal);
    },
  );
  const changeTransport$ = command(
    async ({ get, set }, transport: ViewerTransport, signal: AbortSignal) => {
      set(requireController$, signal);
      if (transport !== "shared" && transport !== "split") {
        throw new CdpFault("configuration", "The transport mode is invalid.");
      }
      if (transport === get(model.transport$)) {
        return;
      }
      set(context.cancelAutomatic$);
      set(model.setTransport$, transport);
      set(generation$, (value) => {
        return value + 1;
      });
      await set(waitForRecovery$, signal);
    },
  );
  const changeWindowSizeSync$ = command(
    async ({ set }, mode: WindowSizeSync, signal: AbortSignal) => {
      const lease = set(requireController$, signal);
      return await set(lease.controller.changeWindowSizeSync$, mode, signal);
    },
  );
  const syncDisplay$ = command(async ({ set }, signal: AbortSignal) => {
    const lease = set(requireController$, signal);
    await set(lease.controller.syncDisplay$, signal);
  });
  const copyClipboard$ = command(({ set }, signal: AbortSignal) => {
    set(requireController$, signal);
    // Preserve synchronous clipboard acquisition in the original user gesture.
    return set(native.copyClipboard$, signal);
  });
  return {
    reconnect$,
    retryImage$,
    changeCapture$,
    changeTransport$,
    changeWindowSizeSync$,
    syncDisplay$,
    copyClipboard$,
  };
}

function createPresentation(context: RuntimeState, graph: RuntimeGraph) {
  const { installed$, authority$, pending$, model } = context;
  const retainedFrame$ = computed((get) => {
    const frame = get(context.presentedFrame$);
    if (
      !get(featureSwitch$)[FeatureSwitchKey.BrowserSharedOwner] ||
      !frame ||
      get(context.paused$) ||
      frame.identity.nodes.canvas !== get(graph.canvas.mounted$)
    ) {
      return false;
    }
    const connection = get(context.liveConnection$);
    const restoration = get(context.recoveryTarget$);
    const targetId =
      get(model.snapshot$).selectedTargetId ?? restoration?.targetId;
    return (
      frame.targetId === targetId &&
      (connection
        ? sameRecoveryBinding(frame.identity.connection, connection)
        : restoration !== null &&
          sameRecoveryBinding(frame.identity.connection, restoration.binding))
    );
  });
  const display$ = computed((get) => {
    const lease = get(installed$);
    const display = lease
      ? get(lease.controller.display$)
      : { ready: false, pending: false, pointerBlocked: true };
    return get(authority$) ? display : { ...display, pointerBlocked: true };
  });
  const controls$ = computed((get) => {
    const controls = get(model.controls$);
    const lease = get(installed$);
    const authorized = get(authority$) && lease !== null;
    const creating = lease !== null && get(lease.controller.creatingTab$);
    const inputReady = get(graph.selectedInput$) !== null;
    return {
      ...controls,
      streaming: authorized && !creating && inputReady && controls.streaming,
      recovery: !get(context.paused$) && !get(pending$) && controls.recovery,
      showRecovery:
        !get(context.paused$) && !get(pending$) && controls.showRecovery,
      showEmptyCreate: authorized && controls.showEmptyCreate,
      canMutateTabs: authorized && controls.canMutateTabs,
      canCreate: authorized && controls.canCreate,
      tabsDisabled: !authorized || controls.tabsDisabled,
      canSyncDisplay:
        authorized && controls.canSyncDisplay && get(display$).ready,
      canReload: authorized && !get(pending$) && controls.canReload,
      showImageRetry: !get(pending$) && controls.showImageRetry,
      canRetryImage: authorized && controls.canRetryImage,
    };
  });
  const presentation$ = computed((get) => {
    if (get(context.paused$)) {
      return {
        status: "paused" as const,
        error: null,
        loadingPreview: false,
        retainedFrame: false,
        blank: false,
      };
    }
    if (get(pending$)) {
      return {
        status: "connecting" as const,
        error: null,
        loadingPreview: false,
        retainedFrame: get(retainedFrame$),
        blank: false,
      };
    }
    const presentation = get(model.presentation$);
    const lease = get(installed$);
    return {
      ...presentation,
      retainedFrame: get(retainedFrame$),
      blank:
        get(authority$) &&
        lease !== null &&
        !get(model.imageRecovery$) &&
        !get(model.controls$).recovery &&
        presentation.status !== "paused" &&
        (presentation.blank || get(lease.controller.creatingTab$)),
    };
  });
  const navigation$ = computed((get) => {
    const lease = get(installed$);
    return get(authority$) && lease ? get(lease.controller.navigation$) : null;
  });
  const history$ = computed(async (get) => {
    const lease = get(installed$);
    return get(authority$) && lease
      ? await get(lease.controller.history$)
      : null;
  });
  const navigationScope$ = computed((get) => {
    const lease = get(installed$);
    return get(authority$) && lease
      ? get(lease.controller.navigationScope$)
      : null;
  });
  const displayRecovery$ = computed((get) => {
    const lease = get(installed$);
    return get(authority$) && lease
      ? get(lease.controller.displayRecovery$)
      : null;
  });
  return {
    display$,
    controls$,
    presentation$,
    navigation$,
    history$,
    navigationScope$,
    displayRecovery$,
  };
}

/** Application layout commits name their change; no observer infers it later. */
function createLayoutSync(
  context: RuntimeState,
  syncTabs$: Command<void, [motion?: TabStripMotion | null]>,
) {
  const { installed$ } = context;
  return command(({ get, set }, motion?: TabStripMotion | null) => {
    set(syncTabs$, motion);
    const lease = get(installed$);
    if (lease) {
      set(
        lease.controller.measure$,
        measureDisplay(lease.identity.nodes.canvas.node),
      );
    }
  });
}

function createRuntimeRecovery(
  context: RuntimeState,
  graph: RuntimeGraph,
  actions: ReturnType<typeof createConfigurationActions>,
) {
  const view$ = computed((get): RecoveryView => {
    const lease = get(context.installed$);
    const controls = get(context.model.controls$);
    const snapshot = get(context.model.snapshot$);
    const intent = get(context.model.intent$);
    const authorized = get(context.authority$) && lease !== null;
    return {
      enabled: get(featureSwitch$)[FeatureSwitchKey.BrowserSharedOwner],
      paused: get(context.paused$),
      pending: get(context.pending$),
      nodes: get(graph.nodes$),
      binding: get(context.liveConnection$),
      intent: get(context.recoveryIntent$),
      targetId: intent.targetId,
      authorized,
      connected: lease !== null && get(lease.controller.connected$),
      usable:
        authorized &&
        ((controls.streaming && get(graph.selectedInput$) !== null) ||
          (get(context.model.empty$) && get(lease.controller.canCreate$))),
      snapshot,
      image: get(context.model.imageRecovery$),
    };
  });
  return createViewerRecovery({
    view$,
    reset$: context.resetAutomatic$,
    notification$: context.recoveryNotification$,
    notify$: context.recoveryChanged$,
    restoration$: context.recoveryTarget$,
    reconnect$: actions.reconnect$,
    retryImage$: actions.retryImage$,
  });
}

/** Compose private graphs in the existing App Store; expose only the public API. */
export function createBrowserRuntime(
  connection$: Computed<Promise<BrowserConnection | null>>,
  reloadConnection$: Command<void, []>,
  onPageInput$?: Command<void, []>,
): BrowserSignals {
  const context = createRuntimeState(connection$);
  const graph = createDOMGraph(context, onPageInput$);
  const lifecycle = createNativeLifecycle(context, graph);
  const tabStripNodes$ = computed((get) => {
    const toolbar = get(graph.toolbar.mounted$)?.node;
    const tabs = get(graph.tabs.mounted$)?.node;
    return toolbar && tabs ? { toolbar, tabs } : null;
  });
  const tabStrip = createTabStripLayout(
    tabStripNodes$,
    context.model.resizeTabs$,
  );
  const surface$ = onRef(
    command(({ set }, node: HTMLDivElement, signal: AbortSignal) => {
      set(graph.surface.mount$, node, signal);
      set(tabStrip.mount$, signal);
    }),
  );
  const tabActions = createTabActions(context, graph);
  const navigationActions = createNavigationActions(context, graph);
  const addressRef$ = onRef(
    command(({ set }, node: HTMLInputElement, signal: AbortSignal) => {
      // A remounted field must not replay feedback from an earlier interaction.
      set(navigationActions.notifyAddressSubmit$, null);
      set(graph.address.mount$, node, signal);
    }),
  );
  const configurationActions = createConfigurationActions(
    context,
    graph,
    reloadConnection$,
  );
  const recovery = createRuntimeRecovery(context, graph, configurationActions);
  const observers = createConnectionObservers(
    context,
    graph,
    lifecycle,
    recovery.watch$,
  );
  const presentation = createPresentation(context, graph);
  const { model } = context;
  const measureInitialDisplay$ = command(({ get }) => {
    if (get(model.windowSizeSync$) === "off") {
      return null;
    }
    const canvas = get(graph.canvas.mounted$);
    const size = canvas ? measureDisplay(canvas.node) : null;
    if (!size) {
      return null;
    }
    const { width, height, dpr } = constrainDisplay(size);
    return { width, height, dpr };
  });
  return {
    tabs$: model.tabs$,
    tabOrder$: computed((get) => {
      const binding = get(context.installed$)?.identity.connection.tabOrder;
      const inventory = get(model.snapshot$).inventory;
      return binding &&
        get(context.authority$) &&
        inventory.status === "complete"
        ? {
            ...binding,
            targetIds: inventory.targets.map((target) => {
              return target.id;
            }),
          }
        : null;
    }),
    selectedTabId$: model.selectedTabId$,
    address$: model.address$,
    imageRecovery$: model.imageRecovery$,
    capture$: model.capture$,
    transport$: model.transport$,
    windowSizeSync$: model.windowSizeSync$,
    clipboardRecovery$: graph.native.recovery$,
    proxyType$: graph.native.proxyType$,
    tabLayout$: model.tabLayout$,
    focusHandoff$: graph.focus.handoff$,
    acknowledgeFocusCommit$: graph.focus.acknowledge$,
    rejectFavicon$: model.rejectFavicon$,
    editAddress$: model.editAddress$,
    resetAddress$: model.resetAddress$,
    beginAddressEdit$: model.beginAddressEdit$,
    blurAddress$: model.blurAddress$,
    dismissClipboardRecovery$: graph.native.dismissClipboard$,
    ...tabActions,
    ...navigationActions,
    ...configurationActions,
    reconnect$: recovery.reconnect$,
    retryImage$: recovery.retryImage$,
    recoveryOperation$: recovery.operation$,
    ...presentation,
    connectionChanged$: context.connectionChanged$,
    syncLayout$: createLayoutSync(context, tabStrip.sync$),
    measureInitialDisplay$,
    refs: {
      root$: observers.root$,
      canvas$: graph.canvas.ref$,
      input$: graph.inputNode.ref$,
      toolbar$: graph.toolbar.ref$,
      tabs$: graph.tabs.ref$,
      address$: addressRef$,
      surface$,
    },
  };
}
