import { command, computed, state, type Command, type Computed } from "ccstate";
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
  ViewerSnapshot,
  ViewerTransport,
  WindowSizeSync,
} from "./types.ts";
import { sameCapture } from "./capture.ts";
import type { DisplayState } from "../display/sync.ts";
import type { ClipboardRecovery } from "../input/clipboard.ts";
import {
  retryingImage,
  transitionImage,
  type ImageEvent,
  type ImageRecovery,
} from "./image-recovery.ts";

import { initialIntent, transitionIntent } from "./lifecycle.ts";

export interface ViewerActions {
  select(targetId: string): void;
  createTab(): void;
  closeTab(targetId: string): void;
  navigate(action: "back" | "forward" | "reload" | { url: string }): void;
  copyClipboard?(): void;
  dismissClipboard?(): void;
  syncDisplay?(): void;
  retryImage?(): void;
  onWindowSizeSyncChange?(mode: WindowSizeSync): void;
  onCaptureChange?(capture: ViewerCaptureOptions): void;
}

interface AddressDraft {
  value: string;
  editing: boolean;
}

export type TabAction =
  | { readonly type: "create" }
  | { readonly type: "close"; readonly targetId: string };

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

export type ViewerUpdate = Partial<
  Pick<ViewerSnapshot, "navigation" | "error">
>;

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

type Favicon = {
  readonly url: string;
  readonly failed: boolean;
};

function initialSnapshot(): ViewerSnapshot {
  return Object.freeze({
    status: "connecting",
    targets: Object.freeze([]),
    selectedTargetId: null,
    error: null,
    navigation: null,
  });
}

type ViewerAtoms = ReturnType<typeof createViewerAtoms>;
type ViewerValues = ReturnType<typeof createViewerValues>;
type ViewerPresentation = ReturnType<typeof createViewerPresentation>;
type ViewerActionSignals = ReturnType<typeof createViewerActions>;
type ViewerPublication = ReturnType<typeof createViewerPublication>;
type ViewerImageTransitions = ReturnType<typeof createViewerImageTransitions>;

function createViewerAtoms() {
  const internalIntent$ = state(initialIntent());
  const internalSnapshot$ = state<ViewerSnapshot>(initialSnapshot());
  const internalInventory$ = state(initialInventory());
  const internalLoadingPreview$ = state(false);
  const internalImageRecovery$ = state<ImageRecovery | null>(null);
  const internalFavicons$ = state<ReadonlyMap<string, Favicon>>(new Map());
  const internalRevision$ = state(0);
  const actions$ = state<ViewerActions | null>(null);
  const draft$ = state<AddressDraft | null>(null);
  const pendingTab$ = state<TabAction | null>(null);
  const tabSpace$ = state<TabSpace | null>(null);
  const internalNotification$ = state<ViewerError | null>(null);
  const internalConnected$ = state(false);
  const internalDisplay$ = state<DisplayState>({
    ready: false,
    pending: false,
    pointerBlocked: false,
  });
  const internalTransport$ = state<ViewerTransport>("shared");
  const internalSyncMode$ = state<WindowSizeSync>("live");
  const internalCapture$ = state<ViewerCaptureOptions>({ format: "webp" });
  const internalClipboard$ = state<ClipboardRecovery | null>(null);
  const configuration$ = state({
    interactive: false,
    scoped: false,
  });
  return {
    internalIntent$,
    internalSnapshot$,
    internalInventory$,
    internalLoadingPreview$,
    internalImageRecovery$,
    internalFavicons$,
    internalRevision$,
    actions$,
    draft$,
    pendingTab$,
    tabSpace$,
    internalNotification$,
    internalConnected$,
    internalDisplay$,
    internalTransport$,
    internalSyncMode$,
    internalCapture$,
    internalClipboard$,
    configuration$,
  };
}

type ViewerValuesInput = Pick<
  ViewerAtoms,
  | "internalIntent$"
  | "internalInventory$"
  | "internalImageRecovery$"
  | "internalFavicons$"
  | "internalTransport$"
  | "internalDisplay$"
  | "internalSyncMode$"
  | "internalCapture$"
  | "internalClipboard$"
  | "pendingTab$"
  | "internalSnapshot$"
  | "internalNotification$"
  | "internalRevision$"
