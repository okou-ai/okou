import type { DisplaySize } from "./display/geometry.ts";

/** Committed DOM observations; no transport or per-frame React updates. */
export function observeDisplay(
  canvas: HTMLCanvasElement,
  changed: (size: DisplaySize | null) => void,
): () => void {
  let active = true;
  let density = window.matchMedia(
    `(resolution: ${window.devicePixelRatio}dppx)`,
  );
  const measure = () => {
    if (!active) {
      return;
    }
    const box = canvas.getBoundingClientRect();
    changed(
      box.width > 0 && box.height > 0
        ? { width: box.width, height: box.height, dpr: window.devicePixelRatio }
        : null,
    );
  };
  const densityChanged = () => {
    if (!active) {
      return;
    }
    density.removeEventListener("change", densityChanged);
    density = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    density.addEventListener("change", densityChanged);
    measure();
  };
  const observer = new ResizeObserver(measure);
  observer.observe(canvas);
  density.addEventListener("change", densityChanged);
  measure();
  return () => {
    active = false;
    observer.disconnect();
    density.removeEventListener("change", densityChanged);
  };
}
