import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  createDeferredPromise,
  detach,
  Reason,
  resetSignal,
  setLoop,
} from "../../utils.ts";
import { monotonicNow } from "../../../lib/time.ts";

import type { CdpClient } from "../cdp/client.ts";
import { CdpFault } from "../cdp/errors.ts";
import type { FrameSink } from "../render/canvas.ts";
import type { Viewport } from "../display/geometry.ts";
import { sameCaptureSettings, type CaptureSettings } from "./capture.ts";
import { maximumEncodedFrameLength } from "../display/limits.ts";

interface ScreencastOwner {
  readonly client: CdpClient;
  readonly sessionId: string;
  readonly maxFramesInFlight$: Computed<number>;
  readonly sink: FrameSink;
  /** Resource ownership survives a temporary input/presentation admission gate. */
  readonly alive$: Computed<boolean>;
  /** Native pictures remain private until current selected membership is proved. */
  readonly admitted$: Computed<boolean>;
  readonly waitForAdmission$: Command<Promise<void>, [AbortSignal]>;
  /** starting$ invalidates the previous capture's accepted-paint proof. */
  readonly painted$: Computed<boolean>;
  readonly failed$: Command<unknown, [unknown, AbortSignal]>;
  readonly starting$: Command<void, [CaptureSettings, AbortSignal]>;
}

type NativeCapture =
  | { readonly kind: "stopped" }
  | { readonly kind: "possible"; readonly epoch: object };

interface CaptureFrame {
  readonly revision: number;
  readonly data: string;
  readonly painted: (raster: Viewport) => void;
  readonly accept: ((raster: Viewport) => boolean) | undefined;
}

type CaptureLane = {
  readonly owner: object;
  readonly kind: "configuration" | "exclusive" | "cleanup";
};

type LaneWaiter = CaptureLane & {
  /** A cancelled event cannot claim the lane. No operation promise is stored. */
  readonly grant: () => boolean;
};

type CaptureState = ReturnType<typeof createCaptureState>;
type CaptureLaneCommands = ReturnType<typeof createCaptureLane>;
type CaptureCore = ReturnType<typeof createCaptureCore>;
type CaptureStop = ReturnType<typeof createCaptureStop>;
type CaptureBegin = ReturnType<typeof createCaptureBegin>;
type CaptureNavigation = ReturnType<typeof createCaptureNavigation>;
type CaptureConfiguration = ReturnType<typeof createCaptureConfiguration>;
type CaptureExclusive = ReturnType<typeof createCaptureExclusive>;
type CaptureCleanup = ReturnType<typeof createCaptureCleanup>;

function createCaptureState(owner: ScreencastOwner, settings: CaptureSettings) {
  const started$ = state(false);
  const ownerActive$ = state(false);
  const disposed$ = state(false);
  const halted$ = state(false);
  const accepting$ = state(false);
  const revision$ = state(0);
  const pendingFrame$ = state<CaptureFrame | null>(null);
  const presentingFrame$ = state<CaptureFrame | null>(null);
  const invalidateFrames$ = command(({ get, set }) => {
    set(revision$, get(revision$) + 1);
    set(pendingFrame$, null);
    set(presentingFrame$, null);
  });
  const desired$ = state(settings);
  const applied$ = state<CaptureSettings | null>(null);
  const native$ = state<NativeCapture>({ kind: "stopped" });
  const resetFirstFrame$ = resetSignal();
  const detachedState$ = state(false);
  const lane$ = state<CaptureLane | null>(null);
  const reservation$ = state<object | null>(null);
  const laneWaiters$ = state<readonly LaneWaiter[]>([]);
  const navigationRevision$ = state(0);
  const navigating$ = state<ReadonlySet<string>>(new Set());
  const navigationListeners$ = state<ReadonlySet<(done: boolean) => void>>(
    new Set(),
  );

  const alive$ = computed((get) => {
    return (
      get(ownerActive$) &&
      !get(disposed$) &&
      !get(detachedState$) &&
      get(owner.alive$)
    );
  });
  const acceptingFrames$ = computed((get) => {
    return get(alive$) && !get(halted$) && get(accepting$);
  });
  const stopped$ = computed((get) => {
    return get(native$).kind === "stopped";
  });

  return {
    started$,
    ownerActive$,
    disposed$,
    halted$,
    accepting$,
    revision$,
    pendingFrame$,
    presentingFrame$,
    invalidateFrames$,
    desired$,
    applied$,
    native$,
    resetFirstFrame$,
    detachedState$,
    lane$,
    reservation$,
    laneWaiters$,
    navigationRevision$,
    navigating$,
    navigationListeners$,
    alive$,
    acceptingFrames$,
    stopped$,
  };
}

