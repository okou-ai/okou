import { command, computed, state } from "ccstate";
import type { Protocol } from "devtools-protocol";
import {
  scheduleTimeout,
  createDeferredPromise,
  type DeferredPromise,
} from "../../utils.ts";
import { CdpFault, isRecord } from "../cdp/errors.ts";
import { frameTimeoutMs, maximumFrameDimension } from "./limits.ts";
import {
  frameViewport,
  captureRaster,
  inputTransform,
  createInputGeometry,
  positive,
  type InputGeometry,
  type DisplayTransform,
  type PresentationGeometry,
  type Viewport,
} from "./geometry.ts";

interface FrameGeometry {
  readonly viewport: Viewport | null;
  readonly device: Viewport | null;
  readonly raster: Viewport;
}

interface NativeObservation {
  readonly device: Viewport | null;
}

/** Local capture association; timestamps alone do not identify a window. */
export interface NativeCapture {
  readonly timestamp: number;
}

interface NativeFrame {
  readonly device: Viewport;
  readonly capture: NativeCapture;
}

/** Observation proof, checked by nativeCurrent$ rather than a captured accessor. */
export interface NativeSnapshot {
  readonly frame: NativeFrame | null;
  readonly revision: number;
  readonly observation: NativeObservation;
}

type NativeState =
  | { readonly kind: "pending"; readonly observation: NativeObservation }
  | {
      readonly kind: "accepted";
      readonly observation: NativeObservation;
      readonly frame: NativeFrame;
    };

export interface PresentationReceipt {
  readonly transform: DisplayTransform | null;
  readonly expected: PresentationGeometry;
}

type Presentation = "presented" | "inconsistent";

type FrameWait =
  | { readonly kind: "native"; readonly capture: NativeCapture }
  | {
      readonly kind: "presentation";
      readonly receipt: PresentationReceipt | null;
      readonly recoverInconsistent: boolean;
    };

/** Only protocol event bridges are deferred; no operation Promise is cached. */
interface FrameWaiter {
  readonly request: FrameWait;
  readonly completion: DeferredPromise<Presentation>;
}

type Adaptation =
  | { readonly kind: "native"; readonly scale: number }
  | { readonly kind: "writing"; readonly write: object }
  | { readonly kind: "uncertain" }
  | {
      readonly kind: "presenting" | "presented";
      readonly scale: number;
      readonly receipt: PresentationReceipt;
    };

/** A definite native rejection may restore precisely these pre-write facts. */
export interface WriteRollback {
  readonly write: object;
  readonly revision: number;
  readonly adaptation: Adaptation;
  readonly painted: FrameGeometry | null;
  readonly transform: DisplayTransform | null;
}

/** Immutable decode ticket; native sink callbacks invoke stable graph commands. */
export interface FrameReceipt {
  readonly revision: number;
  readonly viewport: Viewport | null;
  readonly device: Viewport | null;
  readonly capture: NativeCapture;
  readonly observation: NativeObservation | null;
}

function same(actual: Viewport, wanted: Viewport): boolean {
  return (
    Math.abs(actual.width - wanted.width) <= 1 &&
    Math.abs(actual.height - wanted.height) <= 1
  );
}

function presentationTimeout(): CdpFault {
  return new CdpFault(
    "display",
    "The synchronized image did not arrive. Try synchronizing again.",
  );
}

function cancelled(): DOMException {
  return new DOMException(
    "Display synchronization was cancelled.",
    "AbortError",
  );
}

function compatible(
  frame: FrameGeometry,
  expected: PresentationGeometry,
  capture: Viewport,
): boolean {
  // Allow native DIP rounding, then validate pixels against the frame's actual
  // metadata and native density. Projected rounding cannot excuse a stale image.
  return (
    !!frame.viewport &&
    !!frame.device &&
    same(frame.device, expected.device) &&
    same(frame.raster, captureRaster(frame.device, expected.nativeDpr, capture))
  );
}

