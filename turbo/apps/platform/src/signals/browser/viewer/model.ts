import { createAddressSignals } from "../navigation/address.ts";
import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  initialInventory,
  inventorySnapshot,
  transitionInventory,
  type InventoryEvent,
} from "./target-inventory.ts";
import { layoutTabs, type TabSpace } from "./tab-layout.ts";
import type {
  ViewerCaptureOptions,
  ViewerError,
  ViewerNavigation,
  ViewerSnapshot,
  ViewerTransport,
  WindowSizeSync,
} from "./types.ts";
import {
  retryingImage,
  transitionImage,
  type ImageEvent,
  type ImageRecovery,
} from "./image-recovery.ts";
import { initialIntent, transitionIntent } from "./lifecycle.ts";

export type ViewerTransition =
  | { type: "reset" }
  | { type: "select"; targetId: string; paused: boolean; preview?: boolean }
  | { type: "target-lost"; error: ViewerError | null }
  | { type: "discovery-failed"; error: ViewerError }
  | { type: "streaming" }
  | { type: "stopped"; retainFrame?: boolean }
  | { type: "pause"; paused: boolean; preview?: boolean }
  | { type: "closed" }
  | { type: "failed"; error: ViewerError }
  | ImageEvent
  | { type: "disconnected"; established: boolean; error: ViewerError };
export type ViewerIntentTransition = Extract<
  ViewerTransition,
  {
    type:
      | "pause"
      | "select"
      | "target-lost"
      | "failed"
      | "discovery-failed"
      | "closed"
      | "disconnected";
  }
>;
type SnapshotTransition = Exclude<ViewerTransition, ImageEvent>;

type ViewerLifecycle = Omit<ViewerSnapshot, "inventory">;

function initialLifecycle(): ViewerLifecycle {
  return {
    status: "connecting",
    selectedTargetId: null,
    error: null,
  };
}
function createModelAtoms() {
  const lifecycleState$ = state<ViewerLifecycle>(initialLifecycle());
  const intentState$ = state(initialIntent());
  const inventoryInternal$ = state(initialInventory());
  const imageState$ = state<ImageRecovery | null>(null);
  const scopedState$ = state(false);
  const loadingPreviewState$ = state(false);
  const faviconState$ = state<
    ReadonlyMap<string, { readonly url: string; readonly failed: boolean }>
  >(new Map());
  const spaceState$ = state<TabSpace | null>(null);
  const captureState$ = state<ViewerCaptureOptions>({ format: "webp" });
  const transportState$ = state<ViewerTransport>("shared");
  const modeState$ = state<WindowSizeSync>("live");
  return {
    lifecycleState$,
    intentState$,
    inventoryInternal$,
    imageState$,
    scopedState$,
    loadingPreviewState$,
    faviconState$,
    spaceState$,
    captureState$,
    transportState$,
    modeState$,
  };
}
type ModelAtoms = ReturnType<typeof createModelAtoms>;