function createCaptureLane(graph: CaptureState) {
  const { lane$, laneWaiters$ } = graph;
  const releaseLane$ = command(({ get, set }, identity: object) => {
    if (get(lane$)?.owner !== identity) {
      return;
    }
    set(lane$, null);
    const waiting = [...get(laneWaiters$)];
    while (waiting.length) {
      const next = waiting.shift()!;
      if (next.grant()) {
        // FIFO transfer is synchronous, before the awakened caller can run.
        set(lane$, { owner: next.owner, kind: next.kind });
        break;
      }
    }
    set(laneWaiters$, waiting);
  });
  const cancelLaneWaiter$ = command(({ get, set }, identity: object) => {
    set(
      laneWaiters$,
      get(laneWaiters$).filter((waiter) => {
        return waiter.owner !== identity;
      }),
    );
    // Abort can race with a grant. Never strand a lane owned by that caller.
    set(releaseLane$, identity);
  });
  const acquireLane$ = command(
    async (
      { get, set },
      identity: object,
      kind: CaptureLane["kind"],
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (!get(lane$)) {
        set(lane$, { owner: identity, kind });
        return;
      }
      const event = createDeferredPromise<void>(signal);
      const waiter: LaneWaiter = {
        owner: identity,
        kind,
        grant: () => {
          if (event.settled()) {
            return false;
          }
          event.resolve();
          return true;
        },
      };
      set(laneWaiters$, [...get(laneWaiters$), waiter]);
      const [result] = await Promise.allSettled([event.promise]);
      if (signal.aborted) {
        set(cancelLaneWaiter$, identity);
        signal.throwIfAborted();
      }
      if (result.status === "rejected") {
        set(cancelLaneWaiter$, identity);
        throw result.reason;
      }
    },
  );
  return { releaseLane$, acquireLane$ };
}

function createCaptureCore(owner: ScreencastOwner, graph: CaptureState) {
  const {
    navigationListeners$,
    halted$,
    disposed$,
    accepting$,
    invalidateFrames$,
    alive$,
    native$,
    detachedState$,
    resetFirstFrame$,
  } = graph;
  const navigationSettled$ = command(({ get, set }, done: boolean) => {
    const listeners = get(navigationListeners$);
    set(navigationListeners$, new Set());
    for (const listener of listeners) {
      listener(done);
    }
  });
  const pause$ = command(({ set }) => {
    set(resetFirstFrame$, AbortSignal.abort());
    set(accepting$, false);
    set(invalidateFrames$);
    owner.sink.invalidate();
    set(navigationSettled$, false);
  });
  const suspend$ = command(({ get, set }) => {
    if (get(halted$) || get(disposed$)) {
      return;
    }
    set(halted$, true);
    set(pause$);
  });
  const fail$ = command(({ get, set }, error: unknown, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(alive$) || get(halted$)) {
      return;
    }
    set(suspend$);
    // Failure invalidates foreground work; its original cleanup must still finish.
    return set(owner.failed$, error, owner.client.signal);
  });

  const detached$ = command(({ set }) => {
    // CDP session teardown disables Page and releases its native screencast.
    set(detachedState$, true);
    set(native$, { kind: "stopped" });
    set(suspend$);
  });

  return {
    navigationSettled$,
    pause$,
    suspend$,
    fail$,
    detached$,
  };
}