function inconsistent(
  adaptation: Adaptation,
  decoded: FrameGeometry | null,
  capture: Viewport,
): boolean {
  return (
    adaptation.kind === "presenting" &&
    !!decoded?.viewport &&
    !!decoded.device &&
    same(decoded.device, adaptation.receipt.expected.device) &&
    !compatible(decoded, adaptation.receipt.expected, capture)
  );
}

function createViewportState() {
  const revisionState$ = state(0);
  const timestamp$ = state(-Infinity);
  const captureAfter$ = state(-Infinity);
  const presentationSuspended$ = state(false);
  const nativeCapture$ = state<NativeCapture>({ timestamp: -Infinity });
  const painted$ = state<FrameGeometry | null>(null);
  const decoded$ = state<FrameGeometry | null>(null);
  const native$ = state<NativeState>({
    kind: "pending",
    observation: { device: null },
  });
  const adaptation$ = state<Adaptation>({ kind: "native", scale: 1 });
  const transform$ = state<DisplayTransform | null>(null);
  const waiters$ = state<ReadonlySet<FrameWaiter>>(new Set());
  const capture$ = state<Viewport>({
    width: maximumFrameDimension,
    height: maximumFrameDimension,
  });
  return {
    revisionState$,
    timestamp$,
    captureAfter$,
    presentationSuspended$,
    nativeCapture$,
    painted$,
    decoded$,
    native$,
    adaptation$,
    transform$,
    waiters$,
    capture$,
  };
}

type ViewportState = ReturnType<typeof createViewportState>;

function createViewportSelectors(context: ViewportState) {
  const { revisionState$, adaptation$, painted$, transform$, native$ } =
    context;
  const revision$ = computed((get) => {
    return get(revisionState$);
  });
  const available$ = computed((get) => {
    const adaptation = get(adaptation$);
    return adaptation.kind === "native" || adaptation.kind === "presented";
  });
  const input$ = computed((get): InputGeometry | null => {
    const painted = get(painted$);
    const transform = get(transform$);
    if (!get(available$) || !painted?.viewport || !transform) {
      return null;
    }
    return createInputGeometry(
      get(revisionState$),
      {
        width: painted.viewport.width * transform.frameScale,
        height: painted.viewport.height * transform.frameScale,
      },
      transform.wheelScale,
    );
  });
  const nativeSnapshot$ = computed((get): NativeSnapshot => {
    const native = get(native$);
    return {
      frame: native.kind === "accepted" ? native.frame : null,
      revision: get(revisionState$),
      observation: native.observation,
    };
  });

  const nativeCurrent$ = command(({ get }, snapshot: NativeSnapshot) => {
    return (
      snapshot.revision === get(revisionState$) &&
      snapshot.observation === get(native$).observation
    );
  });
  return { revision$, available$, input$, nativeSnapshot$, nativeCurrent$ };
}

function createViewportNotifications(context: ViewportState) {
  const {
    adaptation$,
    painted$,
    native$,
    capture$,
    waiters$,
    presentationSuspended$,
    decoded$,
  } = context;
  const notifyWaiters$ = command(({ get }) => {
    const adaptation = get(adaptation$);
    const painted = get(painted$);
    const native = get(native$);
    const capture = get(capture$);
    for (const { request, completion } of get(waiters$)) {
      if (completion.settled()) {
        continue;
      }
      if (get(presentationSuspended$)) {
        completion.reject(cancelled());
      } else if (request.kind === "native") {
        if (
          native.kind === "accepted" &&
          native.frame.capture === request.capture
        ) {
          completion.resolve("presented");
        }
      } else {
        const receipt =
          adaptation.kind === "presenting" || adaptation.kind === "presented"
            ? adaptation.receipt
            : null;
        if (request.receipt !== receipt) {
          completion.reject(cancelled());
        } else if (
          painted &&
          (adaptation.kind === "native" ||
            (adaptation.kind === "presented" &&
              compatible(painted, adaptation.receipt.expected, capture)))
        ) {
          completion.resolve("presented");
        } else if (
          request.recoverInconsistent &&
          inconsistent(adaptation, get(decoded$), capture)
        ) {
          completion.resolve("inconsistent");
        }
      }
    }
  });

  const present$ = command(({ get, set }) => {
    const adaptation = get(adaptation$);
    const painted = get(painted$);
    if (
      !get(presentationSuspended$) &&
      adaptation.kind === "presenting" &&
      painted &&
      compatible(painted, adaptation.receipt.expected, get(capture$))
    ) {
      set(adaptation$, { ...adaptation, kind: "presented" });
    }
    set(notifyWaiters$);
  });

  const retireNative$ = command(({ get, set }) => {
    set(native$, {
      kind: "pending",
      observation: { device: get(native$).observation.device },
    });
  });
  return { notifyWaiters$, present$, retireNative$ };
}

