import { command, computed, state, type Command, type Computed } from "ccstate";
import { createDeferredPromise, detach, Reason } from "../../utils.ts";

import type { CdpClient } from "../cdp/client.ts";
import { CdpFault } from "../cdp/errors.ts";
import type { FrameSink } from "../render/canvas.ts";
import type { Viewport } from "../display/geometry.ts";
import { sameCaptureSettings, type CaptureSettings } from "./capture.ts";

interface ScreencastOwner {
  readonly client: CdpClient;
  readonly sessionId: string;
  readonly sink: FrameSink;
  readonly current$: Computed<boolean>;
  readonly failed$: Command<unknown, [unknown, AbortSignal]>;
  readonly starting$?: Command<unknown, [CaptureSettings, AbortSignal]>;
}

type NativeCapture =
  | { readonly kind: "stopped" }
  | { readonly kind: "possible"; readonly epoch: object };

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
  const desired$ = state(settings);
  const applied$ = state<CaptureSettings | null>(null);
  const native$ = state<NativeCapture>({ kind: "stopped" });
  const lane$ = state<CaptureLane | null>(null);
  const reservation$ = state<object | null>(null);
  const laneWaiters$ = state<readonly LaneWaiter[]>([]);
  const navigationRevision$ = state(0);
  const navigating$ = state<ReadonlySet<string>>(new Set());
  const navigationListeners$ = state<ReadonlySet<(done: boolean) => void>>(
    new Set(),
  );

  const current$ = computed((get) => {
    return get(ownerActive$) && !get(disposed$) && get(owner.current$);
  });
  const acceptingFrames$ = computed((get) => {
    return get(current$) && !get(halted$) && get(accepting$);
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
    desired$,
    applied$,
    native$,
    lane$,
    reservation$,
    laneWaiters$,
    navigationRevision$,
    navigating$,
    navigationListeners$,
    current$,
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
    revision$,
    current$,
  } = graph;
  const navigationSettled$ = command(({ get, set }, done: boolean) => {
    const listeners = get(navigationListeners$);
    set(navigationListeners$, new Set());
    for (const listener of listeners) {
      listener(done);
    }
  });
  const suspend$ = command(({ get, set }) => {
    if (get(halted$) || get(disposed$)) {
      return;
    }
    set(halted$, true);
    set(accepting$, false);
    set(revision$, get(revision$) + 1);
    owner.sink.invalidate();
    set(navigationSettled$, false);
  });
  const fail$ = command(
    async (
      { get, set },
      error: unknown,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (!get(current$) || get(halted$)) {
        return;
      }
      set(suspend$);
      await set(owner.failed$, error, signal);
      signal.throwIfAborted();
    },
  );

  return {
    navigationSettled$,
    suspend$,
    fail$,
  };
}

function createCaptureStop(owner: ScreencastOwner, graph: CaptureState) {
  const { native$, accepting$, revision$ } = graph;
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
      const native = get(native$);
      set(accepting$, false);
      set(revision$, get(revision$) + 1);
      owner.sink.invalidate();
      await owner.client.request(
        "Page.stopScreencast",
        undefined,
        owner.sessionId,
        () => {
          set(stopConfirmed$, native);
        },
        signal,
      );
      set(stopConfirmed$, native);
      signal.throwIfAborted();
    },
  );

  return { stop$ };
}

function createCaptureBegin(
  owner: ScreencastOwner,
  graph: CaptureState,
  ports: CaptureLaneCommands & CaptureStop,
) {
  const { native$, current$, halted$, accepting$, applied$, stopped$ } = graph;
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
        get(native$) === native || !get(current$) || get(halted$)
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
      if (!get(current$)) {
        return;
      }
      if (get(halted$)) {
        throw new CdpFault("frame", "The live image is unavailable.");
      }
      const native: NativeCapture = { kind: "possible", epoch: {} };
      set(accepting$, true);
      set(native$, native);
      if (owner.starting$) {
        await set(owner.starting$, next, signal);
        signal.throwIfAborted();
      }
      if (!get(current$) || get(halted$)) {
        return;
      }
      const { quality, ...image } = next;
      await owner.client.request(
        "Page.startScreencast",
        {
          ...image,
          ...(next.format === "png" ? {} : { quality }),
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
      if (!get(current$) || get(native$) !== native || get(halted$)) {
        return;
      }
      set(applied$, next);
    },
  );
  const resume$ = command(({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!get(current$) || get(halted$) || get(stopped$)) {
      return;
    }
    set(accepting$, true);
  });

  return { begin$, resume$ };
}

