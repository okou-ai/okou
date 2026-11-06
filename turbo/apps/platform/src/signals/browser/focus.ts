import { command, computed, state, type Computed } from "ccstate";
import type { BrowserFocusHandoff, BrowserSignals } from "./browser.ts";

export interface ToolbarNodes {
  readonly toolbar: HTMLDivElement;
  readonly tabs: HTMLDivElement;
  readonly address: HTMLInputElement;
}
interface FocusSources {
  readonly authority$: Computed<object | null>;
  readonly selection$: Computed<object>;
  readonly selectedTabId$: BrowserSignals["selectedTabId$"];
  readonly tabs$: BrowserSignals["tabs$"];
  readonly tabLayout$: BrowserSignals["tabLayout$"];
}
interface ToolbarMount {
  readonly toolbar: HTMLDivElement;
}
export interface ToolbarFocusToken {
  readonly request: object;
}
interface SelectedFocus {
  readonly targetId: string;
  readonly selection: object;
}
type ProjectionOrigin =
  | { readonly kind: "tab"; readonly targetId: string }
  | { readonly kind: "picker" };
type FocusAction =
  | {
      readonly kind: "select";
      readonly targetId: string;
      readonly ready: SelectedFocus | null;
    }
  | {
      readonly kind: "close";
      readonly targetId: string;
      readonly ready: boolean;
    }
  | { readonly kind: "projection"; readonly origin: ProjectionOrigin };
interface FocusRequest {
  readonly token: ToolbarFocusToken;
  readonly mount: ToolbarMount;
  readonly authority: object;
  readonly origin: HTMLElement;
  readonly unregisterAbort: (() => void) | null;
  readonly action: FocusAction;
}

function findTab(nodes: ToolbarNodes, targetId: string) {
  return [...nodes.tabs.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (tab) => {
      return tab.dataset.browserTabId === targetId;
    },
  );
}
function isTab(nodes: ToolbarNodes, element: Element | null) {
  return (
    element instanceof HTMLElement &&
    nodes.tabs.contains(element) &&
    element.getAttribute("role") === "tab"
  );
}
function retainsOrigin(
  request: FocusRequest,
  active: Element | null,
  nodes: ToolbarNodes,
): boolean {
  if (active === request.origin || active === document.body) {
    return true;
  }
  // Base UI may temporarily return close focus to a tab. Explicit pointer and
  // navigation-key intent cancels before that fallback can be mistaken for it.
  if (request.action.kind === "close") {
    return isTab(nodes, active);
  }
  return (
    request.action.kind === "select" &&
    isTab(nodes, active) &&
    active instanceof HTMLElement &&
    active.dataset.browserTabId === request.action.targetId
  );
}
function usable(element: HTMLElement): boolean {
  return (
    element.isConnected &&
    !element.matches(":disabled") &&
    element.getAttribute("aria-disabled") !== "true" &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]')
  );
}
function requestedTarget(action: FocusAction): string | null {
  if (action.kind === "projection") {
    return action.origin.kind === "tab" ? action.origin.targetId : null;
  }
  return action.targetId;
}

function ownsFocusRequest(
  request: FocusRequest,
  mount: ToolbarMount | null,
  authority: object | null,
): boolean {
  return request.mount === mount && request.authority === authority;
}

function selectedCandidate(
  action: Extract<FocusAction, { kind: "select" }>,
  selected: string | null,
  selection: object,
  present: boolean,
): SelectedFocus | null {
  return action.ready &&
    action.ready.targetId === selected &&
    action.ready.selection === selection &&
    present
    ? action.ready
    : null;
}