type ViewportNotifications = ReturnType<typeof createViewportNotifications>;

function createViewportMatching(context: ViewportState) {
  const { capture$, painted$, transform$, adaptation$ } = context;
  const setCapture$ = command(({ set }, bounds: Viewport) => {
    set(capture$, { width: bounds.width, height: bounds.height });
  });

  const matches$ = command(
    ({ get }, expected: PresentationGeometry, transform: DisplayTransform) => {
      const painted = get(painted$);
      const actual = get(transform$);
      const close = (left: number, right: number) => {
        return Math.abs(left - right) <= Math.abs(right) * 1e-6;
      };
      return (
        get(adaptation$).kind === "presented" &&
        !!painted &&
        compatible(painted, expected, get(capture$)) &&
        !!actual &&
        close(actual.viewportScale, transform.viewportScale) &&
        close(actual.frameScale, transform.frameScale) &&
        close(actual.wheelScale, transform.wheelScale)
      );
    },
  );

  const captureFence$ = command(
    (
      { get },
      layout: Protocol.Page.GetLayoutMetricsResponse,
      transform: DisplayTransform,
    ): ((expected: PresentationGeometry) => boolean) => {
      const adaptation = get(adaptation$);
      if (adaptation.kind !== "native" && adaptation.kind !== "presented") {
        return () => {
          return true;
        };
      }
      const viewport = layout.cssVisualViewport;
      const scale = (viewport.zoom ?? 1) * (viewport.scale ?? 1);
      const device = (viewportScale: number) => {
        return {
          width: viewport.clientWidth * scale * viewportScale,
          height: viewport.clientHeight * scale * viewportScale,
        };
      };
      const previous = device(adaptation.scale);
      const projected = device(transform.viewportScale);
      const painted = get(painted$)?.device;
      const capture = get(capture$);
      // The returned predicate captures immutable geometry, never ccstate accessors.
      return (expected) => {
        return (
          same(previous, expected.device) ||
          same(projected, expected.device) ||
          (!!painted && same(painted, expected.device)) ||
          same(
            captureRaster(previous, expected.nativeDpr, capture),
            captureRaster(expected.device, expected.nativeDpr, capture),
          )
        );
      };
    },
  );
  return { setCapture$, matches$, captureFence$ };
}

function createViewportInvalidation(
  context: ViewportState & ViewportNotifications,
) {
  const {
    captureAfter$,
    revisionState$,
    painted$,
    decoded$,
    nativeCapture$,
    transform$,
    adaptation$,
    retireNative$,
  } = context;
  const fence$ = command(({ set }, timestamp: number) => {
    set(captureAfter$, timestamp);
    set(revisionState$, (revision) => {
      return revision + 1;
    });
    set(painted$, null);
    set(decoded$, null);
    set(retireNative$);
  });

  const fenceNative$ = command(({ set }, timestamp: number): NativeCapture => {
    const capture = { timestamp };
    set(nativeCapture$, capture);
    set(retireNative$);
    return capture;
  });

  const invalidate$ = command(({ get, set }) => {
    set(revisionState$, (revision) => {
      return revision + 1;
    });
    set(painted$, null);
    set(decoded$, null);
    set(retireNative$);
    set(transform$, null);
    const adaptation = get(adaptation$);
    // A pending transaction retains its presentation barrier across resize.
    if (adaptation.kind === "presented") {
      set(adaptation$, { kind: "native", scale: adaptation.scale });
    }
  });

  const event$ = command(({ set }, method: string) => {
    if (method === "Page.frameResized") {
      set(invalidate$);
    }
  });
  return { fence$, fenceNative$, invalidate$, event$ };
}