function createCaptureNavigation(graph: CaptureState, core: CaptureCore) {
  const {
    navigating$,
    current$,
    navigationListeners$,
    halted$,
    navigationRevision$,
  } = graph;
  const { navigationSettled$ } = core;
  const waitForNavigation$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      signal.throwIfAborted();
      if (!get(navigating$).size || !get(current$)) {
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
      return result.value && get(current$) && !get(halted$);
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
    current$,
    halted$,
    reservation$,
    applied$,
    desired$,
    stopped$,
    navigationRevision$,
    navigating$,
    accepting$,
    revision$,
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
      while (get(current$) && !get(halted$) && !get(reservation$)) {
        const previous = get(applied$);
        if (previous && sameCaptureSettings(previous, get(desired$))) {
          return;
        }
        if (!get(stopped$)) {
          await set(stop$, signal);
          signal.throwIfAborted();
          if (!get(current$) || get(halted$)) {
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
          set(revision$, get(revision$) + 1);
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
      if (!get(current$) || get(halted$) || get(reservation$)) {
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
    revision$,
    disposed$,
    started$,
    desired$,
    navigating$,
  } = graph;
  const { navigationSettled$, reconcile$, quiesce$ } = ports;
  const abort$ = command(({ get, set }) => {
    set(ownerActive$, false);
    set(accepting$, false);
    set(revision$, get(revision$) + 1);
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
        signal.addEventListener(
          "abort",
          () => {
            set(abort$);
          },
          { once: true },
        );
        // Publishing startup facts can synchronously retire the owner.
        if (signal.aborted) {
          set(abort$);
          signal.throwIfAborted();
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
        set(revision$, get(revision$) + 1);
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
  const { current$, halted$, reservation$ } = graph;
  const { releaseLane$, acquireLane$, reconcile$ } = ports;
  const runExclusive$ = command(
    async (
      { get, set },
      operation$: Command<Promise<void>, [AbortSignal]>,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (get(current$) && !get(halted$)) {
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
  const { current$, halted$, applied$, desired$, reservation$ } = graph;
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
      if (!get(current$)) {
        return;
      }
      set(starting$);
      if (!get(current$)) {
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
      if (!get(current$)) {
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
  const { acceptingFrames$, revision$ } = graph;
  const { fail$ } = core;
  const acceptPaint$ = command(
    (
      { get },
      revision: number,
      raster: Viewport,
      accept: ((raster: Viewport) => boolean) | undefined,
    ) => {
      return (
        get(acceptingFrames$) &&
        get(revision$) === revision &&
        (accept?.(raster) ?? true)
      );
    },
  );
  const framePainted$ = command(
    (
      { get },
      revision: number,
      raster: Viewport,
      painted: (raster: Viewport) => void,
    ) => {
      if (!get(acceptingFrames$) || get(revision$) !== revision) {
        return;
      }
      painted(raster);
    },
  );
  const frameFailed$ = command(
    async (
      { get, set },
      revision: number,
      error: unknown,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (get(acceptingFrames$) && get(revision$) === revision) {
        await set(fail$, error, signal);
      }
    },
  );
  const push$ = command(
    (
      { get, set },
      data: string,
      painted: (raster: Viewport) => void,
      accept: ((raster: Viewport) => boolean) | undefined,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (!get(acceptingFrames$)) {
        return;
      }
      const revision = get(revision$);
      owner.sink.push(
        data,
        (raster) => {
          if (!signal.aborted) {
            set(framePainted$, revision, raster, painted);
          }
        },
        (error) => {
          detach(
            set(frameFailed$, revision, error, signal),
            Reason.DomCallback,
            "browser raster event",
          );
        },
        (raster) => {
          return !signal.aborted && set(acceptPaint$, revision, raster, accept);
        },
      );
    },
  );

  return { push$ };
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
  const begin = createCaptureBegin(owner, graph, { ...lane, ...stop });
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
    suspend$: core.suspend$,
    ...cleanup,
    ...retry,
    ...stop,
    ...begin,
  };
}