function createCaptureStop(owner: ScreencastOwner, graph: CaptureState) {
  const {
    native$,
    accepting$,
    invalidateFrames$,
    detachedState$,
    resetFirstFrame$,
  } = graph;
  const stopConfirmed$ = command(({ get, set }, native: NativeCapture) => {
    const latest = get(native$);
    if (
      latest.kind === "stopped" ||
      (native.kind === "possible" && latest.epoch === native.epoch)
    ) {
      set(native$, { kind: "stopped" });
    }
  });
  /** Stop receipts belong to the original native stream after selection retires. */
  const stop$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (get(detachedState$)) {
        return;
      }
      const native = get(native$);
      set(resetFirstFrame$, AbortSignal.abort());
      set(accepting$, false);
      set(invalidateFrames$);
      owner.sink.invalidate();
      const [result] = await Promise.allSettled([
        owner.client.request(
          "Page.stopScreencast",
          undefined,
          owner.sessionId,
          () => {
            set(stopConfirmed$, native);
          },
          signal,
        ),
      ]);
      signal.throwIfAborted();
      if (get(detachedState$)) {
        return;
      }
      if (result.status === "rejected") {
        throw result.reason;
      }
      set(stopConfirmed$, native);
      signal.throwIfAborted();
    },
  );

  return { stop$ };
}

/** One acknowledged capture owns its first-image budget, independently of readers. */
function createCaptureReadiness(
  owner: ScreencastOwner,
  graph: CaptureState,
  core: CaptureCore,
) {
  const { alive$, native$, halted$, resetFirstFrame$ } = graph;
  return command(({ get, set }, native: NativeCapture) => {
    const signal = set(resetFirstFrame$, owner.client.signal);
    const deadline = monotonicNow() + 30_000;
    setLoop(
      async () => {
        if (
          !get(alive$) ||
          get(native$) !== native ||
          get(halted$) ||
          get(owner.painted$)
        ) {
          return true;
        }
        if (monotonicNow() < deadline) {
          return false;
        }
        // Suspending the capture ends this timer; original receipt cleanup must
        // retain the transport owner instead of inheriting the timer's signal.
        await set(
          core.fail$,
          new CdpFault(
            "frame",
            "The browser did not receive a usable image in time.",
          ),
          owner.client.signal,
        );
        return true;
      },
      1000,
      signal,
      { testIntervalMs: 10 },
    );
  });
}

function createCaptureBegin(
  owner: ScreencastOwner,
  graph: CaptureState,
  ports: CaptureLaneCommands & CaptureStop,
  observeFirstFrame$: ReturnType<typeof createCaptureReadiness>,
) {
  const {
    native$,
    alive$,
    halted$,
    accepting$,
    applied$,
    stopped$,
    resetFirstFrame$,
  } = graph;
  const { acquireLane$, releaseLane$, stop$ } = ports;
  const cleanupLateStart$ = command(
    async (
      { get, set },
      native: NativeCapture,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const identity = {};
      await set(acquireLane$, identity, "cleanup", signal);
      const [result] = await Promise.allSettled(
        get(native$) === native || !get(alive$) || get(halted$)
          ? [set(stop$, signal)]
          : [],
      );
      if (signal.aborted) {
        set(releaseLane$, identity);
        signal.throwIfAborted();
      }
      set(releaseLane$, identity);
      if (result?.status === "rejected") {
        throw result.reason;
      }
    },
  );
  const begin$ = command(
    async (
      { get, set },
      next: CaptureSettings,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      await set(owner.waitForAdmission$, signal);
      if (!get(alive$)) {
        return;
      }
      if (get(halted$)) {
        throw new CdpFault("frame", "The live image is unavailable.");
      }
      const native: NativeCapture = { kind: "possible", epoch: {} };
      set(resetFirstFrame$, AbortSignal.abort());
      set(accepting$, true);
      set(native$, native);
      set(owner.starting$, next, signal);
      signal.throwIfAborted();
      if (!get(alive$) || get(halted$)) {
        return;
      }
      const { quality, ...image } = next;
      await owner.client.request(
        "Page.startScreencast",
        {
          ...image,
          ...(next.format === "png" ? {} : { quality }),
          maxFramesInFlight: get(owner.maxFramesInFlight$),
          sendLastFrame: true,
        },
        owner.sessionId,
        async () => {
          // Native receipt cleanup outlives the cancelled selected owner. The
          // client signal is this original transport's fixed resource scope.
          await set(cleanupLateStart$, native, owner.client.signal);
        },
        signal,
      );
      signal.throwIfAborted();
      if (!get(alive$) || get(native$) !== native || get(halted$)) {
        return;
      }
      set(applied$, next);
      set(observeFirstFrame$, native);
    },
  );
  const resume$ = command(({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(alive$) || get(halted$) || get(stopped$)) {
      return;
    }
    set(accepting$, true);
    // A rejected stop can resume the acknowledged native capture without begin$.
    set(observeFirstFrame$, get(native$));
  });

  return { begin$, resume$ };
}