type ViewportInvalidation = ReturnType<typeof createViewportInvalidation>;

function createViewportWrites(
  context: ViewportState & ViewportNotifications & ViewportInvalidation,
) {
  const {
    transform$,
    adaptation$,
    captureAfter$,
    painted$,
    revisionState$,
    fence$,
    present$,
    invalidate$,
  } = context;
  const apply$ = command(
    ({ set }, receipt: PresentationReceipt, freshCapture = false) => {
      // Decode may precede native acknowledgement; only this projection grants input.
      set(transform$, receipt.transform);
      set(adaptation$, {
        kind: "presenting",
        scale: receipt.transform?.viewportScale ?? 1,
        receipt,
      });
      if (freshCapture) {
        set(fence$, Infinity);
      }
      set(present$);
    },
  );

  const uncertain$ = command(({ set }) => {
    set(adaptation$, { kind: "uncertain" });
    set(captureAfter$, -Infinity);
    set(invalidate$);
  });

  const beginWrite$ = command(({ get, set }): WriteRollback => {
    const adaptation = get(adaptation$);
    const painted = get(painted$);
    const transform = get(transform$);
    const write = {};
    set(adaptation$, { kind: "writing", write });
    set(invalidate$);
    return {
      write,
      revision: get(revisionState$),
      adaptation,
      painted,
      transform,
    };
  });

  const rejectWrite$ = command(({ get, set }, rollback: WriteRollback) => {
    const adaptation = get(adaptation$);
    if (adaptation.kind !== "writing" || adaptation.write !== rollback.write) {
      // A late rejection must not invalidate a newer projection or selection.
      return;
    }
    if (rollback.revision !== get(revisionState$)) {
      set(uncertain$);
      return;
    }
    set(revisionState$, (revision) => {
      return revision + 1;
    });
    if (!get(painted$)) {
      set(painted$, rollback.painted);
    }
    set(transform$, rollback.transform);
    set(
      adaptation$,
      rollback.adaptation.kind === "presented"
        ? { ...rollback.adaptation, kind: "presenting" }
        : rollback.adaptation,
    );
    set(present$);
  });
  return { apply$, uncertain$, beginWrite$, rejectWrite$ };
}

