import { command, state, type Command, type Computed } from "ccstate";
import type { Protocol } from "devtools-protocol";
import type { CdpClient } from "../cdp/client.ts";
import { CdpFault, isRecord } from "../cdp/errors.ts";
import { releaseRuntimeObjects } from "../cdp/runtime-objects.ts";
import {
  nativeWindowGeometry,
  positive,
  type DisplaySize,
  type NativeWindowGeometry,
  type Viewport,
} from "./geometry.ts";
import type {
  DisplayViewport,
  NativeCapture,
  NativeSnapshot,
} from "./viewport.ts";

export interface DisplayTarget {
  readonly targetId: string;
  readonly sessionId: string;
  readonly current: () => boolean;
  readonly geometry: DisplayViewport;
}

/** Native observation proof, not an accessor-backed lifetime closure. */
export interface DisplaySnapshot {
  readonly window: Protocol.Browser.GetWindowForTargetResponse;
  readonly native: NativeWindowGeometry;
  readonly remote: DisplaySize;
  readonly layout: Protocol.Page.GetLayoutMetricsResponse;
  readonly nativeSnapshot: NativeSnapshot;
}

export interface DisplayPreparation {
  readonly acquire$: Command<Promise<DisplaySnapshot | null>, [AbortSignal]>;
  readonly confirm$: Command<
    Promise<Protocol.Browser.GetWindowForTargetResponse>,
    [number, AbortSignal]
  >;
  readonly currentSnapshot$: Command<boolean, [DisplaySnapshot]>;
}

interface ObservedWindow {
  readonly windowId: number;
  readonly bounds: Viewport;
}

type Calibration =
  | { readonly kind: "unbound" }
  | { readonly kind: "observed"; readonly window: ObservedWindow }
  | {
      readonly kind: "captured";
      readonly window: ObservedWindow;
      readonly capture: NativeCapture;
    }
  | {
      readonly kind: "verified";
      readonly windowId: number;
      readonly geometry: NativeWindowGeometry;
    };

type CalibrationAttempt = Extract<
  Calibration,
  { kind: "captured" | "verified" }
>;

interface CalibratedWindow {
  readonly window: Protocol.Browser.GetWindowForTargetResponse;
  readonly geometry: NativeWindowGeometry;
}

class WindowStateFault extends CdpFault {
  constructor(
    readonly windowId: number,
    readonly windowState: Exclude<Protocol.Browser.WindowState, "normal">,
  ) {
    super(
      "display",
      "The browser window changed state during display synchronization.",
    );
  }
}

function observeWindow(
  window: Protocol.Browser.GetWindowForTargetResponse,
  windowId: number | null,
): ObservedWindow {
  if (
    !Number.isSafeInteger(window.windowId) ||
    (windowId !== null && window.windowId !== windowId)
  ) {
    throw new CdpFault("scope", "The page is outside this viewer's window.");
  }
  const windowState: unknown = window.bounds.windowState;
  if (
    windowState === "minimized" ||
    windowState === "maximized" ||
    windowState === "fullscreen"
  ) {
    throw new WindowStateFault(window.windowId, windowState);
  }
  if (windowState !== undefined && windowState !== "normal") {
    throw new CdpFault(
      "display",
      "The browser window state is unavailable for display synchronization.",
    );
  }
  const { width, height } = window.bounds;
  if (!positive(width) || !positive(height)) {
    throw new CdpFault("display", "The browser window size is unavailable.");
  }
  return { windowId: window.windowId, bounds: { width, height } };
}

/** Native results always release runtime handles, including late replies. */
async function readMetrics(client: CdpClient, sessionId: string) {
  const release = (result: unknown) => {
    return releaseRuntimeObjects(client, sessionId, result);
  };
  const remote = await client.request(
    "Runtime.evaluate",
    {
      expression:
        "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})",
      returnByValue: true,
    },
    sessionId,
    release,
  );
  release(remote);
  return remote;
}

interface PreparationHost {
  readonly client: CdpClient;
  readonly target: DisplayTarget;
  readonly windowId: number | null;
  readonly current: () => boolean;
  readonly refreshNative$: Command<
    Promise<NativeCapture | null>,
    [AbortSignal]
  >;
  readonly ownsTarget$: Computed<boolean>;
}

function createPreparationState(context: PreparationHost) {
  const { current, ownsTarget$, target } = context;
  const calibration$ = state<Calibration>({ kind: "unbound" });

  // The native lifetime is deliberately not a computed: it may change outside
  // ccstate. Reactive selection ownership is always read inside a command.
  const current$ = command(({ get }) => {
    return current() && get(ownsTarget$);
  });

  const currentSnapshot$ = command(({ set }, snapshot: DisplaySnapshot) => {
    return (
      set(current$) &&
      set(target.geometry.nativeCurrent$, snapshot.nativeSnapshot)
    );
  });

  return { calibration$, current$, currentSnapshot$ };
}

