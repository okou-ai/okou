import { createStore } from "ccstate";
import { timeout } from "signal-timers";
import { resetSignal, createDeferredPromise } from "../../utils.ts";

import type { Protocol } from "devtools-protocol";
import { CdpFault, isRecord } from "../cdp/errors.ts";
import { frameTimeoutMs, maximumFrameDimension } from "./limits.ts";
import {
  frameViewport,
  captureRaster,
  inputTransform,
  InputGeometry,
  positive,
  type DisplayTransform,
  type PresentationGeometry,
  type Viewport,
} from "./geometry.ts";

const resetPresentationWait$ = resetSignal();

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

export interface NativeSnapshot {
  readonly frame: NativeFrame | null;
  readonly current: () => boolean;
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
  | { readonly kind: "native" }
  | { readonly kind: "presentation"; readonly recoverInconsistent: boolean };

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

type Adaptation =
  | { readonly kind: "native"; readonly scale: number }
  | { readonly kind: "writing" | "uncertain" }
  | {
      readonly kind: "presenting" | "presented";
      readonly scale: number;
      readonly receipt: PresentationReceipt;
    };

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

/** One selected session's acknowledged adaptation, calibration and painted facts. */
export class DisplayViewport {
  private readonly store = createStore();
  private version = 0;
  private timestamp = -Infinity;
  private captureAfter = -Infinity;
  private presentationSuspended = false;
  private nativeCapture: NativeCapture = { timestamp: -Infinity };
  private painted: FrameGeometry | null = null;
  private decoded: FrameGeometry | null = null;
  private native: NativeState = {
    kind: "pending",
    observation: { device: null },
  };
  private adaptation: Adaptation = { kind: "native", scale: 1 };
  private transform: DisplayTransform | null = null;
  private waiting: {
    finish: (result: Presentation | CdpFault) => void;
    request: FrameWait;
  } | null = null;
  private capture: Viewport = {
    width: maximumFrameDimension,
    height: maximumFrameDimension,
  };

  setCapture(bounds: Viewport): void {
    this.capture = bounds;
  }

  get revision(): number {
    return this.version;
  }

  /** One observation/revision proof, independent of painted input authority. */
  observeNative(): NativeSnapshot {
    const { observation } = this.native;
    const revision = this.version;
    return {
      frame: this.native.kind === "accepted" ? this.native.frame : null,
      current: () => {
        return (
          revision === this.version && observation === this.native.observation
        );
      },
    };
  }

  get available(): boolean {
    return (
      this.adaptation.kind === "native" || this.adaptation.kind === "presented"
    );
  }

  get input(): InputGeometry | null {
    if (!this.available || !this.painted?.viewport || !this.transform) {
      return null;
    }
    return new InputGeometry(
      this.version,
      {
        width: this.painted.viewport.width * this.transform.frameScale,
        height: this.painted.viewport.height * this.transform.frameScale,
      },
      this.transform.wheelScale,
    );
  }

  matches(
    expected: PresentationGeometry,
    transform: DisplayTransform,
  ): boolean {
    const close = (left: number, right: number) => {
      return Math.abs(left - right) <= Math.abs(right) * 1e-6;
    };
    return (
      this.adaptation.kind === "presented" &&
      !!this.painted &&
      compatible(this.painted, expected, this.capture) &&
      !!this.transform &&
      close(this.transform.viewportScale, transform.viewportScale) &&
      close(this.transform.frameScale, transform.frameScale) &&
      close(this.transform.wheelScale, transform.wheelScale)
    );
  }