function createViewportWaits(context: ViewportState & ViewportNotifications) {
  const {
    presentationSuspended$,
    waiters$,
    adaptation$,
    nativeCapture$,
    notifyWaiters$,
  } = context;
  const waitForFrame$ = command(
    async (
      { get, set },
      request: FrameWait,
      budget: number,
      signal: AbortSignal,
    ): Promise<Presentation> => {
      signal.throwIfAborted();
      if (get(presentationSuspended$)) {
        throw cancelled();
      }
      if (budget <= 0) {
        throw presentationTimeout();
      }
      const completion = createDeferredPromise<Presentation>(signal);
      const waiter: FrameWaiter = { request, completion };
      set(waiters$, new Set([...get(waiters$), waiter]));
      set(notifyWaiters$);
      const cancelDeadline = scheduleTimeout(
        () => {
          if (!completion.settled()) {
            completion.reject(presentationTimeout());
          }
        },
        budget,
        signal,
      );
      const [result] = await Promise.allSettled([completion.promise]);
      if (signal.aborted) {
        cancelDeadline();
        const remaining = new Set(get(waiters$));
        remaining.delete(waiter);
        set(waiters$, remaining);
        signal.throwIfAborted();
      }
      cancelDeadline();
      const remaining = new Set(get(waiters$));
      remaining.delete(waiter);
      set(waiters$, remaining);
      if (result.status === "rejected") {
        throw result.reason;
      }
      return result.value;
    },
  );

  const waitForPresentation$ = command(
    (
      { get, set },
      budget: number | undefined,
      recoverInconsistent: boolean,
      signal: AbortSignal,
    ): Promise<Presentation> => {
      const adaptation = get(adaptation$);
      return set(
        waitForFrame$,
        {
          kind: "presentation",
          receipt:
            adaptation.kind === "presenting" || adaptation.kind === "presented"
              ? adaptation.receipt
              : null,
          recoverInconsistent,
        },
        budget ?? frameTimeoutMs,
        signal,
      );
    },
  );

  const waitForNativeFrame$ = command(
    (
      { get, set },
      budget: number | undefined,
      signal: AbortSignal,
    ): Promise<Presentation> => {
      return set(
        waitForFrame$,
        { kind: "native", capture: get(nativeCapture$) },
        budget ?? frameTimeoutMs,
        signal,
      );
    },
  );
  return { waitForPresentation$, waitForNativeFrame$ };
}

function createViewportPresentationLifecycle(
  context: ViewportState & ViewportInvalidation,
) {
  const { waiters$, presentationSuspended$, invalidate$ } = context;
  const cancelPresentation$ = command(({ get }) => {
    for (const waiter of get(waiters$)) {
      if (!waiter.completion.settled()) {
        waiter.completion.reject(cancelled());
      }
    }
  });

  const suspendPresentation$ = command(({ get, set }) => {
    if (!get(presentationSuspended$)) {
      set(presentationSuspended$, true);
      // A decode ticket admitted before hiding cannot paint after resuming.
      set(invalidate$);
    }
    set(cancelPresentation$);
  });

  const resumePresentation$ = command(({ set }) => {
    set(presentationSuspended$, false);
  });
  return { cancelPresentation$, suspendPresentation$, resumePresentation$ };
}

function createViewportInput(
  context: ViewportState & ReturnType<typeof createViewportSelectors>,
) {
  const { revisionState$, adaptation$, transform$, input$ } = context;
  const read$ = command(
    (
      { get, set },
      layout: Protocol.Page.GetLayoutMetricsResponse,
      revision: number,
    ): InputGeometry | null => {
      if (revision !== get(revisionState$)) {
        return null;
      }
      const adaptation = get(adaptation$);
      if (adaptation.kind !== "native" && adaptation.kind !== "presented") {
        return null;
      }
      const viewport = layout.cssVisualViewport;
      if (!positive(viewport.clientWidth) || !positive(viewport.clientHeight)) {
        throw new CdpFault(
          "input",
          "The remote viewport is unavailable for input.",
        );
      }
      const transform =
        get(transform$) ?? inputTransform(viewport.zoom ?? 1, adaptation.scale);
      set(transform$, transform);
      return (
        get(input$) ??
        createInputGeometry(
          get(revisionState$),
          {
            width: viewport.clientWidth * adaptation.scale,
            height: viewport.clientHeight * adaptation.scale,
          },
          transform.wheelScale,
        )
      );
    },
  );
  return { read$ };
}

function frameDevice(metadata: unknown): Viewport | null {
  return isRecord(metadata) &&
    positive(metadata.deviceWidth) &&
    positive(metadata.deviceHeight)
    ? { width: metadata.deviceWidth, height: metadata.deviceHeight }
    : null;
}

function captureIncludes(capture: NativeCapture, timestamp: unknown): boolean {
  return (
    capture.timestamp === -Infinity ||
    (typeof timestamp === "number" &&
      Number.isFinite(timestamp) &&
      timestamp >= capture.timestamp)
  );
}