type PreparationContext = PreparationHost &
  ReturnType<typeof createPreparationState>;

function createCalibrationConfirmation(context: PreparationContext) {
  const { calibration$, current$, target, windowId, client } = context;
  /** The only installation point for a proved native frame/window association. */
  const confirmCalibration$ = command(
    (
      { get, set },
      attempt: CalibrationAttempt,
      window: Protocol.Browser.GetWindowForTargetResponse,
      snapshot: NativeSnapshot,
      signal: AbortSignal,
    ): CalibratedWindow | null => {
      if (signal.aborted || !set(current$) || attempt !== get(calibration$)) {
        return null;
      }
      const observed = observeWindow(window, windowId);
      if (
        attempt.kind === "captured"
          ? observed.windowId !== attempt.window.windowId ||
            observed.bounds.width !== attempt.window.bounds.width ||
            observed.bounds.height !== attempt.window.bounds.height
          : observed.windowId !== attempt.windowId
      ) {
        set(calibration$, { kind: "observed", window: observed });
        return null;
      }
      if (!set(target.geometry.nativeCurrent$, snapshot)) {
        return null;
      }
      if (attempt.kind === "verified") {
        return { window, geometry: attempt.geometry };
      }
      const frame = snapshot.frame;
      if (!frame) {
        return null;
      }
      if (frame.capture !== attempt.capture) {
        set(calibration$, { kind: "observed", window: observed });
        return null;
      }
      const verified = {
        kind: "verified",
        windowId: observed.windowId,
        geometry: nativeWindowGeometry(frame.device, window.bounds),
      } as const;
      set(calibration$, verified);
      return { window, geometry: verified.geometry };
    },
  );

  const readCalibration$ = command(
    async (
      { set },
      attempt: CalibrationAttempt,
      snapshot: NativeSnapshot,
      signal: AbortSignal,
    ): Promise<CalibratedWindow | null> => {
      const window = await client.request("Browser.getWindowForTarget", {
        targetId: target.targetId,
      });
      signal.throwIfAborted();
      return set(confirmCalibration$, attempt, window, snapshot, signal);
    },
  );
  return { readCalibration$ };
}

function remoteDisplaySize(
  metrics: Protocol.Runtime.EvaluateResponse,
): DisplaySize {
  const value: unknown = metrics.result.value;
  if (
    metrics.exceptionDetails ||
    !isRecord(value) ||
    !positive(value.width) ||
    !positive(value.height) ||
    !positive(value.dpr)
  ) {
    throw new CdpFault("display", "The page display metrics are unavailable.");
  }
  return { width: value.width, height: value.height, dpr: value.dpr };
}

function isCalibrationAttempt(
  calibration: Calibration,
): calibration is CalibrationAttempt {
  return calibration.kind === "captured" || calibration.kind === "verified";
}

function createSnapshotAcquisition(
  context: PreparationContext &
    ReturnType<typeof createCalibrationConfirmation>,
) {
  const {
    calibration$,
    current$,
    target,
    refreshNative$,
    readCalibration$,
    client,
    windowId,
  } = context;
  const acquireSnapshot$ = command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<DisplaySnapshot | null> => {
      if (signal.aborted || !set(current$)) {
        return null;
      }
      if (get(calibration$).kind === "unbound") {
        const window = await client.request("Browser.getWindowForTarget", {
          targetId: target.targetId,
        });
        signal.throwIfAborted();
        if (!set(current$)) {
          return null;
        }
        // A minimized window may not emit a frame until its state is restored.
        const observed = observeWindow(window, windowId);
        await set(target.geometry.waitForNativeFrame$, signal);
        if (signal.aborted || !set(current$)) {
          return null;
        }
        set(calibration$, {
          kind: "observed",
          window: observed,
        });
      }
      const observed = get(calibration$);
      if (observed.kind === "observed") {
        const capture = await set(refreshNative$, signal);
        if (
          !capture ||
          signal.aborted ||
          !set(current$) ||
          observed !== get(calibration$)
        ) {
          return null;
        }
        set(calibration$, {
          kind: "captured",
          window: observed.window,
          capture,
        });
      }
      if (get(calibration$).kind === "captured") {
        await set(target.geometry.waitForNativeFrame$, signal);
      }
      if (signal.aborted || !set(current$)) {
        return null;
      }
      const attempt = get(calibration$);
      if (!isCalibrationAttempt(attempt)) {
        return null;
      }
      const nativeSnapshot = get(target.geometry.nativeSnapshot$);
      const [native, metrics, layout] = await Promise.all([
        set(readCalibration$, attempt, nativeSnapshot, signal),
        readMetrics(client, target.sessionId),
        client.request("Page.getLayoutMetrics", undefined, target.sessionId),
      ]);
      signal.throwIfAborted();
      if (
        !native ||
        signal.aborted ||
        !set(current$) ||
        !set(target.geometry.nativeCurrent$, nativeSnapshot)
      ) {
        return null;
      }
      const remote = remoteDisplaySize(metrics);
      return Object.freeze({
        window: native.window,
        native: native.geometry,
        remote: Object.freeze(remote),
        layout,
        nativeSnapshot,
      });
    },
  );
  return { acquireSnapshot$ };
}