function createModelValues(
  atoms: ModelAtoms,
  navigationSource$: Computed<ViewerNavigation | null>,
  navigationScopeSource$: Computed<object | null>,
  connectedSource$: Computed<boolean>,
) {
  const {
    lifecycleState$,
    intentState$,
    inventoryInternal$,
    imageState$,
    captureState$,
    transportState$,
    modeState$,
    faviconState$,
    spaceState$,
  } = atoms;
  const inventory$ = computed((get) => {
    return inventorySnapshot(get(inventoryInternal$));
  });
  const targets$ = computed((get) => {
    return get(inventory$).targets;
  });
  const empty$ = computed((get) => {
    const inventory = get(inventory$);
    return inventory.status === "complete" && inventory.targets.length === 0;
  });
  const knownTargetIds$: Computed<ReadonlySet<string>> = computed((get) => {
    return new Set(get(inventoryInternal$).entries.keys());
  });
  const snapshot$ = computed((get): ViewerSnapshot => {
    const lifecycle = get(lifecycleState$);
    const inventory = get(inventory$);
    // An exhausted visible projection is not an empty-window proof.
    if (
      lifecycle.status === "unavailable" &&
      inventory.status !== "complete" &&
      inventory.targets.length === 0 &&
      (!lifecycle.error || lifecycle.error.kind === "target-unavailable")
    ) {
      return { ...lifecycle, status: "connecting", error: null, inventory };
    }
    return { ...lifecycle, inventory };
  });
  const intent$ = computed((get) => {
    return get(intentState$);
  });
  const inventoryState$ = computed((get) => {
    return get(inventoryInternal$);
  });
  const imageRecovery$ = computed((get) => {
    return get(imageState$);
  });
  const capture$ = computed((get) => {
    return get(captureState$);
  });
  const transport$ = computed((get) => {
    return get(transportState$);
  });
  const windowSizeSync$ = computed((get) => {
    return get(modeState$);
  });
  const tabs$ = computed((get) => {
    return get(targets$).map((tab) => {
      const icon = get(faviconState$).get(tab.id);
      return {
        ...tab,
        ...(icon && !icon.failed ? { faviconUrl: icon.url } : {}),
      };
    });
  });
  const selectedTabId$ = computed((get) => {
    return get(lifecycleState$).selectedTargetId;
  });
  const navigation$ = computed((get): ViewerNavigation | null => {
    return get(navigationSource$);
  });
  const navigationScope$ = computed((get) => {
    return get(navigationScopeSource$);
  });
  const tabLayout$ = computed((get) => {
    return layoutTabs(get(tabs$), get(selectedTabId$), true, get(spaceState$));
  });
  return {
    snapshot$,
    inventory$,
    empty$,
    knownTargetIds$,
    targets$,
    intent$,
    inventoryState$,
    imageRecovery$,
    connected$: connectedSource$,
    capture$,
    transport$,
    windowSizeSync$,
    tabs$,
    selectedTabId$,
    navigation$,
    navigationScope$,
    tabLayout$,
  };
}
type ModelValues = ReturnType<typeof createModelValues>;

function recoverySnapshot(snapshot: ViewerSnapshot): boolean {
  return (
    snapshot.status === "error" ||
    snapshot.status === "disconnected" ||
    (snapshot.status === "unavailable" &&
      !!snapshot.error &&
      snapshot.error.kind !== "target-unavailable")
  );
}
function createModelPresentation(
  atoms: ModelAtoms,
  values: ModelValues,
  creationReadySource$: Computed<boolean>,
) {
  const { loadingPreviewState$, scopedState$ } = atoms;
  const {
    snapshot$,
    empty$,
    imageRecovery$,
    connected$,
    intent$,
    navigation$,
  } = values;
  const presentation$ = computed((get) => {
    const snapshot = get(snapshot$);
    const document = get(navigation$);
    return {
      status: snapshot.status,
      error: snapshot.error,
      loadingPreview:
        snapshot.status === "connecting" && get(loadingPreviewState$),
      blank:
        !get(imageRecovery$) &&
        (snapshot.status === "connecting" || snapshot.status === "streaming") &&
        (document
          ? document.url === "about:blank"
          : snapshot.inventory.targets.some((target) => {
              return target.id === snapshot.selectedTargetId && target.blank;
            })),
    };
  });
  const controls$ = computed((get) => {
    const snapshot = get(snapshot$);
    const image = get(imageRecovery$);
    const scoped = get(scopedState$);
    const empty =
      get(empty$) &&
      snapshot.status === "unavailable" &&
      (!snapshot.error || snapshot.error.kind === "target-unavailable");
    const recovery = recoverySnapshot(snapshot);
    const streaming = snapshot.status === "streaming";
    const canMutateTabs = get(connected$) && !get(intent$).paused;
    const imageVisible =
      !!image && image.phase !== "presented" && snapshot.status !== "paused";
    return {
      streaming,
      emptyUnscoped: empty && !scoped,
      emptyScoped: empty && scoped,
      recovery,
      showRecovery: recovery || empty || imageVisible,
      showEmptyCreate: empty,
      canMutateTabs,
      canCreate:
        canMutateTabs && get(creationReadySource$) && (streaming || empty),
      tabsDisabled: !get(connected$),
      canSyncDisplay: streaming,
      canReload: snapshot.error?.kind === "target-crashed" && canMutateTabs,
      showImageRetry: imageVisible && image.phase !== "blocked",
      canRetryImage:
        image?.phase === "ready" &&
        snapshot.status !== "paused" &&
        get(connected$),
      retryingImage: retryingImage(image),
    };
  });
  return { presentation$, controls$ };
}

