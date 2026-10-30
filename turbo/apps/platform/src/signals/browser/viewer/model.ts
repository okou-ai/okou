import { command, computed, state, type Computed } from "ccstate";
import {
  initialInventory,
  inventoryTargets,
  transitionInventory,
  type InventoryEvent,
} from "./target-inventory.ts";
import { layoutTabs, type TabSpace } from "./tab-layout.ts";
import type {
  ViewerCaptureOptions,
  ViewerError,
  ViewerNavigation,
  NavigationReceipt,
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
  | { type: "pause"; paused: boolean }
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

export interface AddressSubmission {
  readonly selection: object;
  readonly scope: object;
  readonly version: object;
  readonly value: string;
  readonly baseline: ViewerNavigation | null;
}
interface AddressDraft {
  readonly owner: object;
  readonly version: object;
  readonly value: string;
  readonly editing: boolean;
  readonly baseline: ViewerNavigation | null;
  readonly submission?: {
    readonly token: AddressSubmission;
    readonly receipt: NavigationReceipt | null;
  };
}

function confirmsSubmission(
  document: ViewerNavigation | null,
  submission: AddressSubmission,
  receipt: NavigationReceipt,
): boolean {
  return (
    !!document &&
    document !== submission.baseline &&
    receipt.kind === "ack" &&
    (receipt.frameId === undefined || document.frameId === receipt.frameId) &&
    (receipt.loaderId === undefined || document.loaderId === receipt.loaderId)
  );
}

function initialSnapshot(): ViewerSnapshot {
  return {
    status: "connecting",
    targets: [],
    selectedTargetId: null,
    error: null,
  };
}
function createModelAtoms() {
  const snapshotState$ = state<ViewerSnapshot>(initialSnapshot());
  const intentState$ = state(initialIntent());
  const inventoryInternal$ = state(initialInventory());
  const imageState$ = state<ImageRecovery | null>(null);
  const connectedState$ = state(false);
  const scopedState$ = state(false);
  const loadingPreviewState$ = state(false);
  const faviconState$ = state<
    ReadonlyMap<string, { readonly url: string; readonly failed: boolean }>
  >(new Map());
  const draftState$ = state<AddressDraft | null>(null);
  const spaceState$ = state<TabSpace | null>(null);
  const captureState$ = state<ViewerCaptureOptions>({ format: "webp" });
  const transportState$ = state<ViewerTransport>("shared");
  const modeState$ = state<WindowSizeSync>("live");
  return {
    snapshotState$,
    intentState$,
    inventoryInternal$,
    imageState$,
    connectedState$,
    scopedState$,
    loadingPreviewState$,
    faviconState$,
    draftState$,
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
) {
  const {
    snapshotState$,
    intentState$,
    inventoryInternal$,
    imageState$,
    connectedState$,
    captureState$,
    transportState$,
    modeState$,
    faviconState$,
    draftState$,
    spaceState$,
  } = atoms;
  const snapshot$ = computed((get) => {
    return get(snapshotState$);
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
  const connected$ = computed((get) => {
    return get(connectedState$);
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
    return get(snapshot$).targets.map((tab) => {
      const icon = get(faviconState$).get(tab.id);
      return {
        ...tab,
        ...(icon && !icon.failed ? { faviconUrl: icon.url } : {}),
      };
    });
  });
  const selectedTabId$ = computed((get) => {
    return get(snapshot$).selectedTargetId;
  });
  const navigation$ = computed((get): ViewerNavigation | null => {
    return get(navigationSource$);
  });
  const navigationScope$ = computed((get) => {
    return get(navigationScopeSource$);
  });
  const address$ = computed((get) => {
    const draft = get(draftState$);
    const document = get(navigation$);
    const remote = document?.url ?? "";
    if (draft?.owner === get(intent$).selection) {
      const submitted = draft.submission;
      const confirmed =
        submitted?.receipt &&
        submitted.token.scope === get(navigationScope$) &&
        confirmsSubmission(document, submitted.token, submitted.receipt);
      if (
        draft.editing ||
        (submitted ? !confirmed : draft.baseline === document)
      ) {
        return draft.value;
      }
    }
    return remote === "about:blank" ? "" : remote;
  });
  const tabLayout$ = computed((get) => {
    return layoutTabs(get(tabs$), get(selectedTabId$), true, get(spaceState$));
  });
  return {
    snapshot$,
    intent$,
    inventoryState$,
    imageRecovery$,
    connected$,
    capture$,
    transport$,
    windowSizeSync$,
    tabs$,
    selectedTabId$,
    navigation$,
    navigationScope$,
    address$,
    tabLayout$,
  };
}
type ModelValues = ReturnType<typeof createModelValues>;

function emptySnapshot(snapshot: ViewerSnapshot): boolean {
  return (
    snapshot.status === "unavailable" &&
    !snapshot.targets.length &&
    (!snapshot.error || snapshot.error.kind === "target-unavailable")
  );
}
function recoverySnapshot(snapshot: ViewerSnapshot): boolean {
  return (
    snapshot.status === "error" ||
    snapshot.status === "disconnected" ||
    (snapshot.status === "unavailable" &&
      !!snapshot.error &&
      snapshot.error.kind !== "target-unavailable")
  );
}
function createModelPresentation(atoms: ModelAtoms, values: ModelValues) {
  const { loadingPreviewState$, scopedState$ } = atoms;
  const { snapshot$, imageRecovery$, connected$, intent$ } = values;
  const presentation$ = computed((get) => {
    const snapshot = get(snapshot$);
    return {
      status: snapshot.status,
      error: snapshot.error,
      loadingPreview: get(loadingPreviewState$),
    };
  });
  const controls$ = computed((get) => {
    const snapshot = get(snapshot$);
    const image = get(imageRecovery$);
    const scoped = get(scopedState$);
    const empty = emptySnapshot(snapshot);
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
      showEmptyCreate: empty && !scoped,
      canMutateTabs,
      canCreate: canMutateTabs && (streaming || (empty && !scoped)),
      tabsDisabled: !get(connected$),
      canSyncDisplay: streaming,
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

function createModelPublication(atoms: ModelAtoms) {
  const { snapshotState$, inventoryInternal$, faviconState$ } = atoms;
  const update$ = command(({ get, set }, patch: Partial<ViewerSnapshot>) => {
    const previous = get(snapshotState$);
    const next = { ...previous, ...patch };
    set(snapshotState$, next);
  });
  const inventoryUpdate$ = command(({ get, set }, event: InventoryEvent) => {
    const next = transitionInventory(get(inventoryInternal$), event);
    set(inventoryInternal$, next);
    set(update$, { targets: inventoryTargets(next) });
    const ids = new Set(
      inventoryTargets(next).map((target) => {
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
  const { imageState$, intentState$ } = atoms;
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
  const {
    connectedState$,
    faviconState$,
    draftState$,
    imageState$,
    snapshotState$,
  } = atoms;
  const { inventoryUpdate$, update$ } = publication;
  return command(({ get, set }, event: SnapshotTransition) => {
    switch (event.type) {
      case "reset": {
        set(inventoryUpdate$, { type: "reset" });
        set(connectedState$, false);
        set(faviconState$, new Map());
        set(draftState$, null);
        set(update$, initialSnapshot());
        break;
      }
      case "select": {
        set(draftState$, null);
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
        set(draftState$, null);
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
      case "pause": {
        if (get(snapshotState$).selectedTargetId) {
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
        set(connectedState$, false);
        set(update$, {
          status: event.established ? "disconnected" : "error",
          error: event.error,
        });
        break;
      }
      case "closed": {
        set(connectedState$, false);
        set(draftState$, null);
        break;
      }
    }
  });
}

function createModelTransitions(
  atoms: ModelAtoms,
  publication: ModelPublication,
) {
  const { intentState$, imageState$, loadingPreviewState$ } = atoms;
  const imageTransition$ = createImageTransitions(atoms, publication);
  const snapshotTransition$ = createSnapshotTransitions(atoms, publication);
  const transition$ = command(({ get, set }, event: ViewerTransition) => {
    if ("owner" in event) {
      return set(imageTransition$, event);
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
      event.type === "select" && !!event.preview && !event.paused,
    );
    set(snapshotTransition$, event);
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

function createAddressActions(atoms: ModelAtoms, values: ModelValues) {
  const { draftState$, intentState$ } = atoms;
  const { address$, navigation$, navigationScope$ } = values;
  const resetAddress$ = command(({ set }) => {
    set(draftState$, null);
  });
  const editAddress$ = command(({ get, set }, value: string) => {
    set(draftState$, {
      owner: get(intentState$).selection,
      version: {},
      value,
      editing: true,
      baseline: get(navigation$),
    });
  });
  const focusAddress$ = command(({ get, set }) => {
    set(draftState$, {
      owner: get(intentState$).selection,
      version: {},
      value: get(address$),
      editing: true,
      baseline: get(navigation$),
    });
  });
  const blurAddress$ = command(({ get, set }) => {
    const draft = get(draftState$);
    if (draft) {
      set(draftState$, { ...draft, editing: false });
    }
  });
  const prepareAddress$ = command(
    ({ get, set }, scope: object): AddressSubmission => {
      const token: AddressSubmission = Object.freeze({
        selection: get(intentState$).selection,
        scope,
        version: {},
        value: get(address$),
        baseline: get(navigation$),
      });
      set(draftState$, {
        owner: token.selection,
        version: token.version,
        value: token.value,
        baseline: token.baseline,
        editing: false,
        submission: { token, receipt: null },
      });
      return token;
    },
  );
  const acceptAddress$ = command(
    ({ get, set }, token: AddressSubmission, receipt: NavigationReceipt) => {
      const draft = get(draftState$);
      if (
        !draft ||
        draft.version !== token.version ||
        get(intentState$).selection !== token.selection ||
        get(navigationScope$) !== token.scope
      ) {
        return;
      }
      if (
        receipt.kind === "download" ||
        receipt.kind === "unavailable" ||
        confirmsSubmission(get(navigation$), token, receipt)
      ) {
        set(draftState$, null);
      } else {
        set(draftState$, { ...draft, submission: { token, receipt } });
      }
    },
  );
  const reconcileAddress$ = command(({ get, set }, scope: object) => {
    const draft = get(draftState$);
    const submission = draft?.submission;
    if (
      draft &&
      submission?.receipt &&
      submission.token.scope === scope &&
      get(navigationScope$) === scope &&
      draft.owner === get(intentState$).selection &&
      draft.version === submission.token.version &&
      confirmsSubmission(get(navigation$), submission.token, submission.receipt)
    ) {
      set(draftState$, null);
    }
  });
  return {
    resetAddress$,
    editAddress$,
    focusAddress$,
    blurAddress$,
    prepareAddress$,
    acceptAddress$,
    reconcileAddress$,
  };
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
    connectedState$,
    scopedState$,
    captureState$,
    transportState$,
    modeState$,
  } = atoms;
  return {
    resizeTabs$: command(({ set }, space: TabSpace) => {
      set(spaceState$, space);
    }),
    setConnected$: command(({ set }, connected: boolean) => {
      set(connectedState$, connected);
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
) {
  const atoms = createModelAtoms();
  const values = createModelValues(
    atoms,
    navigationSource$,
    navigationScopeSource$,
  );
  const presentation = createModelPresentation(atoms, values);
  const publication = createModelPublication(atoms);
  const transitions = createModelTransitions(atoms, publication);
  const address = createAddressActions(atoms, values);
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
    // Temporary private controller integration; never exposed on BrowserSignals.
    captureState$: atoms.captureState$,
    transportState$: atoms.transportState$,
    modeState$: atoms.modeState$,
  };
}
export type ViewerSignals = ReturnType<typeof createViewerSignals>;