function createCaptureNavigation(graph: CaptureState, core: CaptureCore) {
  const {
    navigating$,
    alive$,
    navigationListeners$,
    halted$,
    navigationRevision$,
  } = graph;
  const { navigationSettled$ } = core;
  const waitForNavigation$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      signal.throwIfAborted();
      if (!get(navigating$).size || !get(alive$)) {
        return true;
      }
      const event = createDeferredPromise<boolean>(signal);
      const finish = (done: boolean) => {
        if (!event.settled()) {
          event.resolve(done);
        }
      };
      set(navigationListeners$, new Set(get(navigationListeners$)).add(finish));
      const [result] = await Promise.allSettled([event.promise]);
      if (signal.aborted) {
        const listeners = new Set(get(navigationListeners$));
        listeners.delete(finish);
        set(navigationListeners$, listeners);
        signal.throwIfAborted();
      }
      const listeners = new Set(get(navigationListeners$));
      listeners.delete(finish);
      set(navigationListeners$, listeners);
      if (result.status === "rejected") {
        throw result.reason;
      }
      return result.value && get(alive$) && !get(halted$);
    },
  );

  const navigationStarted$ = command(({ get, set }, frameId: string) => {
    set(navigationRevision$, get(navigationRevision$) + 1);
    set(navigating$, new Set(get(navigating$)).add(frameId));
  });
  const navigationFinished$ = command(({ get, set }, frameId: string) => {
    const navigating = new Set(get(navigating$));
    navigating.delete(frameId);
    set(navigating$, navigating);
    if (!navigating.size) {
      set(navigationSettled$, true);
    }
  });
  return { waitForNavigation$, navigationStarted$, navigationFinished$ };
}

function createCaptureConfiguration(
  owner: ScreencastOwner,
  graph: CaptureState,
  ports: CaptureCore &
    CaptureLaneCommands &
    CaptureStop &
    CaptureBegin &
    CaptureNavigation,
) {
  const {
    alive$,
    halted$,
    reservation$,
    applied$,
    desired$,
    stopped$,
    navigationRevision$,
    navigating$,
    accepting$,
    invalidateFrames$,
  } = graph;
  const {
    stop$,
    begin$,
    waitForNavigation$,
    acquireLane$,
    releaseLane$,
    fail$,
  } = ports;
  const configureLane$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      let recoveredNavigation = false;
      while (get(alive$) && !get(halted$) && !get(reservation$)) {
        const previous = get(applied$);
        if (previous && sameCaptureSettings(previous, get(desired$))) {
          return;
        }
        if (!get(stopped$)) {
          await set(stop$, signal);
          signal.throwIfAborted();
          if (!get(alive$) || get(halted$)) {
            return;
          }
        }
        // Coalesce every preference received before the stop receipt.
        const next = get(desired$);
        const navigation = get(navigationRevision$);
        const [started] = await Promise.allSettled([set(begin$, next, signal)]);
        signal.throwIfAborted();
        if (started.status === "rejected") {
          const error: unknown = started.reason;
          if (
            !previous ||
            recoveredNavigation ||
            !(error instanceof CdpFault) ||
            error.code !== -32_000 ||
            (!get(navigating$).size && navigation === get(navigationRevision$))
          ) {
            throw error;
          }
          recoveredNavigation = true;
          set(accepting$, false);
          set(invalidateFrames$);
          owner.sink.invalidate();
          if (!(await set(waitForNavigation$, signal))) {
            throw error;
          }
          set(applied$, null);
        }
      }
    },
  );
  const reconcile$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const identity = {};
      await set(acquireLane$, identity, "configuration", signal);
      if (signal.aborted) {
        set(releaseLane$, identity);
        signal.throwIfAborted();
      }
      if (!get(alive$) || get(halted$) || get(reservation$)) {
        set(releaseLane$, identity);
        return;
      }
      const [result] = await Promise.allSettled([set(configureLane$, signal)]);
      if (signal.aborted) {
        set(releaseLane$, identity);
        signal.throwIfAborted();
      }
      // Release before reporting failure: recovery can synchronously quiesce it.
      set(releaseLane$, identity);
      if (result.status === "rejected") {
        await set(fail$, result.reason, signal);
        throw result.reason;
      }
    },
  );

  return { reconcile$ };
}