  captureFence(
    layout: Protocol.Page.GetLayoutMetricsResponse,
    transform: DisplayTransform,
  ): (expected: PresentationGeometry) => boolean {
    const state = this.adaptation;
    if (state.kind !== "native" && state.kind !== "presented") {
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
    const previous = device(state.scale);
    const projected = device(transform.viewportScale);
    const painted = this.painted?.device;
    const capture = this.capture;
    // Preserve pre-write facts until acknowledged native bounds are known.
    return (expected) => {
      return (
        same(previous, expected.device) ||
        // An unchanged logical viewport can need a fresh static image even when
        // its native extent changes under the projected density.
        same(projected, expected.device) ||
        (!!painted && same(painted, expected.device)) ||
        // A capture ceiling can collapse distinct native sizes to the same image
        // dimensions. Raster compatibility alone cannot prove those pixels fresh.
        same(
          captureRaster(previous, expected.nativeDpr, capture),
          captureRaster(expected.device, expected.nativeDpr, capture),
        )
      );
    };
  }

  fence(timestamp: number): void {
    this.captureAfter = timestamp;
    this.version++;
    this.painted = null;
    this.decoded = null;
    this.retireNative();
  }

  /** Rebinding needs causal native facts without replacing painted input authority. */
  fenceNative(timestamp: number): NativeCapture {
    this.nativeCapture = { timestamp };
    this.retireNative();
    return this.nativeCapture;
  }

  private retireNative(): void {
    this.native = {
      kind: "pending",
      observation: { device: this.native.observation.device },
    };
  }

  invalidate(): void {
    this.version++;
    this.painted = null;
    this.decoded = null;
    this.retireNative();
    this.transform = null;
    // External resize/navigation recalibrates native units. A transaction still
    // awaiting its image keeps the presentation barrier across invalidation.
    if (this.adaptation.kind === "presented") {
      this.adaptation = { kind: "native", scale: this.adaptation.scale };
    }
  }

  event(method: string): void {
    if (method === "Page.frameResized") {
      this.invalidate();
    }
  }

  apply(receipt: PresentationReceipt, freshCapture = false): void {
    // Frames can paint before the final native acknowledgement. Retain their facts,
    // but only the acknowledged projection can authorize their input mapping.
    this.transform = receipt.transform;
    this.adaptation = {
      kind: "presenting",
      scale: receipt.transform?.viewportScale ?? 1,
      receipt,
    };
    if (freshCapture) {
      this.fence(Infinity);
    }
    this.present();
  }

  /** A write may have taken effect without a confirming reply. */
  uncertain(): void {
    this.adaptation = { kind: "uncertain" };
    this.captureAfter = -Infinity;
    this.invalidate();
  }

  /** Only a definite rejection can restore calibration from before a write. */
  beginWrite(): () => void {
    const previous = this.adaptation;
    const painted = this.painted;
    const transform = this.transform;
    this.adaptation = { kind: "writing" };
    this.invalidate();
    const revision = this.version;
    return () => {
      if (revision !== this.version) {
        this.uncertain();
        return;
      }
      this.version++;
      this.painted ??= painted;
      this.transform = transform;
      this.adaptation =
        previous.kind === "presented"
          ? { ...previous, kind: "presenting" }
          : previous;
      this.present();
    };
  }

  private present(): void {
    const state = this.adaptation;
    if (
      state.kind !== "presenting" ||
      !this.painted ||
      !compatible(this.painted, state.receipt.expected, this.capture)
    ) {
      return;
    }
    this.adaptation = { ...state, kind: "presented" };
    this.waiting?.finish("presented");
  }

  private inconsistent(): boolean {
    const state = this.adaptation;
    return (
      state.kind === "presenting" &&
      !!this.decoded?.viewport &&
      !!this.decoded.device &&
      same(this.decoded.device, state.receipt.expected.device) &&
      !compatible(this.decoded, state.receipt.expected, this.capture)
    );
  }

  /** The same bounded stream budget applies when a resize stops producing images. */
  waitForPresentation(
    signal: AbortSignal,
    budget = frameTimeoutMs,
    recoverInconsistent = false,
  ): Promise<Presentation> {
    return this.waitForFrame(signal, budget, {
      kind: "presentation",
      recoverInconsistent,
    });
  }

  /** An initial layout can already be emulated; only a selected frame is native. */
  waitForNativeFrame(
    signal: AbortSignal,
    budget = frameTimeoutMs,
  ): Promise<Presentation> {
    return this.waitForFrame(signal, budget, { kind: "native" });
  }

  private waitForFrame(
    signal: AbortSignal,
    budget: number,
    request: FrameWait,
  ): Promise<Presentation> {
    if (this.presentationSuspended) {
      return Promise.reject(
        new CdpFault("display", "Display synchronization was cancelled."),
      );
    }
    if (budget <= 0) {
      return Promise.reject(presentationTimeout());
    }
    if (
      request.kind === "native"
        ? this.native.kind === "accepted"
        : this.available
    ) {
      return Promise.resolve("presented");
    }
    if (
      request.kind === "presentation" &&
      request.recoverInconsistent &&
      this.inconsistent()
    ) {
      return Promise.resolve("inconsistent");
    }
    const deferred = createDeferredPromise<Presentation>(signal);
    const deadline = this.store.set(resetPresentationWait$, signal);
    const aborted = () => {
      return finish(
        new CdpFault("display", "Display synchronization was cancelled."),
      );
    };
    const finish = (result: Presentation | CdpFault) => {
      if (!deadline.aborted) {
        this.store.set(resetPresentationWait$);
      }
      signal.removeEventListener("abort", aborted);
      this.waiting = null;
      if (!deferred.settled()) {
        if (result instanceof CdpFault) {
          deferred.reject(result);
        } else {
          deferred.resolve(result);
        }
      }
    };
    this.waiting = { finish, request };
    if (signal.aborted) {
      aborted();
    } else {
      signal.addEventListener("abort", aborted, { once: true });
      timeout(
        () => {
          return finish(presentationTimeout());
        },
        budget,
        { signal: deadline },
      );
    }
    return deferred.promise;
  }

  cancelPresentation(): void {
    this.waiting?.finish(
      new CdpFault("display", "Display synchronization was cancelled."),
    );
  }

  /** A halted image cannot satisfy current or subsequently registered display waiters. */
  suspendPresentation(): void {
    this.presentationSuspended = true;
    this.cancelPresentation();
  }

  /** A validated new capture may establish fresh presentation facts again. */
  resumePresentation(): void {
    this.presentationSuspended = false;
  }

  read(
    layout: Protocol.Page.GetLayoutMetricsResponse,
    revision: number,
  ): InputGeometry | null {
    if (revision !== this.version) {
      return null;
    }
    const state = this.adaptation;
    if (state.kind !== "native" && state.kind !== "presented") {
      return null;
    }
    const viewport = layout.cssVisualViewport;
    if (!positive(viewport.clientWidth) || !positive(viewport.clientHeight)) {
      throw new CdpFault(
        "input",
        "The remote viewport is unavailable for input.",
      );
    }
    this.transform ??= inputTransform(viewport.zoom ?? 1, state.scale);
    return (
      this.input ??
      new InputGeometry(
        this.version,
        {
          width: viewport.clientWidth * state.scale,
          height: viewport.clientHeight * state.scale,
        },
        this.transform.wheelScale,
      )
    );
  }

  private frameTimestamp(metadata: unknown): { timestamp: unknown } | null {
    const timestamp = isRecord(metadata) ? metadata.timestamp : null;
    if (
      this.captureAfter !== -Infinity &&
      (typeof timestamp !== "number" ||
        !Number.isFinite(timestamp) ||
        timestamp < this.captureAfter)
    ) {
      return null;
    }
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      if (timestamp < this.timestamp) {
        return null;
      }
      this.timestamp = timestamp;
    }
    return { timestamp };
  }