>;

function createViewerValues({
  internalIntent$,
  internalInventory$,
  internalImageRecovery$,
  internalFavicons$,
  internalTransport$,
  internalDisplay$,
  internalSyncMode$,
  internalCapture$,
  internalClipboard$,
  pendingTab$,
  internalSnapshot$,
  internalNotification$,
  internalRevision$,
}: ViewerValuesInput) {
  const intent$ = computed((get) => {
    return get(internalIntent$);
  });
  const inventoryState$ = computed((get) => {
    return get(internalInventory$);
  });
  const imageRecovery$ = computed((get) => {
    return get(internalImageRecovery$);
  });
  const favicons$ = computed((get) => {
    return get(internalFavicons$);
  });
  const transport$ = computed((get) => {
    return get(internalTransport$);
  });
  const display$ = computed((get) => {
    return get(internalDisplay$);
  });
  const windowSizeSync$ = computed((get) => {
    return get(internalSyncMode$);
  });
  const capture$ = computed((get) => {
    return get(internalCapture$);
  });
  const clipboard$ = computed((get) => {
    return get(internalClipboard$);
  });
  const tabAction$ = computed((get) => {
    return get(pendingTab$);
  });
  const snapshot$ = computed((get) => {
    return get(internalSnapshot$);
  });
  const notification$ = computed((get) => {
    return get(internalNotification$);
  });
  const revision$ = computed((get) => {
    return get(internalRevision$);
  });
  return {
    intent$,
    inventoryState$,
    imageRecovery$,
    favicons$,
    transport$,
    display$,
    windowSizeSync$,
    capture$,
    clipboard$,
    tabAction$,
    snapshot$,
    notification$,
    revision$,
  };
}

type ViewerPresentationInput = Pick<
  ViewerValues & ViewerAtoms,
  | "snapshot$"
  | "imageRecovery$"
  | "configuration$"
  | "internalConnected$"
  | "pendingTab$"
  | "internalLoadingPreview$"
  | "display$"
  | "tabSpace$"
  | "draft$"
>;

function createViewerPresentation({
  snapshot$,
  imageRecovery$,
  configuration$,
  internalConnected$,
  pendingTab$,
  internalLoadingPreview$,
  display$,
  tabSpace$,
  draft$,
}: ViewerPresentationInput) {
  const controls$ = computed((get) => {
    const snapshot = get(snapshot$);
    const image = get(imageRecovery$);
    const unavailableImage = image && image.phase !== "presented";
    const { interactive, scoped } = get(configuration$);
    const streaming = snapshot.status === "streaming";
    const empty =
      snapshot.status === "unavailable" &&
      !snapshot.targets.length &&
      (!snapshot.error || snapshot.error.kind === "target-unavailable");
    const emptyUnscoped = empty && !scoped;
    const recovery = needsRecovery(snapshot);
    const canMutateTabs =
      interactive && get(internalConnected$) && !get(pendingTab$);
    return Object.freeze({
      streaming,
      loadingPreview:
        snapshot.status === "connecting" && get(internalLoadingPreview$),
      emptyUnscoped,
      emptyScoped: empty && scoped,
      recovery,
      showRecovery:
        recovery ||
        empty ||
        (!!unavailableImage && snapshot.status !== "paused"),
      ...imageControls(image, snapshot.status, get(internalConnected$)),
      showEmptyCreate: empty && interactive,
      canMutateTabs,
      canCreate: canMutateTabs && (streaming || empty),
      tabsDisabled: snapshot.status === "disconnected",
      canSyncDisplay:
        streaming && get(display$).ready && !get(display$).pending,
    });
  });
  const tabLayout$ = computed((get) => {
    const snapshot = get(snapshot$);
    return layoutTabs(
      snapshot.targets,
      snapshot.selectedTargetId,
      get(configuration$).interactive,
      get(tabSpace$),
    );
  });
  const address$ = computed((get) => {
    const draft = get(draft$);
    const remoteUrl = get(snapshot$).navigation?.url ?? "";
    const url = remoteUrl === "about:blank" ? "" : remoteUrl;
    return draft ? draft.value : url;
  });
  return { controls$, tabLayout$, address$ };
}