function createFocusState(
  nodes$: Computed<ToolbarNodes | null>,
  sources: FocusSources,
) {
  const mount$ = state<ToolbarMount | null>(null);
  const request$ = state<FocusRequest | null>(null);
  // Only semantic inventory/admission changes can wake a projection handoff;
  // titles, pixels and numeric tab widths do not change its identity.
  const hasTargets$ = computed((get) => {
    return get(sources.tabs$).length !== 0;
  });
  const selectedPresent$ = computed((get) => {
    const selected = get(sources.selectedTabId$);
    return get(sources.tabs$).some((tab) => {
      return tab.id === selected;
    });
  });
  const selectedAdmitted$ = computed((get) => {
    const selected = get(sources.selectedTabId$);
    return get(sources.tabLayout$).items.some(({ target }) => {
      return target.id === selected;
    });
  });
  const requestedPresent$ = computed((get) => {
    const request = get(request$);
    const targetId = request ? requestedTarget(request.action) : null;
    return get(sources.tabs$).some((tab) => {
      return tab.id === targetId;
    });
  });
  const requestedAdmitted$ = computed((get) => {
    const request = get(request$);
    const targetId = request ? requestedTarget(request.action) : null;
    return get(sources.tabLayout$).items.some(({ target }) => {
      return target.id === targetId;
    });
  });
  const overflow$ = computed((get) => {
    return get(sources.tabLayout$).overflow;
  });
  const handoff$ = computed((get): BrowserFocusHandoff | null => {
    const request = get(request$);
    if (
      !request ||
      !ownsFocusRequest(request, get(mount$), get(sources.authority$))
    ) {
      return null;
    }
    const action = request.action;
    const selected = get(sources.selectedTabId$);
    const selection = get(sources.selection$);
    const identity = {
      request: request.token,
      mount: request.mount,
      selection,
    };
    if (action.kind === "select") {
      const candidate = selectedCandidate(
        action,
        selected,
        selection,
        get(selectedPresent$),
      );
      if (!candidate) {
        return null;
      }
    } else if (action.kind === "close") {
      if (!action.ready || get(requestedPresent$)) {
        return null;
      }
    } else if (
      action.origin.kind === "picker" ? get(overflow$) : get(requestedAdmitted$)
    ) {
      return null;
    }
    if (get(hasTargets$)) {
      // Inventory can precede successor selection. Never focus a retired target
      // or an unrelated first tab during that intermediate projection.
      if (!selected || !get(selectedPresent$)) {
        return null;
      }
      return get(selectedAdmitted$)
        ? { ...identity, kind: "tab", targetId: selected }
        : get(overflow$)
          ? { ...identity, kind: "toolbar", destination: "picker" }
          : null;
    }
    return { ...identity, kind: "toolbar", destination: "new-tab" };
  });
  return { nodes$, sources, mount$, request$, handoff$ };
}
type FocusGraph = ReturnType<typeof createFocusState>;

function createFocusCancellation(graph: FocusGraph) {
  const { mount$, request$ } = graph;
  const cancel$ = command(({ get, set }, token: ToolbarFocusToken | null) => {
    const request = get(request$);
    if (request && request.token === token) {
      set(request$, null);
      request.unregisterAbort?.();
    }
  });
  const discard$ = command(({ get, set }) => {
    set(cancel$, get(request$)?.token ?? null);
  });
  const reset$ = command(({ get, set }, mount: ToolbarMount) => {
    if (get(mount$) === mount) {
      set(discard$);
      set(mount$, null);
    }
  });
  const revoke$ = command(({ get, set }, authority: object) => {
    if (get(request$)?.authority === authority) {
      set(discard$);
    }
  });
  return { cancel$, discard$, reset$, revoke$ };
}
type FocusCancellation = ReturnType<typeof createFocusCancellation>;

function createFocusActions(
  graph: FocusGraph,
  cancellation: FocusCancellation,
) {
  const { nodes$, sources, mount$, request$ } = graph;
  const begin$ = command(
    (
      { get, set },
      action: FocusAction,
      authority: object,
      signal: AbortSignal,
    ): ToolbarFocusToken | null => {
      set(cancellation.discard$);
      signal.throwIfAborted();
      const mount = get(mount$);
      const nodes = get(nodes$);
      const origin = document.activeElement;
      if (
        !mount ||
        !nodes ||
        mount.toolbar !== nodes.toolbar ||
        authority !== get(sources.authority$) ||
        !(origin instanceof HTMLElement)
      ) {
        return null;
      }
      if (
        (action.kind === "close" &&
          (origin.dataset.closeTarget !== action.targetId ||
            !nodes.toolbar.contains(origin))) ||
        (action.kind === "select" && !isTab(nodes, origin))
      ) {
        return null;
      }
      const token: ToolbarFocusToken = { request: {} };
      const aborted = () => {
        set(cancellation.cancel$, token);
      };
      set(request$, {
        token,
        mount,
        authority,
        origin,
        action,
        unregisterAbort: () => {
          signal.removeEventListener("abort", aborted);
        },
      });
      signal.addEventListener("abort", aborted, { once: true });
      return token;
    },
  );
  const beginClose$ = command(
    ({ set }, targetId: string, authority: object, signal: AbortSignal) => {
      return set(
        begin$,
        { kind: "close", targetId, ready: false },
        authority,
        signal,
      );
    },
  );
  const beginSelect$ = command(
    ({ set }, targetId: string, authority: object, signal: AbortSignal) => {
      return set(
        begin$,
        { kind: "select", targetId, ready: null },
        authority,
        signal,
      );
    },
  );
  return { beginClose$, beginSelect$ };
}