function createModelPublication(atoms: ModelAtoms, values: ModelValues) {
  const { lifecycleState$, inventoryInternal$, faviconState$ } = atoms;
  const update$ = command(({ get, set }, patch: Partial<ViewerLifecycle>) => {
    const previous = get(lifecycleState$);
    const next = { ...previous, ...patch };
    set(lifecycleState$, next);
  });
  const inventoryUpdate$ = command(({ get, set }, event: InventoryEvent) => {
    const next = transitionInventory(get(inventoryInternal$), event);
    set(inventoryInternal$, next);
    const ids = new Set(
      get(values.targets$).map((target) => {
        return target.id;
      }),
    );
    set(
      faviconState$,
      new Map(
        [...get(faviconState$)].filter(([id]) => {
          return ids.has(id);
        }),
      ),
    );
    return next;
  });
  return { update$, inventoryUpdate$ };
}
type ModelPublication = ReturnType<typeof createModelPublication>;

function createImageTransitions(
  atoms: ModelAtoms,
  publication: ModelPublication,
) {
  const { imageState$, intentState$, loadingPreviewState$ } = atoms;
  const { update$ } = publication;
  return command(({ get, set }, event: ImageEvent) => {
    const image = get(imageState$);
    if (
      get(intentState$).paused &&
      [
        "image-retrying",
        "image-starting",
        "image-painted",
        "image-released",
      ].includes(event.type)
    ) {
      return {
        state: image,
        accepted: false,
        imageReady: false,
        resumeDisplay: false,
      };
    }
    const decision = transitionImage(image, event);
    if (!decision.accepted) {
      return decision;
    }
    set(imageState$, decision.state);
    if (event.type === "image-failed" || event.type === "image-retrying") {
      set(loadingPreviewState$, false);
    }
    if (event.type === "image-failed") {
      set(update$, { status: "error", error: event.error });
    } else if (event.type === "image-retrying") {
      set(update$, { status: "connecting", error: null });
    } else if (decision.imageReady) {
      set(update$, { status: "streaming", error: null });
    } else if (
      event.type === "image-blocked" ||
      (event.type === "image-settled" && !event.ready)
    ) {
      set(update$, { status: "error", error: decision.state?.error ?? null });
    }
    return decision;
  });
}

function createSnapshotTransitions(
  atoms: ModelAtoms,
  publication: ModelPublication,
) {
  const { faviconState$, imageState$, lifecycleState$ } = atoms;
  const { inventoryUpdate$, update$ } = publication;
  return command(({ get, set }, event: SnapshotTransition) => {
    switch (event.type) {
      case "reset": {
        set(inventoryUpdate$, { type: "reset" });
        set(faviconState$, new Map());
        set(update$, initialLifecycle());
        break;
      }
      case "select": {
        set(update$, {
          selectedTargetId: event.targetId,
          status: event.paused ? "paused" : "connecting",
          error: null,
        });
        break;
      }
      case "target-lost":
      case "discovery-failed": {
        if (event.type === "discovery-failed") {
          set(inventoryUpdate$, { type: "reset" });
        }
        set(update$, {
          selectedTargetId: null,
          status: "unavailable",
          error: event.error,
        });
        break;
      }
      case "streaming": {
        set(imageState$, null);
        set(update$, { status: "streaming", error: null });
        break;
      }
      case "stopped": {
        if (event.retainFrame && get(lifecycleState$).status === "streaming") {
          set(update$, { status: "connecting" });
        }
        break;
      }
      case "pause": {
        if (get(lifecycleState$).selectedTargetId) {
          set(update$, {
            status: event.paused
              ? "paused"
              : get(imageState$)
                ? "error"
                : "connecting",
          });
        }
        break;
      }
      case "failed": {
        set(update$, { status: "error", error: event.error });
        break;
      }
      case "disconnected": {
        set(update$, {
          status: event.established ? "disconnected" : "error",
          error: event.error,
        });
        break;
      }
    }
  });
}