type ViewerActionsInput = Pick<
  ViewerAtoms,
  | "actions$"
  | "pendingTab$"
  | "internalDisplay$"
  | "internalImageRecovery$"
  | "internalConnected$"
  | "internalLoadingPreview$"
  | "internalNotification$"
  | "internalClipboard$"
  | "internalRevision$"
>;

function createViewerActions({
  actions$,
  pendingTab$,
  internalDisplay$,
  internalImageRecovery$,
  internalConnected$,
  internalLoadingPreview$,
  internalNotification$,
  internalClipboard$,
  internalRevision$,
}: ViewerActionsInput) {
  const retryImage$ = command(({ get }) => {
    return get(actions$)?.retryImage?.();
  });
  const syncDisplay$ = command(({ get }) => {
    return get(actions$)?.syncDisplay?.();
  });
  const copyClipboard$ = command(({ get }) => {
    return get(actions$)?.copyClipboard?.();
  });
  const dismissClipboard$ = command(({ get }) => {
    return get(actions$)?.dismissClipboard?.();
  });
  const bind$ = command(({ set }, actions: ViewerActions) => {
    set(pendingTab$, null);
    set(actions$, actions);
    set(internalDisplay$, {
      ready: false,
      pending: false,
      pointerBlocked: false,
    });
  });
  const unbind$ = command(({ get, set }, actions: ViewerActions) => {
    if (get(actions$) === actions) {
      set(internalImageRecovery$, null);
      set(actions$, null);
      set(pendingTab$, null);
      set(internalConnected$, false);
      set(internalLoadingPreview$, false);
      set(internalNotification$, null);
      set(internalClipboard$, null);
      set(internalDisplay$, {
        ready: false,
        pending: false,
        pointerBlocked: false,
      });
    }
  });
  const reconnect$ = command(({ set }) => {
    set(internalRevision$, (value) => {
      return value + 1;
    });
  });
  const select$ = command(({ get }, targetId: string) => {
    get(actions$)?.select(targetId);
  });
  const createTab$ = command(({ get }) => {
    return get(actions$)?.createTab();
  });
  const closeTab$ = command(({ get }, targetId: string) => {
    return get(actions$)?.closeTab(targetId);
  });
  const navigate$ = command(
    ({ get }, action: "back" | "forward" | "reload") => {
      get(actions$)?.navigate(action);
    },
  );
  return {
    retryImage$,
    syncDisplay$,
    copyClipboard$,
    dismissClipboard$,
    bind$,
    unbind$,
    reconnect$,
    select$,
    createTab$,
    closeTab$,
    navigate$,
  };
}

type ViewerSettingsInput = Pick<
  ViewerValues & ViewerAtoms & ViewerActionSignals,
  | "transport$"
  | "internalTransport$"
  | "reconnect$"
  | "internalDisplay$"
  | "internalSyncMode$"
  | "actions$"
  | "capture$"
  | "internalCapture$"
  | "internalClipboard$"
  | "configuration$"
  | "internalConnected$"
  | "pendingTab$"
  | "internalNotification$"
>;

function createViewerSettings({
  transport$,
  internalTransport$,
  reconnect$,
  internalDisplay$,
  internalSyncMode$,
  actions$,
  capture$,
  internalCapture$,
  internalClipboard$,
  configuration$,
  internalConnected$,
  pendingTab$,
  internalNotification$,
}: ViewerSettingsInput) {
  const chooseTransport$ = command(({ get, set }, value: string) => {
    if (
      (value === "shared" || value === "split") &&
      value !== get(transport$)
    ) {
      set(internalTransport$, value);
      set(reconnect$);
    }
  });
  const setDisplay$ = command(({ get, set }, value: DisplayState) => {
    const previous = get(internalDisplay$);
    if (
      previous.ready !== value.ready ||
      previous.pending !== value.pending ||
      previous.pointerBlocked !== value.pointerBlocked
    ) {
      set(internalDisplay$, Object.freeze({ ...value }));
    }
  });
  const chooseWindowSizeSync$ = command(({ get, set }, value: string) => {
    if (value !== "off" && value !== "initial" && value !== "live") {
      return;
    }
    set(internalSyncMode$, value);
    get(actions$)?.onWindowSizeSyncChange?.(value);
  });
  const chooseCapture$ = command(
    ({ get, set }, value: ViewerCaptureOptions) => {
      if (sameCapture(get(capture$), value)) {
        return;
      }
      const next = Object.freeze({ ...value });
      set(internalCapture$, next);
      get(actions$)?.onCaptureChange?.(next);
    },
  );
  const setClipboard$ = command(({ set }, value: ClipboardRecovery | null) => {
    return set(internalClipboard$, value);
  });
  const configure$ = command(
    ({ set }, value: { interactive: boolean; scoped: boolean }) => {
      return set(configuration$, Object.freeze({ ...value }));
    },
  );
  const setConnected$ = command(({ set }, value: boolean) => {
    return set(internalConnected$, value);
  });
  const setTabAction$ = command(({ set }, action: TabAction | null) => {
    set(pendingTab$, action);
  });
  const dismissNotification$ = command(({ set }) => {
    set(internalNotification$, null);
  });
  return {
    chooseTransport$,
    setDisplay$,
    chooseWindowSizeSync$,
    chooseCapture$,
    setClipboard$,
    configure$,
    setConnected$,
    setTabAction$,
    dismissNotification$,
  };
}