  /** Null rejects an older capture; geometry is committed only after this image paints. */
  frame(metadata: unknown): {
    accept: (raster: Viewport) => boolean;
    painted: (raster: Viewport) => void;
  } | null {
    const stamp = this.frameTimestamp(metadata);
    if (!stamp) {
      return null;
    }
    const { timestamp } = stamp;
    const viewport = frameViewport(metadata);
    const device =
      isRecord(metadata) &&
      positive(metadata.deviceWidth) &&
      positive(metadata.deviceHeight)
        ? { width: metadata.deviceWidth, height: metadata.deviceHeight }
        : null;
    const capture = this.nativeCapture;
    const nativeCurrent =
      capture.timestamp === -Infinity ||
      (typeof timestamp === "number" &&
        Number.isFinite(timestamp) &&
        timestamp >= capture.timestamp);
    if (
      nativeCurrent &&
      (device?.width !== this.native.observation.device?.width ||
        device?.height !== this.native.observation.device?.height)
    ) {
      this.native = { kind: "pending", observation: { device } };
    }
    const observation = nativeCurrent ? this.native.observation : null;
    const version = this.version;
    const accept = (raster: Viewport) => {
      if (version !== this.version) {
        return false;
      }
      if (
        device &&
        observation &&
        observation === this.native.observation &&
        this.native.kind === "pending"
      ) {
        this.native = {
          kind: "accepted",
          observation,
          frame: { device, capture },
        };
        if (this.waiting?.request.kind === "native") {
          this.waiting.finish("presented");
        }
      }
      const state = this.adaptation;
      this.decoded = { viewport, device, raster };
      const accepted =
        (state.kind !== "presenting" && state.kind !== "presented") ||
        compatible(this.decoded, state.receipt.expected, this.capture);
      if (
        this.waiting?.request.kind === "presentation" &&
        this.waiting.request.recoverInconsistent &&
        this.inconsistent()
      ) {
        this.waiting.finish("inconsistent");
      }
      return accepted;
    };
    return {
      accept,
      painted: (raster) => {
        if (!accept(raster)) {
          return;
        }
        this.painted = { viewport, device, raster };
        this.present();
      },
    };
  }
}