function createCaptureLifecycle(
  owner: ScreencastOwner,
  graph: CaptureState,
  ports: CaptureCore & CaptureConfiguration & CaptureCleanup,
) {
  const {
    ownerActive$,
    accepting$,
    invalidateFrames$,
    disposed$,
    started$,
    desired$,
    navigating$,
  } = graph;
  const { navigationSettled$, reconcile$, quiesce$ } = ports;
  const abort$ = command(({ set }) => {
    set(ownerActive$, false);
    set(accepting$, false);
    set(invalidateFrames$);
    set(navigationSettled$, false);
    owner.sink.invalidate();
  });
  const start$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (get(disposed$) || (get(started$) && !get(ownerActive$))) {
        throw new CdpFault("frame", "Capture has been retired.");
      }
      if (!get(started$)) {
        set(started$, true);
        set(ownerActive$, true);
        owner.client.signal.addEventListener(
          "abort",
          () => {
            set(abort$);
          },
          { once: true },
        );
        // Publishing startup facts can synchronously retire the owner.
        if (owner.client.signal.aborted) {
          set(abort$);
          owner.client.signal.throwIfAborted();
        }
      }
      await set(reconcile$, signal);
      signal.throwIfAborted();
    },
  );
  const configure$ = command(
    async (
      { set },
      next: CaptureSettings,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      set(desired$, next);
      await set(reconcile$, signal);
      signal.throwIfAborted();
    },
  );

  const dispose$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (!get(disposed$)) {
        set(disposed$, true);
        set(ownerActive$, false);
        set(accepting$, false);
        set(invalidateFrames$);
        set(navigationSettled$, false);
        set(navigating$, new Set());
        owner.sink.invalidate();
      }
      // A notification is not a receipt. Cleanup awaits this ORIGINAL session.
      await set(quiesce$, signal);
      signal.throwIfAborted();
    },
  );
  return { start$, configure$, dispose$ };
}

function createCaptureExclusive(
  graph: CaptureState,
  ports: CaptureLaneCommands & CaptureConfiguration,
) {
  const { alive$, halted$, reservation$ } = graph;
  const { releaseLane$, acquireLane$, reconcile$ } = ports;
  const runExclusive$ = command(
    async (
      { get, set },
      operation$: Command<Promise<void>, [AbortSignal]>,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (get(alive$) && !get(halted$)) {
        await set(operation$, signal);
        signal.throwIfAborted();
      }
    },
  );
  const releaseReservation$ = command(({ get, set }, identity: object) => {
    set(releaseLane$, identity);
    if (get(reservation$) === identity) {
      set(reservation$, null);
    }
  });
  const exclusive$ = command(
    async (
      { get, set },
      operation$: Command<Promise<void>, [AbortSignal]>,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (get(halted$)) {
        throw new CdpFault(
          "frame",
          "The live image must be retried before capture work can continue.",
        );
      }
      if (get(reservation$)) {
        throw new CdpFault(
          "protocol",
          "A capture operation is already in progress.",
        );
      }
      const identity = {};
      set(reservation$, identity);
      const [acquired] = await Promise.allSettled([
        set(acquireLane$, identity, "exclusive", signal),
      ]);
      if (signal.aborted) {
        set(releaseReservation$, identity);
        signal.throwIfAborted();
      }
      if (acquired.status === "rejected") {
        set(releaseReservation$, identity);
        throw acquired.reason;
      }
      const [result] = await Promise.allSettled([
        set(runExclusive$, operation$, signal),
      ]);
      if (signal.aborted) {
        set(releaseReservation$, identity);
        signal.throwIfAborted();
      }
      set(releaseReservation$, identity);
      if (result.status === "rejected") {
        throw result.reason;
      }
      await set(reconcile$, signal);
      signal.throwIfAborted();
    },
  );

  return { exclusive$, releaseReservation$ };
}

