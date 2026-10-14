import { command, computed, state, type Command, type Computed } from "ccstate";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { onRef } from "./utils.ts";

export const IMAGE_LIGHTBOX_MIN_ZOOM = 0.1;
export const IMAGE_LIGHTBOX_MAX_ZOOM = 3;
const IMAGE_MAX_WIDTH_VIEWPORT_RATIO = 3;

type CanvasRef<T> = Command<(() => void) | undefined, [T | null]>;

export interface ZoomableImageCanvasSignals {
  readonly decodedImage$: Computed<Promise<HTMLImageElement | null>>;
  readonly maxZoom$: Computed<number>;
  readonly zoom$: Computed<number>;
  readonly imageRef$: CanvasRef<HTMLImageElement>;
  readonly viewportRef$: CanvasRef<HTMLDivElement>;
  readonly initialize$: Command<void, [ReactZoomPanPinchRef]>;
  readonly navigationOwnerRef$: CanvasRef<HTMLDivElement>;
  readonly focusNavigationOwner$: Command<void, []>;
  readonly syncLayout$: Command<void, []>;
  readonly reset$: Command<void, []>;
  readonly setZoom$: Command<void, [number]>;
}

/** CSS owns image sizing; the zoom library owns its transform. */
export function createZoomableImageCanvasSignals(): ZoomableImageCanvasSignals {
  const image$ = state<HTMLImageElement | null>(null);
  const viewport$ = state<HTMLDivElement | null>(null);
  const transform$ = state<ReactZoomPanPinchRef | null>(null);
  const navigationOwner$ = state<HTMLDivElement | null>(null);
  const internalZoom$ = state(1);
  const internalMaxZoom$ = state(IMAGE_LIGHTBOX_MAX_ZOOM);
  const setZoom$ = command(({ set }, zoom: number) => {
    // This is a one-way display projection of the library's actual scale.
    set(internalZoom$, Math.round(zoom * 10_000) / 10_000);
  });

  const decodedImage$ = computed(async (get) => {
    const image = get(image$);
    if (!image) {
      return null;
    }
    await image.decode();
    return image;
  });

  const syncLayout$ = command(({ get, set }) => {
    const image = get(image$);
    const viewport = get(viewport$);
    const transform = get(transform$);
    if (!image || !viewport || !transform) {
      return;
    }
    const imageWidth = image.offsetWidth;
    const viewportWidth = viewport.clientWidth;
    if (imageWidth <= 0 || viewportWidth <= 0 || viewport.clientHeight <= 0) {
      // A collapsed surface has no layout to synchronize. Its opening commit
      // or transition completion will supply the actual available space.
      return;
    }

    // Preserve the product's zoom reach without using measurements to size the
    // image: at least 3x fit, native resolution, and 3x the viewport's width.
    const maxZoom =
      Math.round(
        Math.max(
          IMAGE_LIGHTBOX_MAX_ZOOM,
          image.naturalWidth / imageWidth,
          (viewportWidth * IMAGE_MAX_WIDTH_VIEWPORT_RATIO) / imageWidth,
        ) * 10_000,
      ) / 10_000;
    set(internalMaxZoom$, maxZoom);
    transform.centerView(Math.min(transform.state.scale, maxZoom), 0);
  });

  return {
    decodedImage$,
    maxZoom$: computed((get) => {
      return get(internalMaxZoom$);
    }),
    syncLayout$,
    initialize$: command(({ set }, transform: ReactZoomPanPinchRef) => {
      set(transform$, transform);
      set(setZoom$, transform.state.scale);
      set(syncLayout$);
    }),
    viewportRef$: onRef(
      command(({ get, set }, element: HTMLDivElement, signal: AbortSignal) => {
        set(viewport$, element);
        const syncLayout = () => {
          set(syncLayout$);
        };
        const view = element.ownerDocument.defaultView;
        view?.addEventListener("resize", syncLayout, { passive: true, signal });
        view?.visualViewport?.addEventListener("resize", syncLayout, {
          passive: true,
          signal,
        });
        signal.addEventListener(
          "abort",
          () => {
            if (get(viewport$) === element) {
              set(viewport$, null);
              set(transform$, null);
            }
          },
          { once: true },
        );
      }),
    ),
    navigationOwnerRef$: onRef(
      command(({ get, set }, element: HTMLDivElement, signal: AbortSignal) => {
        set(navigationOwner$, element);
        signal.addEventListener(
          "abort",
          () => {
            if (get(navigationOwner$) === element) {
              set(navigationOwner$, null);
            }
          },
          { once: true },
        );
      }),
    ),
    focusNavigationOwner$: command(({ get }) => {
      get(navigationOwner$)?.focus({ preventScroll: true });
    }),
    imageRef$: onRef(
      command(
        ({ get, set }, element: HTMLImageElement, signal: AbortSignal) => {
          set(image$, element);
          signal.addEventListener(
            "abort",
            () => {
              if (get(image$) === element) {
                set(image$, null);
              }
            },
            { once: true },
          );
        },
      ),
    ),
    zoom$: computed((get) => {
      return get(internalZoom$);
    }),
    reset$: command(({ get }) => {
      get(transform$)?.centerView(1, 0);
    }),
    setZoom$,
  };
}