function createModelTransitions(
  atoms: ModelAtoms,
  publication: ModelPublication,
  changed$: Command<void, []>,
  observeAddressTarget$: Command<void, [string]>,
) {
  const { intentState$, imageState$, loadingPreviewState$, lifecycleState$ } =
    atoms;
  const imageTransition$ = createImageTransitions(atoms, publication);
  const snapshotTransition$ = createSnapshotTransitions(atoms, publication);
  const transition$ = command(({ get, set }, event: ViewerTransition) => {
    if ("owner" in event) {
      const decision = set(imageTransition$, event);
      if (decision.accepted) {
        set(changed$);
      }
      return decision;
    }
    if (event.type !== "streaming" && event.type !== "stopped") {
      set(
        intentState$,
        transitionIntent(
          get(intentState$),
          event.type === "failed" ||
            event.type === "closed" ||
            event.type === "disconnected"
            ? { type: "invalidate" }
            : event,
        ),
      );
      if (event.type !== "pause") {
        set(imageState$, null);
      }
    }
    set(
      loadingPreviewState$,
      event.type === "stopped"
        ? !!event.retainFrame &&
            (get(lifecycleState$).status === "streaming" ||
              get(loadingPreviewState$))
        : (event.type === "select" || event.type === "pause") &&
            !!event.preview &&
            !event.paused,
    );
    if (event.type === "select") {
      set(observeAddressTarget$, event.targetId);
    }
    set(snapshotTransition$, event);
    set(changed$);
    return undefined;
  });
  const commitIntent$ = command(
    ({ get, set }, event: ViewerIntentTransition) => {
      set(transition$, event);
      return get(intentState$);
    },
  );
  return { transition$, commitIntent$ };
}

function createFaviconActions(atoms: ModelAtoms) {
  const { faviconState$ } = atoms;
  const setFavicon$ = command(
    ({ get, set }, value: { targetId: string; url: string | null }) => {
      const icons = new Map(get(faviconState$));
      // Re-observing a URL must not resurrect a known failed image.
      if (value.url && icons.get(value.targetId)?.url === value.url) {
        return;
      }
      if (value.url) {
        icons.set(value.targetId, { url: value.url, failed: false });
      } else {
        icons.delete(value.targetId);
      }
      set(faviconState$, icons);
    },
  );
  const rejectFavicon$ = command(
    ({ get, set }, targetId: string, url: string) => {
      const icon = get(faviconState$).get(targetId);
      if (!icon || icon.url !== url || icon.failed) {
        return;
      }
      const icons = new Map(get(faviconState$));
      icons.set(targetId, { ...icon, failed: true });
      set(faviconState$, icons);
    },
  );
  return { setFavicon$, rejectFavicon$ };
}

function createConfigurationActions(atoms: ModelAtoms) {
  const {
    spaceState$,
    scopedState$,
    captureState$,
    transportState$,
    modeState$,
  } = atoms;
  return {
    resizeTabs$: command(({ set }, space: TabSpace) => {
      set(spaceState$, space);
    }),
    configure$: command(({ set }, scoped: boolean) => {
      set(scopedState$, scoped);
    }),
    setCapture$: command(({ set }, value: ViewerCaptureOptions) => {
      set(captureState$, value);
    }),
    setTransport$: command(({ set }, value: ViewerTransport) => {
      set(transportState$, value);
    }),
    setWindowSizeSync$: command(({ set }, value: WindowSizeSync) => {
      set(modeState$, value);
    }),
  };
}

/** Internal graph; only the explicit BrowserSignals projection reaches views. */
export function createViewerSignals(
  navigationSource$: Computed<ViewerNavigation | null>,
  navigationScopeSource$: Computed<object | null>,
  creationReadySource$: Computed<boolean>,
  connectedSource$: Computed<boolean>,
  changed$: Command<void, []>,
) {
  const atoms = createModelAtoms();
  const values = createModelValues(
    atoms,
    navigationSource$,
    navigationScopeSource$,
    connectedSource$,
  );
  const presentation = createModelPresentation(
    atoms,
    values,
    creationReadySource$,
  );
  const publication = createModelPublication(atoms, values);
  const address = createAddressSignals(values);
  const transitions = createModelTransitions(
    atoms,
    publication,
    changed$,
    address.observeAddressTarget$,
  );
  const favicon = createFaviconActions(atoms);
  const configuration = createConfigurationActions(atoms);
  return {
    ...values,
    ...presentation,
    ...publication,
    ...transitions,
    ...address,
    ...favicon,
    ...configuration,
    // Resource-owned readiness can change without a lifecycle transition.
    readinessChanged$: changed$,
  };
}
export type ViewerSignals = ReturnType<typeof createViewerSignals>;
