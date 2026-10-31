import type { Protocol } from "devtools-protocol";
import { CdpFault, isRecord } from "../cdp/errors.ts";
import {
  maximumDisplayArea,
  maximumDisplayDimension,
  maximumFrameDimension,
} from "./limits.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Local page surface in CSS pixels, with the requested physical density. */
export interface DisplaySize extends Viewport {
  readonly dpr: number;
}

/** Acknowledged emulation scale and its native-frame/input relationships. */
export interface DisplayTransform {
  readonly viewportScale: number;
  readonly frameScale: number;
  readonly wheelScale: number;
}

/** Observable native frame dimensions and the bounded decoded image. */
export interface PresentationGeometry {
  readonly device: Viewport;
  readonly nativeDpr: number;
}

export function captureRaster(
  device: Viewport,
  nativeDpr: number,
  bounds: Viewport = {
    width: maximumFrameDimension,
    height: maximumFrameDimension,
  },
): Viewport {
  const scale = Math.min(
    nativeDpr,
    bounds.width / device.width,
    bounds.height / device.height,
  );
  return {
    width: Math.round(device.width * scale),
    height: Math.round(device.height * scale),
  };
}

function presentationGeometry(
  device: Viewport,
  nativeDpr: number,
): PresentationGeometry {
  if (![device.width, device.height, nativeDpr].every(positive)) {
    throw new CdpFault("display", "The browser display scale is unavailable.");
  }
  return { device, nativeDpr };
}

export function nativePresentation(
  layout: Protocol.Page.GetLayoutMetricsResponse,
): PresentationGeometry {
  const viewport = layout.cssVisualViewport;
  const zoom = viewport.zoom ?? 1;
  if (![viewport.clientWidth, viewport.clientHeight, zoom].every(positive)) {
    throw new CdpFault("display", "The browser display scale is unavailable.");
  }
  return presentationGeometry(
    {
      width: viewport.clientWidth * zoom,
      height: viewport.clientHeight * zoom,
    },
    layout.visualViewport.clientWidth / viewport.clientWidth / zoom,
  );
}

/** Selected-frame native contents and their observed outer window bounds. */
export interface NativeWindowGeometry {
  readonly bounds: Viewport;
  readonly device: Viewport;
}

function windowSize(bounds: Protocol.Browser.Bounds): Viewport {
  if (!positive(bounds.width) || !positive(bounds.height)) {
    throw new CdpFault("display", "The browser window size is unavailable.");
  }
  return { width: bounds.width, height: bounds.height };
}

export function nativeWindowGeometry(
  device: Viewport,
  bounds: Protocol.Browser.Bounds,
): NativeWindowGeometry {
  return {
    bounds: windowSize(bounds),
    device,
  };
}

export function windowPresentation(
  reference: NativeWindowGeometry,
  bounds: Protocol.Browser.Bounds,
  nativeDpr: number,
): PresentationGeometry {
  const current = windowSize(bounds);
  // setContentsSize adjusts the outer window, whose native round trip can
  // change the requested DIP. Keep the calibrated chrome inset; measure the
  // actual window delta instead of widening frame or decoded-pixel tolerances.
  return presentationGeometry(
    {
      width: reference.device.width + current.width - reference.bounds.width,
      height:
        reference.device.height + current.height - reference.bounds.height,
    },
    nativeDpr,
  );
}

export const positive = (value: unknown): value is number => {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
};

/** Native and adapted input use the same Chrome zoom relationship. */
export function inputTransform(
  zoom: number,
  viewportScale = 1,
): DisplayTransform {
  if (!positive(zoom) || !positive(viewportScale)) {
    throw new CdpFault(
      "input",
      "The remote display scale is unavailable for input.",
    );
  }
  return {
    viewportScale,
    frameScale: 1 / zoom,
    wheelScale: viewportScale * viewportScale * zoom,
  };
}

/** Immutable units captured by an input job, independent of later calibration. */
export interface InputGeometry {
  readonly revision: number;
  readonly position: (point: Point) => Point;
  readonly wheel: (
    deltaX: number,
    deltaY: number,
  ) => { deltaX: number; deltaY: number };
}