function createCaptureCleanup(
  graph: CaptureState,
  ports: CaptureLaneCommands & CaptureStop,
) {
  const { stopped$ } = graph;
  const { stop$, acquireLane$, releaseLane$ } = ports;
  const stopLane$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (!get(stopped$)) {
        await set(stop$, signal);
      }
      if (!get(stopped$)) {
        throw new CdpFault("frame", "Capture cleanup could not be confirmed.");
      }
    },
  );
  const quiesce$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const identity = {};
      await set(acquireLane$, identity, "cleanup", signal);
      const [result] = await Promise.allSettled([set(stopLane$, signal)]);
      if (signal.aborted) {
        set(releaseLane$, identity);
        signal.throwIfAborted();
      }
      set(releaseLane$, identity);
      if (result.status === "rejected") {
        throw result.reason;
      }
    },
  );

  return { quiesce$ };
}

function createCaptureRetry(
  graph: CaptureState,
  ports: CaptureCore &
    CaptureLaneCommands &
    CaptureBegin &
    CaptureConfiguration &
    CaptureExclusive &
    CaptureCleanup,
) {
  const { alive$, halted$, applied$, desired$, reservation$ } = graph;
  const {
    begin$,
    quiesce$,
    acquireLane$,
    releaseReservation$,
    fail$,
    reconcile$,
  } = ports;
  const retryLane$ = command(
    async (
      { get, set },
      prepare$: Command<Promise<void>, [AbortSignal]>,
      starting$: Command<void, []>,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      await set(prepare$, signal);
      signal.throwIfAborted();
      if (!get(alive$)) {
        return;
      }
      set(starting$);
      if (!get(alive$)) {
        return;
      }
      set(halted$, false);
      set(applied$, null);
      await set(begin$, get(desired$), signal);
    },
  );
  const retry$ = command(
    async (
      { get, set },
      prepare$: Command<Promise<void>, [AbortSignal]>,
      starting$: Command<void, []>,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      await set(quiesce$, signal);
      signal.throwIfAborted();
      if (!get(alive$)) {
        return;
      }
      if (get(reservation$)) {
        throw new CdpFault(
          "protocol",
          "A capture operation is already in progress.",
        );
      }
      const identity = {};
      set(reservation$, identity);
      const [acquired] = await Promise.allSettled([
        set(acquireLane$, identity, "exclusive", signal),
      ]);
      if (signal.aborted) {
        set(releaseReservation$, identity);
        signal.throwIfAborted();
      }
      if (acquired.status === "rejected") {
        set(releaseReservation$, identity);
        throw acquired.reason;
      }
      const [result] = await Promise.allSettled([
        set(retryLane$, prepare$, starting$, signal),
      ]);
      if (signal.aborted) {
        set(releaseReservation$, identity);
        signal.throwIfAborted();
      }
      set(releaseReservation$, identity);
      if (result.status === "rejected") {
        await set(fail$, result.reason, signal);
        throw result.reason;
      }
      await set(reconcile$, signal);
      signal.throwIfAborted();
    },
  );

  return { retry$ };
}