/** Restore only during acquisition; a second failure belongs to normal recovery. */
function createSnapshotRecovery(
  context: PreparationContext & ReturnType<typeof createSnapshotAcquisition>,
) {
  const { acquireSnapshot$, calibration$, current$, client, target } = context;
  const acquirePrepared$ = command(
    async ({ set }, signal: AbortSignal): Promise<DisplaySnapshot | null> => {
      const [result] = await Promise.allSettled([
        set(acquireSnapshot$, signal),
      ]);
      signal.throwIfAborted();
      if (result.status === "fulfilled") {
        return result.value;
      }
      const error: unknown = result.reason;
      if (!(error instanceof WindowStateFault)) {
        throw error;
      }
      if (!set(current$)) {
        return null;
      }
      set(calibration$, { kind: "unbound" });
      set(target.geometry.uncertain$);
      await client.request(
        "Browser.setWindowBounds",
        { windowId: error.windowId, bounds: { windowState: "normal" } },
        undefined,
        undefined,
        signal,
      );
      signal.throwIfAborted();
      if (!set(current$)) {
        return null;
      }
      const window = await client.request(
        "Browser.getWindowForTarget",
        { targetId: target.targetId },
        undefined,
        undefined,
        signal,
      );
      signal.throwIfAborted();
      if (!set(current$)) {
        return null;
      }
      const observed = observeWindow(window, error.windowId);
      await client.request(
        "Emulation.clearDeviceMetricsOverride",
        undefined,
        target.sessionId,
        undefined,
        signal,
      );
      signal.throwIfAborted();
      if (!set(current$)) {
        return null;
      }
      set(calibration$, { kind: "observed", window: observed });
      // Reuse the fresh native capture fence; never reuse pre-restoration geometry.
      return set(acquireSnapshot$, signal);
    },
  );
  return { acquirePrepared$ };
}

function createPreparationCommands(
  context: PreparationContext & ReturnType<typeof createSnapshotRecovery>,
) {
  const { calibration$, current$, acquirePrepared$, client, target, windowId } =
    context;
  const acquire$ = command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<DisplaySnapshot | null> => {
      const [result] = await Promise.allSettled([
        set(acquirePrepared$, signal),
      ]);
      if (signal.aborted) {
        const calibration = get(calibration$);
        if (set(current$) && calibration.kind === "captured") {
          set(calibration$, { kind: "observed", window: calibration.window });
        }
        signal.throwIfAborted();
      }
      if (result.status === "fulfilled") {
        return result.value;
      }
      const calibration = get(calibration$);
      if (set(current$) && calibration.kind === "captured") {
        set(calibration$, { kind: "observed", window: calibration.window });
      }
      throw result.reason;
    },
  );

  const confirm$ = command(
    async (
      { set },
      expectedWindowId: number,
      signal: AbortSignal,
    ): Promise<Protocol.Browser.GetWindowForTargetResponse> => {
      const window = await client.request("Browser.getWindowForTarget", {
        targetId: target.targetId,
      });
      signal.throwIfAborted();
      if (set(current$)) {
        observeWindow(window, windowId);
        if (window.windowId !== expectedWindowId) {
          throw new CdpFault(
            "scope",
            "The page moved during display synchronization.",
          );
        }
      }
      return window;
    },
  );
  return { acquire$, confirm$ };
}

/** Selected-owner acquisition; verified calibration outlives one preparation. */
export function createDisplayPreparation(
  ...[client, target, windowId, current, refreshNative$, ownsTarget$]: [
    client: CdpClient,
    target: DisplayTarget,
    windowId: number | null,
    current: () => boolean,
    refreshNative$: Command<Promise<NativeCapture | null>, [AbortSignal]>,
    ownsTarget$: Computed<boolean>,
  ]
): DisplayPreparation {
  const host = {
    client,
    target,
    windowId,
    current,
    refreshNative$,
    ownsTarget$,
  };
  const context = { ...host, ...createPreparationState(host) };
  const confirmation = createCalibrationConfirmation(context);
  const acquisition = createSnapshotAcquisition({
    ...context,
    ...confirmation,
  });
  const recovery = createSnapshotRecovery({ ...context, ...acquisition });
  const commands = createPreparationCommands({ ...context, ...recovery });
  return { ...commands, currentSnapshot$: context.currentSnapshot$ };
}