type ViewerInventoryInput = Pick<
  ViewerAtoms,
  "internalSnapshot$" | "internalFavicons$" | "tabSpace$"
>;

function createViewerInventory({
  internalSnapshot$,
  internalFavicons$,
  tabSpace$,
}: ViewerInventoryInput) {
  const setFavicon$ = command(
    ({ get, set }, value: { targetId: string; url: string | null }) => {
      if (
        !get(internalSnapshot$).targets.some((target) => {
          return target.id === value.targetId;
        })
      ) {
        return;
      }
      const previous = get(internalFavicons$);
      if ((previous.get(value.targetId)?.url ?? null) === value.url) {
        return;
      }
      const next = new Map(previous);
      if (value.url) {
        next.set(
          value.targetId,
          Object.freeze({ url: value.url, failed: false }),
        );
      } else {
        next.delete(value.targetId);
      }
      set(internalFavicons$, next);
    },
  );
  const rejectFavicon$ = command(
    ({ get, set }, value: { targetId: string; icon: Favicon }) => {
      const previous = get(internalFavicons$);
      if (previous.get(value.targetId) !== value.icon || value.icon.failed) {
        return;
      }
      const next = new Map(previous);
      next.set(
        value.targetId,
        Object.freeze({
          url: value.icon.url,
          failed: true,
        }),
      );
      set(internalFavicons$, next);
    },
  );
  const resizeTabs$ = command(({ get, set }, space: TabSpace) => {
    const previous = get(tabSpace$);
    if (
      previous?.width === space.width &&
      previous.gap === space.gap &&
      previous.overflow === space.overflow
    ) {
      return false;
    }
    set(tabSpace$, Object.freeze({ ...space }));
    return true;
  });
  return { setFavicon$, rejectFavicon$, resizeTabs$ };
}

type ViewerAddressInput = Pick<
  ViewerAtoms & ViewerPresentation,
  "draft$" | "address$" | "actions$"
>;

function createViewerAddress({
  draft$,
  address$,
  actions$,
}: ViewerAddressInput) {
  const resetAddress$ = command(({ set }) => {
    set(draft$, null);
  });
  const focusAddress$ = command(({ get, set }) => {
    set(draft$, {
      value: get(address$),
      editing: true,
    });
  });
  const editAddress$ = command(({ set }, value: string) => {
    set(draft$, {
      value,
      editing: true,
    });
  });
  const blurAddress$ = command(({ get, set }) => {
    const draft = get(draft$);
    if (draft) {
      set(draft$, {
        ...draft,
        editing: false,
      });
    }
  });
  const submitAddress$ = command(({ get, set }) => {
    const url = get(address$).trim();
    set(blurAddress$);
    get(actions$)?.navigate({ url });
  });
  return {
    resetAddress$,
    focusAddress$,
    editAddress$,
    blurAddress$,
    submitAddress$,
  };
}

type ViewerPublicationInput = Pick<
  ViewerAtoms,
  | "internalSnapshot$"
  | "internalFavicons$"
  | "draft$"
  | "internalNotification$"
  | "internalInventory$"
>;

