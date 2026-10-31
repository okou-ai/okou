import { command, state, type Command, type Computed } from "ccstate";
import { createDeferredPromise, resetSignal } from "../utils.ts";

export interface ToolbarNodes {
  readonly toolbar: HTMLDivElement;
  readonly tabs: HTMLDivElement;
  readonly address: HTMLInputElement;
}

function createFocusState(nodes$: Computed<ToolbarNodes | null>) {
  return {
    nodes$,
    createOrigin$: state<Element | null>(null),
    resetCreateFocus$: resetSignal(),
    closing$: state<{
      readonly targetId: string;
      readonly origin: HTMLElement;
    } | null>(null),
    restore$: state(false),
    toolbarFocus$: state<HTMLElement | null>(null),
  };
}
type FocusState = ReturnType<typeof createFocusState>;

function createFocusTargets(graph: FocusState) {
  const {
    nodes$,
    createOrigin$,
    resetCreateFocus$,
    closing$,
    restore$,
    toolbarFocus$,
  } = graph;
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
  const beginCreate$ = command(({ set }) => {
    set(resetCreateFocus$, AbortSignal.abort());
    set(createOrigin$, document.activeElement);
  });
  const created$ = command(async ({ get, set }, signal: AbortSignal) => {
    const origin = get(createOrigin$);
    const nodes = get(nodes$);
    if (
      !origin ||
      !nodes ||
      (document.activeElement !== origin &&
        document.activeElement !== document.body)
    ) {
      set(createOrigin$, null);
      return;
    }
    const owner = set(resetCreateFocus$, signal);
    if (nodes.address.disabled) {
      // One actual disabled-attribute commit acknowledges this create's focus
      // handoff; this is not a broad observer of application state.
      const enabled = createDeferredPromise<void>(owner);
      const observer = new MutationObserver(() => {
        if (!nodes.address.disabled && !enabled.settled()) {
          enabled.resolve();
        }
      });
      observer.observe(nodes.address, {
        attributes: true,
        attributeFilter: ["disabled"],
      });
      using _observer = {
        [Symbol.dispose]: () => {
          observer.disconnect();
        },
      };
      const [committed] = await Promise.allSettled([enabled.promise]);
      signal.throwIfAborted();
      if (owner.aborted) {
        signal.throwIfAborted();
        return;
      }
      if (committed.status === "rejected") {
        throw committed.reason;
      }
    }
    if (owner.aborted) {
      signal.throwIfAborted();
      return;
    }
    if (
      get(createOrigin$) === origin &&
      (document.activeElement === origin ||
        document.activeElement === document.body)
    ) {
      nodes.address.focus({ preventScroll: true });
    }
    set(createOrigin$, null);
    set(resetCreateFocus$, AbortSignal.abort());
  });
  const reset$ = command(({ set }) => {
    set(resetCreateFocus$, AbortSignal.abort());
    set(createOrigin$, null);
    set(closing$, null);
    set(restore$, false);
    set(toolbarFocus$, null);
  });
  const cancelCreate$ = command(({ set }) => {
    set(resetCreateFocus$, AbortSignal.abort());
    set(createOrigin$, null);
  });
  return { release$, beginCreate$, created$, reset$, cancelCreate$ };
}

function createCloseFocus(graph: FocusState, release$: Command<void, []>) {
  const { nodes$, closing$, restore$ } = graph;
  const beginClose$ = command(({ set }, targetId: string) => {
    const origin = document.activeElement;
    set(
      closing$,
      origin instanceof HTMLElement && origin.dataset.closeTarget === targetId
        ? { targetId, origin }
        : null,
    );
  });
  const closed$ = command(({ get, set }, targetId: string) => {
    const closing = get(closing$);
    const nodes = get(nodes$);
    const active = document.activeElement;
    set(
      restore$,
      !!closing &&
        closing.targetId === targetId &&
        (active === document.body ||
          active === closing.origin ||
          (!!nodes &&
            active instanceof HTMLElement &&
            nodes.tabs.contains(active) &&
            active.getAttribute("role") === "tab")),
    );
    set(closing$, null);
  });
  const restoreAfterClose$ = command(({ get, set }) => {
    if (!get(restore$)) {
      return;
    }
    const nodes = get(nodes$);
    if (!nodes) {
      return;
    }
    if (
      document.activeElement !== document.body &&
      !nodes.toolbar.contains(document.activeElement)
    ) {
      set(restore$, false);
      return;
    }
    if (
      !nodes.tabs.querySelector('[role="tab"][aria-selected="true"]') &&
      nodes.tabs.querySelector('[role="tab"]')
    ) {
      return;
    }
    set(restore$, false);
    set(release$);
  });
  return { beginClose$, closed$, restoreAfterClose$ };
}

function createFocusObservations(
  graph: FocusState,
  release$: Command<void, []>,
  cancelCreate$: Command<void, []>,
) {
  const { nodes$, createOrigin$, closing$, restore$, toolbarFocus$ } = graph;
  const restoreLayout$ = command(({ get, set }) => {
    const origin = get(toolbarFocus$);
    if (
      origin &&
      (!origin.isConnected || !origin.getClientRects().length) &&
      (document.activeElement === document.body ||
        document.activeElement === origin)
    ) {
      set(release$);
    }
  });
  const listen$ = command(({ get, set }, signal: AbortSignal) => {
    document.addEventListener(
      "focusin",
      (event) => {
        const nodes = get(nodes$);
        const active = event.target;
        const createOrigin = get(createOrigin$);
        if (
          createOrigin &&
          active !== createOrigin &&
          active !== document.body
        ) {
          set(cancelCreate$);
        }
        set(
          toolbarFocus$,
          active instanceof HTMLElement && nodes?.toolbar.contains(active)
            ? active
            : null,
        );
        // A newly chosen address/control supersedes an already queued post-close
        // restoration, including the gap before MutationObserver runs.
        if (
          active instanceof HTMLElement &&
          active !== document.body &&
          active.getAttribute("role") !== "tab"
        ) {
          set(restore$, false);
        }
        const closing = get(closing$);
        if (
          closing &&
          active !== closing.origin &&
          active !== document.body &&
          !(
            active instanceof HTMLElement &&
            nodes?.tabs.contains(active) &&
            active.getAttribute("role") === "tab"
          )
        ) {
          set(closing$, null);
        }
      },
      { signal },
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        const nodes = get(nodes$);
        if (
          event.target instanceof Node &&
          !nodes?.toolbar.contains(event.target)
        ) {
          set(cancelCreate$);
          set(toolbarFocus$, null);
          set(closing$, null);
          set(restore$, false);
        }
      },
      { signal },
    );
  });
  return { restoreLayout$, listen$ };
}

/** Focus intent is local to a mounted toolbar, independently of remote input. */
export function createToolbarFocus(nodes$: Computed<ToolbarNodes | null>) {
  const graph = createFocusState(nodes$);
  const targets = createFocusTargets(graph);
  const closing = createCloseFocus(graph, targets.release$);
  const observations = createFocusObservations(
    graph,
    targets.release$,
    targets.cancelCreate$,
  );
  return { ...targets, ...closing, ...observations };
}