function createCaptureFrames(
  owner: ScreencastOwner,
  graph: CaptureState,
  core: CaptureCore,
) {
  const { acceptingFrames$, revision$, pendingFrame$, presentingFrame$ } =
    graph;
  const { fail$ } = core;
  const owns$ = command(({ get }, revision: number) => {
    return get(acceptingFrames$) && get(revision$) === revision;
  });
  const release$ = command(
    ({ get, set }, frame: CaptureFrame, discard: boolean) => {
      if (discard && get(pendingFrame$) === frame) {
        set(pendingFrame$, null);
      }
      if (get(presentingFrame$) === frame) {
        set(presentingFrame$, null);
      }
    },
  );
  const acceptPaint$ = command(
    ({ get, set }, frame: CaptureFrame, raster: Viewport) => {
      if (!set(owns$, frame.revision)) {
        return false;
      }
      if (!get(owner.admitted$)) {
        // Keep the original observation, not a decoded image or an authority grant.
        set(release$, frame, false);
        return false;
      }
      const accepted = frame.accept?.(raster) ?? true;
      if (!accepted) {
        set(release$, frame, true);
      }
      return accepted;
    },
  );
  const framePainted$ = command(
    ({ set }, frame: CaptureFrame, raster: Viewport) => {
      if (!set(owns$, frame.revision)) {
        return;
      }
      set(release$, frame, true);
      frame.painted(raster);
    },
  );
  const frameFailed$ = command(
    async (
      { set },
      revision: number,
      error: unknown,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (set(owns$, revision)) {
        await set(fail$, error, signal);
      }
    },
  );
  const present$ = command(({ get, set }) => {
    if (owner.client.signal.aborted || !get(owner.admitted$)) {
      return;
    }
    const frame = get(pendingFrame$);
    if (!frame || !set(owns$, frame.revision)) {
      return;
    }
    if (get(presentingFrame$) === frame) {
      return;
    }
    set(presentingFrame$, frame);
    owner.sink.push(
      frame.data,
      (raster) => {
        if (!owner.client.signal.aborted) {
          set(framePainted$, frame, raster);
        }
      },
      (error) => {
        detach(
          set(frameFailed$, frame.revision, error, owner.client.signal),
          Reason.DomCallback,
          "browser raster event",
        );
      },
      (raster) => {
        return !owner.client.signal.aborted && set(acceptPaint$, frame, raster);
      },
    );
  });
  const push$ = command(
    (
      { get, set },
      data: string,
      painted: (raster: Viewport) => void,
      accept: ((raster: Viewport) => boolean) | undefined,
    ) => {
      owner.client.signal.throwIfAborted();
      if (!get(acceptingFrames$)) {
        return;
      }
      const frame: CaptureFrame = {
        revision: get(revision$),
        data,
        painted,
        accept,
      };
      if (data.length > maximumEncodedFrameLength) {
        detach(
          set(
            frameFailed$,
            frame.revision,
            new CdpFault("frame", "The browser sent an oversized frame."),
            owner.client.signal,
          ),
          Reason.DomCallback,
          "browser encoded frame validation",
        );
        return;
      }
      // One latest resource-owned observation; only present$ may expose it.
      set(pendingFrame$, frame);
      set(present$);
    },
  );
  return { push$, present$ };
}

/** One selected native session; every private graph is composed before execution. */
export function createScreencast(
  owner: ScreencastOwner,
  settings: CaptureSettings,
) {
  const graph = createCaptureState(owner, settings);
  const lane = createCaptureLane(graph);
  const core = createCaptureCore(owner, graph);
  const stop = createCaptureStop(owner, graph);
  const observeFirstFrame$ = createCaptureReadiness(owner, graph, core);
  const begin = createCaptureBegin(
    owner,
    graph,
    { ...lane, ...stop },
    observeFirstFrame$,
  );
  const navigation = createCaptureNavigation(graph, core);
  const configuration = createCaptureConfiguration(owner, graph, {
    ...core,
    ...lane,
    ...stop,
    ...begin,
    ...navigation,
  });
  const exclusive = createCaptureExclusive(graph, {
    ...lane,
    ...configuration,
  });
  const cleanup = createCaptureCleanup(graph, { ...lane, ...stop });
  const retry = createCaptureRetry(graph, {
    ...core,
    ...lane,
    ...begin,
    ...configuration,
    ...exclusive,
    ...cleanup,
  });
  const lifecycle = createCaptureLifecycle(owner, graph, {
    ...core,
    ...configuration,
    ...cleanup,
  });
  const frames = createCaptureFrames(owner, graph, core);
  return {
    acceptingFrames$: graph.acceptingFrames$,
    stopped$: graph.stopped$,
    ...lifecycle,
    navigationStarted$: navigation.navigationStarted$,
    navigationFinished$: navigation.navigationFinished$,
    ...frames,
    exclusive$: exclusive.exclusive$,
    pause$: core.pause$,
    suspend$: core.suspend$,
    detached$: core.detached$,
    ...cleanup,
    ...retry,
    ...stop,
    ...begin,
  };
}