function createViewerPublication({
  internalSnapshot$,
  internalFavicons$,
  draft$,
  internalNotification$,
  internalInventory$,
}: ViewerPublicationInput) {
  const update$ = command(({ get, set }, patch: Partial<ViewerSnapshot>) => {
    const old = get(internalSnapshot$);
    const next = { ...old, ...patch };
    if (sameTargets(next.targets, old.targets)) {
      next.targets = old.targets;
    }
    if (sameNavigation(next.navigation, old.navigation)) {
      next.navigation = old.navigation;
    }
    if (patch.targets) {
      const ids = new Set(
        patch.targets.map((target) => {
          return target.id;
        }),
      );
      const icons = get(internalFavicons$);
      if (
        [...icons.keys()].some((id) => {
          return !ids.has(id);
        })
      ) {
        set(
          internalFavicons$,
          new Map(
            [...icons].filter(([id]) => {
              return ids.has(id);
            }),
          ),
        );
      }
    }
    // A completed draft belongs to this URL lifetime, including reconnects
    // through null that subsequently reopen exactly the same remote address.
    if (old.navigation?.url !== next.navigation?.url && !get(draft$)?.editing) {
      set(draft$, null);
    }
    if (next.status !== "streaming" || patch.error === null) {
      set(internalNotification$, null);
    } else if (patch.error) {
      set(internalNotification$, patch.error);
    }
    // Equality gates publication only; repeated reports still own new notices.
    // Error references also identify which diagnostic an owner may clear.
    if (
      next.status !== old.status ||
      next.targets !== old.targets ||
      next.selectedTargetId !== old.selectedTargetId ||
      next.error !== old.error ||
      next.navigation !== old.navigation
    ) {
      set(internalSnapshot$, Object.freeze(next));
    }
  });
  const inventoryUpdate$ = command(({ get, set }, event: InventoryEvent) => {
    const previous = get(internalInventory$);
    const next = transitionInventory(previous, event);
    set(internalInventory$, next);
    if (next.entries !== previous.entries || next.ready !== previous.ready) {
      set(update$, { targets: inventoryTargets(next) });
    }
    return next;
  });
  const updateData$ = command(({ set }, patch: ViewerUpdate) => {
    return set(update$, patch);
  });
  const resetDiscoveryInventory$ = command(({ get, set }) => {
    const inventory = get(internalInventory$);
    if (inventory.entries.size || inventory.ready || inventory.round) {
      set(inventoryUpdate$, { type: "reset" });
    }
  });
  return { update$, inventoryUpdate$, updateData$, resetDiscoveryInventory$ };
}

type ViewerImageTransitionsInput = Pick<
  ViewerValues & ViewerAtoms & ViewerPublication,
  | "imageRecovery$"
  | "intent$"
  | "internalImageRecovery$"
  | "internalClipboard$"
  | "internalLoadingPreview$"
  | "update$"
  | "snapshot$"
  | "internalIntent$"
>;

