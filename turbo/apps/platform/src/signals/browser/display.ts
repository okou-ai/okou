import type { DisplaySize } from "./display/geometry.ts";

/** Read the committed canvas box; an empty box has no usable display size. */
export function measureDisplay(canvas: HTMLCanvasElement): DisplaySize | null {
  const box = canvas.getBoundingClientRect();
  return box.width > 0 && box.height > 0
    ? { width: box.width, height: box.height, dpr: window.devicePixelRatio }
    : null;
}

/**
 * Native viewport and density changes have their own events. Application
 * layout changes (sidebar width, panel visibility) call the browser's
 * `syncLayout$` from the command or commit that owns them.
 */
export function observeDisplay(
  canvas: HTMLCanvasElement,
  changed: (size: DisplaySize | null) => void,
  signal: AbortSignal,
): void {
  const measure = () => {
    changed(measureDisplay(canvas));
  };
  let density: MediaQueryList | null = null;
  const watchDensity = () => {
    density?.removeEventListener("change", densityChanged);
    density = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    density.addEventListener("change", densityChanged, { signal });
  };
  const densityChanged = () => {
    watchDensity();
    measure();
  };
  window.addEventListener("resize", measure, { signal });
  window.visualViewport?.addEventListener("resize", measure, { signal });
  watchDensity();
  measure();
}
