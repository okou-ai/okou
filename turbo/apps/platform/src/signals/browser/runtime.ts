import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  createDeferredPromise,
  detach,
  isAbortError,
  onRef,
  Reason,
  resetSignal,
  type DeferredPromise,
} from "../utils.ts";
import { pageSignal$ } from "../page-signal.ts";
import type { BrowserSignals } from "./browser.ts";
import { CdpFault, diagnostic } from "./cdp/errors.ts";
import { measureDisplay, observeDisplay } from "./display.ts";
import type { DisplaySize } from "./display/geometry.ts";
import { createToolbarFocus } from "./focus.ts";
import { navigationAddress } from "./input/address.ts";
import { createNativeInput } from "./input/native.ts";
import {
  NavigationFault,
  type BrowserNavigationAction,
} from "./navigation/action.ts";
import { observeTabStrip } from "./tab-strip.ts";
import { createBrowserController } from "./viewer/controller.ts";
import { createViewerSignals } from "./viewer/model.ts";
import type { TabSpace } from "./viewer/tab-layout.ts";
import type {
  BrowserConnection,
  NavigationReceipt,
  ViewerCaptureOptions,
  ViewerTransport,
  WindowSizeSync,
} from "./viewer/types.ts";

interface Mounted<E extends HTMLElement> {
  readonly node: E;
}
interface BrowserNodes {
  readonly canvas: Mounted<HTMLCanvasElement>;
  readonly input: Mounted<HTMLTextAreaElement>;
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
type Controller = ReturnType<typeof createBrowserController>;
interface NativeLease {
  readonly identity: BrowserIdentity;
  readonly controller: Controller;
  readonly resetRetirement$: ReturnType<typeof resetSignal>;
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
  const ref$ = onRef(
    command(({ get, set }, node: E, signal: AbortSignal) => {
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
    }),
  );
  return { mounted$, ref$ };
}

function createRuntimeState(
  connection$: Computed<Promise<BrowserConnection | null>>,
) {
  const installed$ = state<NativeLease | null>(null);
  const retiring$ = state<ReadonlySet<NativeLease>>(new Set());
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
  const model = createViewerSignals(
    remoteNavigation$,
    remoteNavigationScope$,
    creationReadySource$,
  );
  const confirmedRequest$ = state<
    Promise<BrowserConnection | null> | undefined
  >(undefined);
  const liveConnection$ = state<BrowserConnection | null>(null);
  const generation$ = state(0);
  const observer$ = state<object | null>(null);
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
    installed$,
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

function createMountedNodeGraph(
  released$: Command<void, [object]>,
  connectionChanged$: Command<void, []>,
) {
  const surface = createNodeRef<HTMLDivElement>(released$, connectionChanged$);
  const canvas = createNodeRef<HTMLCanvasElement>(
    released$,
    connectionChanged$,
  );
  const inputNode = createNodeRef<HTMLTextAreaElement>(
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
function createDOMGraph(context: RuntimeState) {
  const {
    model,
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
  const focus = createToolbarFocus(toolbarNodes$);
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
  const native = createNativeInput(selectedInput$, focus.release$);
  const controllerGraph$ = computed((get) => {
    const identity = get(identity$);
    return identity
      ? {
          identity,
          resetRetirement$: resetSignal(),
          controller: createBrowserController(
            model,
            identity.connection,
            identity.nodes.canvas.node,
            authority$,
            native,
          ),
        }
      : null;
  });
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
    surface,
    canvas,
    inputNode,
    toolbar,
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
  const {
    model,
    installed$,
    retiring$,
    documentHidden$,
    inViewport$,
    paused$,
  } = context;
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
      detach(
        set(finishRetirement$, lease, retirement),
        Reason.DomCallback,
        "browser native retirement",
      );
    }
    if (get(installed$) !== lease) {
      return;
    }
    set(native.dispose$);
    set(focus.reset$);
    set(installed$, null);
  });
  const measure$ = command(
    ({ get, set }, lease: NativeLease, size: DisplaySize | null) => {
      if (get(installed$) === lease) {
        set(lease.controller.measure$, size);
      }
    },
  );
  const resizeTabs$ = command(
    ({ get, set }, lease: NativeLease, space: TabSpace) => {
      if (get(installed$) === lease) {
        set(model.resizeTabs$, space);
      }
    },
  );
  const visibility$ = command(
    async (
      { get, set },
      lease: NativeLease,
      hidden: boolean,
      signal: AbortSignal,
    ) => {
      if (get(installed$) !== lease) {
        throw cancelled();
      }
      set(documentHidden$, hidden);
      await set(lease.controller.pause$, get(paused$), signal);
    },
  );
  const intersection$ = command(
    async (
      { get, set },
      lease: NativeLease,
      visible: boolean,
      signal: AbortSignal,
    ) => {
      if (get(installed$) !== lease) {
        throw cancelled();
      }
      set(inViewport$, visible);
      await set(lease.controller.pause$, get(paused$), signal);
    },
  );
  return { releaseNative$, measure$, resizeTabs$, visibility$, intersection$ };
}

/** Native startup keeps its DOM owner even if a request observer is replaced. */
function createNativeMount(context: RuntimeState, graph: RuntimeGraph) {
  const { model, installed$, inViewport$, documentHidden$, paused$ } = context;
  const { retireLease$, native, focus } = graph;
  const observations = createNativeObservations(context, graph);
  return command(
    async (
      { get, set },
      lease: NativeLease,
      owner: AbortSignal,
    ): Promise<void> => {
      owner.throwIfAborted();
      const nodes = lease.identity.nodes;
      const cleanups: (() => void)[] = [];
      owner.addEventListener(
        "abort",
        () => {
          for (const cleanup of cleanups.splice(0)) {
            cleanup();
          }
          set(observations.releaseNative$, lease);
        },
        { once: true },
      );
      const [setup] = await Promise.allSettled([
        (async () => {
          set(model.transition$, { type: "reset" });
          set(model.configure$, lease.identity.connection.windowId !== null);
          set(inViewport$, true);
          set(documentHidden$, document.hidden);
          set(
            native.bind$,
            nodes.surface.node,
            nodes.canvas.node,
            nodes.input.node,
            owner,
          );
          set(focus.listen$, owner);
          document.addEventListener(
            "visibilitychange",
            () => {
              detach(
                set(observations.visibility$, lease, document.hidden, owner),
                Reason.DomCallback,
                "browser visibility",
              );
            },
            { signal: owner },
          );
          const viewport = new IntersectionObserver((entries) => {
            const entry = entries.at(-1);
            if (entry) {
              detach(
                set(
                  observations.intersection$,
                  lease,
                  entry.isIntersecting,
                  owner,
                ),
                Reason.DomCallback,
                "browser viewport",
              );
            }
          });
          viewport.observe(nodes.canvas.node);
          cleanups.push(() => {
            viewport.disconnect();
          });
          observeDisplay(
            nodes.canvas.node,
            (size) => {
              set(observations.measure$, lease, size);
            },
            owner,
          );
          const strip = observeTabStrip(
            nodes.toolbar.node,
            nodes.tabs.node,
            (space) => {
              set(observations.resizeTabs$, lease, space);
            },
          );
          cleanups.push(strip.close);
          const mutation = new MutationObserver(() => {
            if (get(installed$) !== lease) {
              return;
            }
            set(focus.restoreAfterClose$);
            set(focus.restoreLayout$);
          });
          mutation.observe(nodes.tabs.node, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["aria-selected"],
          });
          cleanups.push(() => {
            mutation.disconnect();
          });
          await set(lease.controller.pause$, get(paused$), owner);
        })(),
      ]);
      owner.throwIfAborted();
      if (setup.status === "rejected") {
        set(retireLease$, lease);
        throw setup.reason;
      }
      await set(lease.controller.start$, owner);
      owner.throwIfAborted();
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
        set(retireLease$, lease);
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
    },
  );
}

/** Current request equality is the authority fence; no mirrored loading state. */
function createConnectionObservers(
  context: RuntimeState,
  graph: RuntimeGraph,
  lifecycle: NativeLifecycle,
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
  return { root$: createRootObservation(context, graph, observeConnection$) };
}

/** The stable real DOM owner and page lifetime settle every parked receipt. */
function createRootObservation(
  context: RuntimeState,
  graph: RuntimeGraph,
  observeConnection$: ConnectionObservation,
) {
  const { installed$, observer$, connection$ } = context;
  const { nodes$, retireLease$ } = graph;
  return onRef(
    command(
      async ({ get, set }, root: HTMLDivElement, mountSignal: AbortSignal) => {
        const signal = AbortSignal.any([mountSignal, get(pageSignal$)]);
        signal.throwIfAborted();
        signal.addEventListener(
          "abort",
          () => {
            set(context.resetObservation$, AbortSignal.abort(cancelled()));
            set(context.changeNotification$, null);
            const lease = get(installed$);
            if (lease && root.contains(lease.identity.nodes.surface.node)) {
              set(retireLease$, lease);
            }
          },
          { once: true },
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
          const [result] = await Promise.allSettled([
            set(
              observeConnection$,
              get(connection$),
              mountedNodes,
              observation,
            ),
          ]);
          signal.throwIfAborted();
          if (result.status === "rejected" && !isAbortError(result.reason)) {
            // Reconciliation already published its current failure. A future actual
            // notification, not an automatic retry, owns the next attempt.
            set(observer$, null);
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

function createTabActions(graph: RuntimeGraph) {
  const { requireController$, focus } = graph;
  const selectTab$ = command(
    async ({ set }, targetId: string, signal: AbortSignal) => {
      const lease = set(requireController$, signal);
      await set(lease.controller.selectTab$, targetId, signal);
    },
  );
  const createTab$ = command(
    async ({ set }, signal: AbortSignal): Promise<string> => {
      const lease = set(requireController$, signal);
      set(focus.beginCreate$);
      const [created] = await Promise.allSettled([
        set(lease.controller.createTab$, signal),
      ]);
      signal.throwIfAborted();
      if (created.status === "rejected") {
        set(focus.cancelCreate$);
        throw created.reason;
      }
      await set(focus.created$, signal);
      return created.value;
    },
  );
  const closeTab$ = command(
    async ({ set }, targetId: string, signal: AbortSignal) => {
      const lease = set(requireController$, signal);
      set(focus.beginClose$, targetId);
      await set(lease.controller.closeTab$, targetId, signal);
      // Positive close/inventory receipt does not depend on successor image.
      set(focus.closed$, targetId);
      set(focus.restoreAfterClose$);
    },
  );
  return { selectTab$, createTab$, closeTab$ };
}

function createNavigationActions(context: RuntimeState, graph: RuntimeGraph) {
  const { model } = context;
  const { requireController$ } = graph;
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
      const submission = set(model.prepareAddress$, scope);
      const url = navigationAddress(submission.value);
      if (!url) {
        throw new CdpFault("input", "Enter a valid page address.");
      }
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
  return { navigate$ };
}

function createConfigurationActions(
  context: RuntimeState,
  graph: RuntimeGraph,
  lifecycle: NativeLifecycle,
) {
  const { model, authority$, generation$ } = context;
  const { requireController$, nodes$, native } = graph;
  const reconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(authority$) || !get(nodes$)) {
      throw cancelled();
    }
    set(generation$, (value) => {
      return value + 1;
    });
    await set(lifecycle.install$, signal);
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
      set(model.setTransport$, transport);
      set(generation$, (value) => {
        return value + 1;
      });
      await set(lifecycle.install$, signal);
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
  const display$ = computed((get) => {
    const lease = get(installed$);
    const display = lease
      ? get(lease.controller.display$)
      : { ready: false, pending: false, pointerBlocked: true };
    return get(authority$) ? display : { ...display, pointerBlocked: true };
  });
  const controls$ = computed((get) => {
    const controls = get(model.controls$);
    const authorized = get(authority$) && get(installed$) !== null;
    const inputReady = get(graph.selectedInput$) !== null;
    return {
      ...controls,
      streaming: authorized && inputReady && controls.streaming,
      recovery: !get(pending$) && controls.recovery,
      showRecovery: !get(pending$) && controls.showRecovery,
      showEmptyCreate: authorized && controls.showEmptyCreate,
      canMutateTabs: authorized && controls.canMutateTabs,
      canCreate: authorized && controls.canCreate,
      tabsDisabled: !authorized || controls.tabsDisabled,
      canSyncDisplay:
        authorized && controls.canSyncDisplay && get(display$).ready,
      showImageRetry: !get(pending$) && controls.showImageRetry,
      canRetryImage: authorized && controls.canRetryImage,
    };
  });
  const presentation$ = computed((get) => {
    return get(pending$)
      ? { status: "connecting" as const, error: null, loadingPreview: false }
      : get(model.presentation$);
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
function createLayoutSync(context: RuntimeState) {
  const { installed$ } = context;
  return command(({ get, set }) => {
    const lease = get(installed$);
    if (lease) {
      set(
        lease.controller.measure$,
        measureDisplay(lease.identity.nodes.canvas.node),
      );
    }
  });
}

/** Compose private graphs in the existing App Store; expose only the public API. */
export function createBrowserRuntime(
  connection$: Computed<Promise<BrowserConnection | null>>,
): BrowserSignals {
  const context = createRuntimeState(connection$);
  const graph = createDOMGraph(context);
  const lifecycle = createNativeLifecycle(context, graph);
  const observers = createConnectionObservers(context, graph, lifecycle);
  const surface$ = graph.surface.ref$;
  const tabActions = createTabActions(graph);
  const navigationActions = createNavigationActions(context, graph);
  const configurationActions = createConfigurationActions(
    context,
    graph,
    lifecycle,
  );
  const presentation = createPresentation(context, graph);
  const { model } = context;
  return {
    tabs$: model.tabs$,
    selectedTabId$: model.selectedTabId$,
    address$: model.address$,
    imageRecovery$: model.imageRecovery$,
    capture$: model.capture$,
    transport$: model.transport$,
    windowSizeSync$: model.windowSizeSync$,
    clipboardRecovery$: graph.native.recovery$,
    tabLayout$: model.tabLayout$,
    rejectFavicon$: model.rejectFavicon$,
    editAddress$: model.editAddress$,
    resetAddress$: model.resetAddress$,
    focusAddress$: model.focusAddress$,
    blurAddress$: model.blurAddress$,
    dismissClipboardRecovery$: graph.native.dismissClipboard$,
    ...tabActions,
    ...navigationActions,
    ...configurationActions,
    ...presentation,
    connectionChanged$: context.connectionChanged$,
    syncLayout$: createLayoutSync(context),
    refs: {
      root$: observers.root$,
      canvas$: graph.canvas.ref$,
      input$: graph.inputNode.ref$,
      toolbar$: graph.toolbar.ref$,
      tabs$: graph.tabs.ref$,
      address$: graph.address.ref$,
      surface$,
    },
  };
}