function createFocusAuthorization(
  graph: FocusGraph,
  cancellation: FocusCancellation,
) {
  const { sources, mount$, request$ } = graph;
  const authorize$ = command(
    (
      { get, set },
      token: ToolbarFocusToken | null,
      kind: "select" | "close",
    ) => {
      const request = get(request$);
      if (!request || request.token !== token || request.action.kind !== kind) {
        return;
      }
      if (!ownsFocusRequest(request, get(mount$), get(sources.authority$))) {
        set(cancellation.cancel$, token);
        return;
      }
      const action = request.action;
      if (action.kind === "close") {
        set(request$, { ...request, action: { ...action, ready: true } });
      } else if (action.kind === "select") {
        const targetId = action.targetId;
        if (!targetId || targetId !== get(sources.selectedTabId$)) {
          set(cancellation.cancel$, token);
          return;
        }
        set(request$, {
          ...request,
          action: {
            ...action,
            ready: { targetId, selection: get(sources.selection$) },
          },
        });
      }
    },
  );
  const closed$ = command(({ set }, token: ToolbarFocusToken | null) => {
    set(authorize$, token, "close");
  });
  const selected$ = command(({ set }, token: ToolbarFocusToken | null) => {
    set(authorize$, token, "select");
  });
  return { closed$, selected$ };
}

function createFocusRequests(graph: FocusGraph) {
  const { sources, mount$, request$ } = graph;
  const cancellation = createFocusCancellation(graph);
  const actions = createFocusActions(graph, cancellation);
  const authorization = createFocusAuthorization(graph, cancellation);
  const track$ = command(({ get, set }, origin: HTMLElement) => {
    const mount = get(mount$);
    const authority = get(sources.authority$);
    const targetId = origin.dataset.browserTabId;
    const projection: ProjectionOrigin | null = targetId
      ? { kind: "tab", targetId }
      : Object.hasOwn(origin.dataset, "browserTabPicker")
        ? { kind: "picker" }
        : null;
    if (mount && authority && projection) {
      set(cancellation.discard$);
      set(request$, {
        token: { request: {} },
        mount,
        authority,
        origin,
        unregisterAbort: null,
        action: { kind: "projection", origin: projection },
      });
    }
  });
  return { ...cancellation, ...actions, ...authorization, track$ };
}
type FocusRequests = ReturnType<typeof createFocusRequests>;

function ownsFocusCommit(
  request: FocusRequest,
  handoff: BrowserFocusHandoff,
  nodes: ToolbarNodes | null,
  mount: ToolbarMount | null,
  authority: object | null,
): nodes is ToolbarNodes {
  return (
    nodes !== null &&
    ownsFocusRequest(request, mount, authority) &&
    request.token === handoff.request &&
    request.mount === handoff.mount &&
    request.mount.toolbar === nodes.toolbar &&
    nodes.toolbar.isConnected &&
    nodes.tabs.isConnected &&
    nodes.address.isConnected
  );
}

function hasCommittedRemoval(
  nodes: ToolbarNodes,
  action: FocusAction,
): boolean {
  if (action.kind === "close") {
    return !findTab(nodes, action.targetId);
  }
  if (action.kind === "projection") {
    return action.origin.kind === "tab"
      ? !findTab(nodes, action.origin.targetId)
      : !nodes.toolbar.querySelector("[data-browser-tab-picker]");
  }
  return true;
}

function committedDestination(
  nodes: ToolbarNodes,
  handoff: BrowserFocusHandoff,
  selectedTargetId: string | null,
): HTMLElement | null {
  if (handoff.kind === "toolbar") {
    return nodes.toolbar.querySelector<HTMLElement>(
      handoff.destination === "picker"
        ? "[data-browser-tab-picker]"
        : "[data-browser-new-tab]",
    );
  }
  if (handoff.targetId !== selectedTargetId) {
    return null;
  }
  const tab = findTab(nodes, handoff.targetId);
  return tab?.getAttribute("aria-selected") === "true" ? tab : null;
}