function createViewportFrameAdmission(context: ViewportState) {
  const {
    presentationSuspended$,
    captureAfter$,
    timestamp$,
    nativeCapture$,
    native$,
    revisionState$,
  } = context;
  const frame$ = command(
    ({ get, set }, metadata: unknown): FrameReceipt | null => {
      if (get(presentationSuspended$)) {
        return null;
      }
      const timestamp = isRecord(metadata) ? metadata.timestamp : null;
      const captureAfter = get(captureAfter$);
      if (
        captureAfter !== -Infinity &&
        (typeof timestamp !== "number" ||
          !Number.isFinite(timestamp) ||
          timestamp < captureAfter)
      ) {
        return null;
      }
      if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
        if (timestamp < get(timestamp$)) {
          return null;
        }
        set(timestamp$, timestamp);
      }
      const viewport = frameViewport(metadata);
      const device = frameDevice(metadata);
      const capture = get(nativeCapture$);
      const nativeCurrent = captureIncludes(capture, timestamp);
      if (
        nativeCurrent &&
        (device?.width !== get(native$).observation.device?.width ||
          device?.height !== get(native$).observation.device?.height)
      ) {
        set(native$, { kind: "pending", observation: { device } });
      }
      return {
        revision: get(revisionState$),
        viewport,
        device,
        capture,
        observation: nativeCurrent ? get(native$).observation : null,
      };
    },
  );
  return { frame$ };
}

function createViewportFramePainting(
  context: ViewportState & ViewportNotifications,
) {
  const {
    revisionState$,
    presentationSuspended$,
    native$,
    decoded$,
    adaptation$,
    capture$,
    painted$,
    notifyWaiters$,
    present$,
  } = context;
  const acceptFrame$ = command(
    ({ get, set }, receipt: FrameReceipt, raster: Viewport): boolean => {
      if (
        receipt.revision !== get(revisionState$) ||
        get(presentationSuspended$)
      ) {
        return false;
      }
      const native = get(native$);
      if (
        receipt.device &&
        receipt.observation &&
        receipt.observation === native.observation &&
        native.kind === "pending"
      ) {
        set(native$, {
          kind: "accepted",
          observation: receipt.observation,
          frame: { device: receipt.device, capture: receipt.capture },
        });
      }
      const decoded = {
        viewport: receipt.viewport,
        device: receipt.device,
        raster,
      };
      set(decoded$, decoded);
      const adaptation = get(adaptation$);
      const accepted =
        (adaptation.kind !== "presenting" && adaptation.kind !== "presented") ||
        compatible(decoded, adaptation.receipt.expected, get(capture$));
      set(notifyWaiters$);
      return accepted;
    },
  );

  const paintFrame$ = command(
    ({ set }, receipt: FrameReceipt, raster: Viewport) => {
      if (!set(acceptFrame$, receipt, raster)) {
        return;
      }
      set(painted$, {
        viewport: receipt.viewport,
        device: receipt.device,
        raster,
      });
      set(present$);
    },
  );
  return { acceptFrame$, paintFrame$ };
}

/** One selected session's acknowledged adaptation, calibration and painted facts. */
export function createDisplayViewport() {
  const nodes = createViewportState();
  const selectors = createViewportSelectors(nodes);
  const notifications = createViewportNotifications(nodes);
  const invalidation = createViewportInvalidation({
    ...nodes,
    ...notifications,
  });
  return {
    ...selectors,
    ...createViewportMatching(nodes),
    ...invalidation,
    ...createViewportWrites({ ...nodes, ...notifications, ...invalidation }),
    ...createViewportWaits({ ...nodes, ...notifications }),
    ...createViewportPresentationLifecycle({ ...nodes, ...invalidation }),
    ...createViewportInput({ ...nodes, ...selectors }),
    ...createViewportFrameAdmission(nodes),
    ...createViewportFramePainting({ ...nodes, ...notifications }),
  };
}

export type DisplayViewport = ReturnType<typeof createDisplayViewport>;