export function createInputGeometry(
  revision: number,
  viewport: Viewport,
  wheelScale: number,
): InputGeometry {
  // Copy scalar units: mutating a caller-owned size cannot change an admitted job.
  const { width, height } = viewport;
  return Object.freeze({
    revision,
    position: (point: Point): Point => {
      return { x: point.x * width, y: point.y * height };
    },
    wheel: (deltaX: number, deltaY: number) => {
      const wheel = {
        deltaX: deltaX * wheelScale,
        deltaY: deltaY * wheelScale,
      };
      if (!Number.isFinite(wheel.deltaX) || !Number.isFinite(wheel.deltaY)) {
        throw new CdpFault(
          "input",
          "The wheel distance is outside the supported range.",
        );
      }
      return wheel;
    },
  });
}

export function frameViewport(metadata: unknown): Viewport | null {
  if (!isRecord(metadata)) {
    return null;
  }
  const { deviceWidth, deviceHeight, pageScaleFactor } = metadata;
  if (
    !positive(deviceWidth) ||
    !positive(deviceHeight) ||
    !positive(pageScaleFactor)
  ) {
    return null;
  }
  const width = deviceWidth / pageScaleFactor;
  const height = deviceHeight / pageScaleFactor;
  return positive(width) && positive(height) ? { width, height } : null;
}

/** Product policy, independently of capture caps and native window chrome. */
export function constrainDisplay(
  size: DisplaySize,
): DisplaySize & { constrained: boolean } {
  const scale = Math.min(
    1,
    maximumDisplayDimension / size.width,
    maximumDisplayDimension / size.height,
    maximumDisplayDimension / (size.width * size.dpr),
    maximumDisplayDimension / (size.height * size.dpr),
    Math.sqrt(maximumDisplayArea / size.width / size.height) / size.dpr,
  );
  const width = Math.max(1, Math.floor(size.width * scale));
  const height = Math.max(1, Math.floor(size.height * scale));
  if (
    width * size.dpr > maximumDisplayDimension ||
    height * size.dpr > maximumDisplayDimension ||
    width * height * size.dpr * size.dpr > maximumDisplayArea
  ) {
    throw new CdpFault(
      "display",
      "The display density cannot fit within the supported size limits.",
    );
  }
  return { width, height, dpr: size.dpr, constrained: scale < 1 };
}

/** Project a requested CSS surface into native window DIP, emulation and input. */
export function projectDisplay(
  windowId: number,
  size: DisplaySize,
  layout: Protocol.Page.GetLayoutMetricsResponse,
) {
  const zoom = layout.cssVisualViewport.zoom ?? 1;
  const nativeDpr =
    layout.visualViewport.clientWidth /
    layout.cssVisualViewport.clientWidth /
    zoom;
  if (!positive(zoom) || !positive(nativeDpr)) {
    throw new CdpFault("display", "The browser display scale is unavailable.");
  }
  const densityScale = size.dpr / nativeDpr;
  const viewportScale = densityScale / zoom;
  const contents = {
    windowId,
    width: Math.max(1, Math.round(size.width * densityScale)),
    height: Math.max(1, Math.round(size.height * densityScale)),
  };
  const metrics: Protocol.Emulation.SetDeviceMetricsOverrideRequest = {
    width: Math.max(1, Math.round(size.width * zoom)),
    height: Math.max(1, Math.round(size.height * zoom)),
    deviceScaleFactor: size.dpr / zoom,
    scale: viewportScale,
    dontSetVisibleSize: true,
    mobile: false,
  };
  return {
    contents,
    metrics,
    input: inputTransform(zoom, viewportScale),
    presentation: presentationGeometry(contents, nativeDpr),
    // Integer native sizes prevent metric float noise from defeating deduplication.
    key: [
      windowId,
      size.width,
      size.height,
      size.dpr,
      zoom,
      contents.width,
      contents.height,
    ].join(":"),
  };
}