function createFocusCommit(graph: FocusGraph, requests: FocusRequests) {
  const { nodes$, mount$, request$, handoff$, sources } = graph;
  return command(({ get, set }, handoff: BrowserFocusHandoff) => {
    const request = get(request$);
    if (!request || handoff !== get(handoff$)) {
      return;
    }
    const nodes = get(nodes$);
    if (
      !ownsFocusCommit(
        request,
        handoff,
        nodes,
        get(mount$),
        get(sources.authority$),
      ) ||
      handoff.selection !== get(sources.selection$)
    ) {
      set(requests.cancel$, request.token);
      return;
    }
    if (!hasCommittedRemoval(nodes, request.action)) {
      return;
    }
    const destination = committedDestination(
      nodes,
      handoff,
      get(sources.selectedTabId$),
    );
    if (!destination || !usable(destination)) {
      return;
    }
    if (!retainsOrigin(request, document.activeElement, nodes)) {
      set(requests.cancel$, request.token);
      return;
    }
    // Consume before focusin/onFocus can synchronously create an address draft.
    set(requests.cancel$, request.token);
    if (document.activeElement !== destination) {
      destination.focus({ preventScroll: true });
    }
  });
}

function createFocusListeners(graph: FocusGraph, requests: FocusRequests) {
  const { nodes$, mount$, request$ } = graph;
  return command(
    ({ get, set }, toolbar: HTMLDivElement, signal: AbortSignal) => {
      const previous = get(mount$);
      if (previous) {
        set(requests.reset$, previous);
      }
      const mount: ToolbarMount = { toolbar };
      set(mount$, mount);
      signal.addEventListener(
        "abort",
        () => {
          set(requests.reset$, mount);
        },
        { once: true },
      );
      document.addEventListener(
        "focusin",
        (event) => {
          if (get(mount$) !== mount) {
            return;
          }
          const nodes = get(nodes$);
          if (!nodes || nodes.toolbar !== toolbar) {
            return;
          }
          const active = event.target instanceof Element ? event.target : null;
          const request = get(request$);
          if (request && !retainsOrigin(request, active, nodes)) {
            set(requests.cancel$, request.token);
          }
          if (
            !get(request$) &&
            active instanceof HTMLElement &&
            (isTab(nodes, active) ||
              (nodes.toolbar.contains(active) &&
                Object.hasOwn(active.dataset, "browserTabPicker")))
          ) {
            // This explicit focus origin, not a layout/render, authorizes the
            // one-shot recovery if admission later removes its committed tab.
            set(requests.track$, active);
          }
        },
        { signal },
      );
      document.addEventListener(
        "pointerdown",
        (event) => {
          const request = get(request$);
          if (
            get(mount$) === mount &&
            request &&
            event.target instanceof Node &&
            !request.origin.contains(event.target)
          ) {
            set(requests.cancel$, request.token);
          }
        },
        { signal, capture: true },
      );
      document.addEventListener(
        "keydown",
        (event) => {
          if (
            get(mount$) === mount &&
            [
              "Tab",
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
            ].includes(event.key)
          ) {
            set(requests.discard$);
          }
        },
        { signal, capture: true },
      );
    },
  );
}

/** Focus intent belongs to the toolbar mount, independently of the CDP lease. */
export function createToolbarFocus(
  nodes$: Computed<ToolbarNodes | null>,
  sources: FocusSources,
) {
  const graph = createFocusState(nodes$, sources);
  const requests = createFocusRequests(graph);
  const newAddress$ = command(({ get, set }) => {
    set(requests.discard$);
    const address = get(nodes$)?.address;
    if (address && usable(address)) {
      // Local editing starts in the trusted New tab gesture, not a remote receipt.
      address.focus({ preventScroll: true });
    }
  });
  const release$ = command(({ get }) => {
    const nodes = get(nodes$);
    if (!nodes) {
      return;
    }
    (
      nodes.tabs.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      ) ??
      nodes.tabs.querySelector<HTMLElement>('[role="tab"]') ??
      nodes.toolbar.querySelector<HTMLElement>("[data-browser-tab-picker]") ??
      nodes.toolbar.querySelector<HTMLElement>("[data-browser-new-tab]")
    )?.focus({ preventScroll: true });
  });
  return {
    release$,
    newAddress$,
    beginClose$: requests.beginClose$,
    beginSelect$: requests.beginSelect$,
    closed$: requests.closed$,
    selected$: requests.selected$,
    cancel$: requests.cancel$,
    revoke$: requests.revoke$,
    handoff$: graph.handoff$,
    acknowledge$: createFocusCommit(graph, requests),
    listen$: createFocusListeners(graph, requests),
  };
}