function createViewerImageTransitions({
  imageRecovery$,
  intent$,
  internalImageRecovery$,
  internalClipboard$,
  internalLoadingPreview$,
  update$,
  snapshot$,
  internalIntent$,
}: ViewerImageTransitionsInput) {
  const imageTransition$ = command(({ get, set }, event: ImageEvent) => {
    const image = get(imageRecovery$);

    if (
      get(intent$).paused &&
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
    // Acceptance precedes every semantic effect, including private presentation.
    if (!decision.accepted) {
      return decision;
    }
    set(internalImageRecovery$, decision.state);
    if (event.type === "image-failed" || event.type === "image-retrying") {
      set(internalClipboard$, null);
      set(internalLoadingPreview$, false);
    }
    if (event.type === "image-failed") {
      set(update$, { status: "error", error: event.error });
    } else if (event.type === "image-retrying") {
      set(update$, { status: "connecting", error: null });
    } else if (
      (event.type === "image-blocked" ||
        (event.type === "image-settled" && !event.ready)) &&
      get(snapshot$).status !== "paused"
    ) {
      set(update$, {
        status: "error",
        error: decision.state?.error ?? null,
      });
    }
    if (decision.imageReady && !get(intent$).paused) {
      set(internalLoadingPreview$, false);
      set(update$, { status: "streaming", error: null });
    }
    return decision;
  });
  const pauseTransition$ = command(
    ({ get, set }, event: Extract<ViewerTransition, { type: "pause" }>) => {
      const image = get(imageRecovery$);

      const paused = event.paused;
      const intent = transitionIntent(get(intent$), {
        type: "pause",
        paused,
      });
      set(internalIntent$, intent);
      if (
        get(snapshot$).selectedTargetId &&
        get(snapshot$).status !== "disconnected"
      ) {
        set(update$, {
          status: paused ? "paused" : image ? "error" : "connecting",
          error: image?.error ?? null,
          navigation: null,
        });
      }
    },
  );
  const invalidateIntent$ = command(({ get, set }) => {
    set(
      internalIntent$,
      transitionIntent(get(intent$), { type: "invalidate" }),
    );
    set(internalImageRecovery$, null);
  });
  return { imageTransition$, pauseTransition$, invalidateIntent$ };
}

type ViewerTransitionsInput = Pick<
  ViewerValues & ViewerImageTransitions & ViewerAtoms & ViewerPublication,
  | "intent$"
  | "imageTransition$"
  | "internalClipboard$"
  | "internalLoadingPreview$"
  | "internalNotification$"
  | "snapshot$"
  | "update$"
  | "internalIntent$"
  | "internalImageRecovery$"
  | "inventoryUpdate$"
  | "internalFavicons$"
  | "internalConnected$"
  | "pendingTab$"
  | "resetDiscoveryInventory$"
  | "pauseTransition$"
  | "invalidateIntent$"
>;

function createViewerTransitions({
  intent$,
  imageTransition$,
  internalClipboard$,
  internalLoadingPreview$,
  internalNotification$,
  snapshot$,
  update$,
  internalIntent$,
  internalImageRecovery$,
  inventoryUpdate$,
  internalFavicons$,
  internalConnected$,
  pendingTab$,
  resetDiscoveryInventory$,
  pauseTransition$,
  invalidateIntent$,
}: ViewerTransitionsInput) {
  const stopped$ = createStoppedTransition({
    internalClipboard$,
    internalLoadingPreview$,
    internalNotification$,
    snapshot$,
    update$,
  });
  const transition$ = command(({ get, set }, event: ViewerTransition) => {
    if (ignoreTransition(get(intent$), event)) {
      return undefined;
    }
    if ("owner" in event) {
      return set(imageTransition$, event);
    }
    if (event.type === "stopped") {
      return set(stopped$, event);
    }
    if (event.type !== "streaming") {
      set(internalClipboard$, null);
    }
    set(
      internalLoadingPreview$,
      event.type === "select" && !event.paused && !!event.preview,
    );
    switch (event.type) {
      case "reset": {
        set(internalIntent$, transitionIntent(get(intent$), event));
        set(internalImageRecovery$, null);
        set(inventoryUpdate$, { type: "reset" });
        set(internalFavicons$, new Map());
        set(internalConnected$, false);
        set(pendingTab$, null);
        set(update$, initialSnapshot());
        break;
      }
      case "select": {
        set(internalIntent$, transitionIntent(get(intent$), event));
        set(internalImageRecovery$, null);
        set(update$, {
          selectedTargetId: event.targetId,
          status: event.paused ? "paused" : "connecting",
          error: null,
          navigation: null,
        });
        break;
      }
      case "target-lost":
      case "discovery-failed": {
        set(internalIntent$, transitionIntent(get(intent$), event));
        set(internalImageRecovery$, null);
        if (event.type === "discovery-failed") {
          set(resetDiscoveryInventory$);
        }
        set(update$, {
          selectedTargetId: null,
          status: "unavailable",
          error: event.error,
          navigation: null,
        });
        break;
      }
      case "pause": {
        set(pauseTransition$, event);
        break;
      }
      case "streaming": {
        set(internalImageRecovery$, null);
        set(update$, { status: "streaming", error: null });
        break;
      }
      case "failed": {
        set(invalidateIntent$);
        set(update$, {
          status: "error",
          error: event.error,
          navigation: null,
        });
        break;
      }
      case "closed": {
        set(invalidateIntent$);
        break;
      }
      case "disconnected": {
        set(invalidateIntent$);
        set(internalFavicons$, new Map());
        set(internalConnected$, false);
        set(update$, {
          status: event.established ? "disconnected" : "error",
          error: event.error,
          navigation: null,
        });
        break;
      }
    }
    return undefined;
  });
  const commitIntent$ = command(
    ({ get, set }, event: ViewerIntentTransition) => {
      set(transition$, event);
      // Capture this command's intent before publication can synchronously replace it.
      return get(intent$);
    },
  );
  return { transition$, commitIntent$ };
}

export function createViewerSignals() {
  const createViewerAtomsResult = createViewerAtoms();
  const createViewerValuesResult = createViewerValues({
    ...createViewerAtomsResult,
  });
  const createViewerPresentationResult = createViewerPresentation({
    ...createViewerValuesResult,
    ...createViewerAtomsResult,
  });
  const createViewerActionsResult = createViewerActions({
    ...createViewerAtomsResult,
  });
  const createViewerSettingsResult = createViewerSettings({
    ...createViewerValuesResult,
    ...createViewerAtomsResult,
    ...createViewerActionsResult,
  });
  const createViewerInventoryResult = createViewerInventory({
    ...createViewerAtomsResult,
  });
  const createViewerAddressResult = createViewerAddress({
    ...createViewerAtomsResult,
    ...createViewerPresentationResult,
  });
  const createViewerPublicationResult = createViewerPublication({
    ...createViewerAtomsResult,
  });
  const createViewerImageTransitionsResult = createViewerImageTransitions({
    ...createViewerValuesResult,
    ...createViewerAtomsResult,
    ...createViewerPublicationResult,
  });
  const createViewerTransitionsResult = createViewerTransitions({
    ...createViewerValuesResult,
    ...createViewerImageTransitionsResult,
    ...createViewerAtomsResult,
    ...createViewerPublicationResult,
  });
  return {
    favicons$: createViewerValuesResult.favicons$,
    setFavicon$: createViewerInventoryResult.setFavicon$,
    rejectFavicon$: createViewerInventoryResult.rejectFavicon$,
    display$: createViewerValuesResult.display$,
    windowSizeSync$: createViewerValuesResult.windowSizeSync$,
    setDisplay$: createViewerSettingsResult.setDisplay$,
    chooseWindowSizeSync$: createViewerSettingsResult.chooseWindowSizeSync$,
    syncDisplay$: createViewerActionsResult.syncDisplay$,
    transport$: createViewerValuesResult.transport$,
    chooseTransport$: createViewerSettingsResult.chooseTransport$,
    capture$: createViewerValuesResult.capture$,
    chooseCapture$: createViewerSettingsResult.chooseCapture$,
    clipboard$: createViewerValuesResult.clipboard$,
    setClipboard$: createViewerSettingsResult.setClipboard$,
    copyClipboard$: createViewerActionsResult.copyClipboard$,
    dismissClipboard$: createViewerActionsResult.dismissClipboard$,
    snapshot$: createViewerValuesResult.snapshot$,
    tabLayout$: createViewerPresentationResult.tabLayout$,
    resizeTabs$: createViewerInventoryResult.resizeTabs$,
    notification$: createViewerValuesResult.notification$,
    dismissNotification$: createViewerSettingsResult.dismissNotification$,
    revision$: createViewerValuesResult.revision$,
    address$: createViewerPresentationResult.address$,
    tabAction$: createViewerValuesResult.tabAction$,
    controls$: createViewerPresentationResult.controls$,
    intent$: createViewerValuesResult.intent$,
    commitIntent$: createViewerTransitionsResult.commitIntent$,
    imageRecovery$: createViewerValuesResult.imageRecovery$,
    retryImage$: createViewerActionsResult.retryImage$,
    configure$: createViewerSettingsResult.configure$,
    setConnected$: createViewerSettingsResult.setConnected$,
    setTabAction$: createViewerSettingsResult.setTabAction$,
    createTab$: createViewerActionsResult.createTab$,
    closeTab$: createViewerActionsResult.closeTab$,
    updateData$: createViewerPublicationResult.updateData$,
    inventoryState$: createViewerValuesResult.inventoryState$,
    inventoryUpdate$: createViewerPublicationResult.inventoryUpdate$,
    transition$: createViewerTransitionsResult.transition$,
    bind$: createViewerActionsResult.bind$,
    unbind$: createViewerActionsResult.unbind$,
    reconnect$: createViewerActionsResult.reconnect$,
    select$: createViewerActionsResult.select$,
    navigate$: createViewerActionsResult.navigate$,
    resetAddress$: createViewerAddressResult.resetAddress$,
    focusAddress$: createViewerAddressResult.focusAddress$,
    editAddress$: createViewerAddressResult.editAddress$,
    blurAddress$: createViewerAddressResult.blurAddress$,
    submitAddress$: createViewerAddressResult.submitAddress$,
  };
}

type Value<T> = T extends Computed<infer V> ? V : never;
type Action<T> =
  T extends Command<infer R, infer A> ? (...args: A) => R : never;
export type ViewerSignals = ReturnType<typeof createViewerSignals>;

/** Native resources observe and publish semantic state in their mounted App lifetime. */
export interface ViewerModel {
  getSnapshot: () => ViewerSnapshot;
  update: (patch: ViewerUpdate) => void;
  inventory: (event: InventoryEvent) => Value<ViewerSignals["inventoryState$"]>;
  transition: Action<ViewerSignals["transition$"]>;
  commitIntent: Action<ViewerSignals["commitIntent$"]>;
  configure: Action<ViewerSignals["configure$"]>;
  intent: () => Value<ViewerSignals["intent$"]>;
  controls: () => Value<ViewerSignals["controls$"]>;
  imageRecovery: () => Value<ViewerSignals["imageRecovery$"]>;
  display: () => Value<ViewerSignals["display$"]>;
  resetAddress: Action<ViewerSignals["resetAddress$"]>;
  setTabAction: Action<ViewerSignals["setTabAction$"]>;
  setConnected: Action<ViewerSignals["setConnected$"]>;
  setDisplay: Action<ViewerSignals["setDisplay$"]>;
  setFavicon: Action<ViewerSignals["setFavicon$"]>;
  inventoryState: () => Value<ViewerSignals["inventoryState$"]>;
}

function sameTargets(
  next: ViewerSnapshot["targets"],
  old: ViewerSnapshot["targets"],
): boolean {
  return (
    next !== old &&
    next.length === old.length &&
    next.every((target, index) => {
      return target.id === old[index]?.id && target.title === old[index]?.title;
    })
  );
}
function sameNavigation(
  next: ViewerSnapshot["navigation"],
  old: ViewerSnapshot["navigation"],
): boolean {
  return (
    !!next &&
    !!old &&
    next.url === old.url &&
    next.canGoBack === old.canGoBack &&
    next.canGoForward === old.canGoForward
  );
}
function needsRecovery(snapshot: ViewerSnapshot): boolean {
  return (
    snapshot.status === "error" ||
    snapshot.status === "disconnected" ||
    (snapshot.status === "unavailable" &&
      snapshot.error?.kind !== "target-unavailable" &&
      !!snapshot.error)
  );
}

function ignoreTransition(
  intent: ReturnType<typeof initialIntent>,
  event: ViewerTransition,
): boolean {
  return (
    (event.type === "pause" && intent.paused === event.paused) ||
    (event.type === "streaming" && intent.paused)
  );
}

function imageControls(
  image: ImageRecovery | null,
  status: ViewerSnapshot["status"],
  connected: boolean,
) {
  const unavailableImage = image && image.phase !== "presented";
  return {
    showImageRetry:
      !!unavailableImage && image.phase !== "blocked" && status !== "paused",
    canRetryImage: image?.phase === "ready" && status !== "paused" && connected,
    retryingImage: retryingImage(image),
  };
}

function createStoppedTransition({
  internalClipboard$,
  internalLoadingPreview$,
  internalNotification$,
  snapshot$,
  update$,
}: Pick<
  ViewerAtoms & ViewerValues & ViewerPublication,
  | "internalClipboard$"
  | "internalLoadingPreview$"
  | "internalNotification$"
  | "snapshot$"
  | "update$"
>) {
  return command(
    ({ get, set }, event: Extract<ViewerTransition, { type: "stopped" }>) => {
      set(internalClipboard$, null);
      if (!event.retainFrame) {
        set(internalLoadingPreview$, false);
      }
      set(internalNotification$, null);
      if (get(snapshot$).navigation) {
        set(update$, { navigation: null });
      }
      return undefined;
    },
  );
}
