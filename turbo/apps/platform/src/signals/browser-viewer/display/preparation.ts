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

export interface DisplaySnapshot {
  readonly window: Protocol.Browser.GetWindowForTargetResponse;
  readonly native: NativeWindowGeometry;
  readonly remote: DisplaySize;
  readonly layout: Protocol.Page.GetLayoutMetricsResponse;
  readonly current: () => boolean;
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

/** Selected-owner acquisition; verified calibration outlives a preparation. */
export class DisplayPreparation {
  private calibration: Calibration = { kind: "unbound" };

  constructor(
    private readonly client: CdpClient,
    private readonly target: DisplayTarget,
    private readonly windowId: number | undefined,
    private readonly current: () => boolean,
    private readonly refreshNative: () => Promise<NativeCapture | null>,
  ) {}

  async acquire(
    signal: AbortSignal,
    budget: number | undefined,
  ): Promise<DisplaySnapshot | null> {
    const [completion1] = await Promise.allSettled([
      (async (): Promise<DisplaySnapshot | null> => {
        const [operation1] = await Promise.allSettled([
          (async (): Promise<DisplaySnapshot | null> => {
            return await this.acquireSnapshot(signal, budget);
          })(),
        ]);
        if (operation1.status === "fulfilled") {
          return operation1.value;
        }
        const error: unknown = operation1.reason;

        if (this.current() && this.calibration.kind === "captured") {
          this.calibration = {
            kind: "observed",
            window: this.calibration.window,
          };
        }
        throw error;
      })(),
    ]);
    if (completion1.status === "rejected") {
      throw completion1.reason;
    }
    return completion1.value;
  }

  private async acquireSnapshot(
    signal: AbortSignal,
    budget: number | undefined,
  ): Promise<DisplaySnapshot | null> {
    const { target } = this;
    if (this.calibration.kind === "unbound") {
      await target.geometry.waitForNativeFrame(signal, budget);
      if (!this.current()) {
        return null;
      }
      const window = await this.readWindow();
      if (!this.current()) {
        return null;
      }
      this.calibration = {
        kind: "observed",
        window: this.observeWindow(window),
      };
    }
    const observed = this.calibration;
    if (observed.kind === "observed") {
      const capture = await this.refreshNative();
      if (!capture || !this.current() || observed !== this.calibration) {
        return null;
      }
      this.calibration = { kind: "captured", window: observed.window, capture };
    }
    if (this.calibration.kind === "captured") {
      await target.geometry.waitForNativeFrame(signal, budget);
    }
    if (!this.current()) {
      return null;
    }
    const attempt = this.calibration;
    if (attempt.kind !== "captured" && attempt.kind !== "verified") {
      return null;
    }
    const snapshot = target.geometry.observeNative();
    const current = () => {
      return this.current() && snapshot.current();
    };
    const [native, metrics, layout] = await Promise.all([
      this.readCalibration(attempt, snapshot),
      this.readMetrics(),
      this.client.request("Page.getLayoutMetrics", undefined, target.sessionId),
    ]);
    if (!native || !current()) {
      return null;
    }
    const value: unknown = metrics.result.value;
    if (
      metrics.exceptionDetails ||
      !isRecord(value) ||
      !positive(value.width) ||
      !positive(value.height) ||
      !positive(value.dpr)
    ) {
      throw new CdpFault(
        "display",
        "The page display metrics are unavailable.",
      );
    }
    return {
      window: native.window,
      native: native.geometry,
      remote: { width: value.width, height: value.height, dpr: value.dpr },
      layout,
      current,
    };
  }

  private async readCalibration(
    attempt: Extract<Calibration, { kind: "captured" | "verified" }>,
    snapshot: NativeSnapshot,
  ) {
    const window = await this.readWindow();
    return this.confirmCalibration(attempt, window, snapshot);
  }

  /** The only installation point for a proved native frame/window association. */
  private confirmCalibration(
    attempt: Extract<Calibration, { kind: "captured" | "verified" }>,
    window: Protocol.Browser.GetWindowForTargetResponse,
    snapshot: NativeSnapshot,
  ) {
    if (!this.current() || attempt !== this.calibration) {
      return null;
    }
    const observed = this.observeWindow(window);
    if (
      attempt.kind === "captured"
        ? observed.windowId !== attempt.window.windowId ||
          observed.bounds.width !== attempt.window.bounds.width ||
          observed.bounds.height !== attempt.window.bounds.height
        : observed.windowId !== attempt.windowId
    ) {
      this.calibration = { kind: "observed", window: observed };
      return null;
    }
    if (!snapshot.current()) {
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
      this.calibration = { kind: "observed", window: observed };
      return null;
    }
    const verified = {
      kind: "verified",
      windowId: observed.windowId,
      geometry: nativeWindowGeometry(frame.device, window.bounds),
    } as const;
    this.calibration = verified;
    return { window, geometry: verified.geometry };
  }

  async confirm(
    windowId: number,
  ): Promise<Protocol.Browser.GetWindowForTargetResponse> {
    const window = await this.readWindow();
    if (this.current()) {
      this.observeWindow(window);
      if (window.windowId !== windowId) {
        throw new CdpFault(
          "scope",
          "The page moved during display synchronization.",
        );
      }
    }
    return window;
  }

  private readWindow() {
    return this.client.request("Browser.getWindowForTarget", {
      targetId: this.target.targetId,
    });
  }

  private async readMetrics() {
    const { client, target } = this;
    const release = (result: unknown) => {
      return releaseRuntimeObjects(client, target.sessionId, result);
    };
    const remote = await client.request(
      "Runtime.evaluate",
      {
        expression:
          "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})",
        returnByValue: true,
      },
      target.sessionId,
      release,
    );
    release(remote);
    return remote;
  }

  private observeWindow(
    window: Protocol.Browser.GetWindowForTargetResponse,
  ): ObservedWindow {
    if (
      !Number.isSafeInteger(window.windowId) ||
      (this.windowId !== undefined && window.windowId !== this.windowId)
    ) {
      throw new CdpFault("scope", "The page is outside this viewer's window.");
    }
    if (window.bounds.windowState && window.bounds.windowState !== "normal") {
      throw new CdpFault(
        "display",
        "Restore the browser window before synchronizing its display.",
      );
    }
    const { width, height } = window.bounds;
    if (!positive(width) || !positive(height)) {
      throw new CdpFault("display", "The browser window size is unavailable.");
    }
    return { windowId: window.windowId, bounds: { width, height } };
  }
}
