import { command, computed, state, type Command, type Computed } from "ccstate";
import { onRef } from "./utils.ts";

export const IMAGE_LIGHTBOX_MIN_ZOOM = 0.1;
export const IMAGE_LIGHTBOX_MAX_ZOOM = 3;
const IMAGE_MAX_WIDTH_VIEWPORT_RATIO = 3;

export type ZoomableImageCanvasGeometry = {
  readonly fitWidth: number;
  readonly maxZoom: number;
};

export interface ZoomableImageCanvasSignals {
  readonly geometry$: Computed<Promise<ZoomableImageCanvasGeometry | null>>;
  readonly zoom$: Computed<number>;
  readonly imageRef$: Command<
    (() => void) | undefined,
    [HTMLImageElement | null]
  >;
  readonly navigationOwnerRef$: Command<
    (() => void) | undefined,
    [HTMLDivElement | null]
  >;
  readonly focusNavigationOwner$: Command<void, []>;
  readonly reset$: Command<void, []>;
  readonly setZoom$: Command<void, [number]>;
}

function cssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function imageCanvasGeometry(
  fitWidth: number,
  naturalWidth: number,
  availableWidth: number,
): ZoomableImageCanvasGeometry {
  const maxRenderedWidth = Math.max(
    fitWidth * IMAGE_LIGHTBOX_MAX_ZOOM,
    naturalWidth,
    availableWidth * IMAGE_MAX_WIDTH_VIEWPORT_RATIO,
  );
  return {
    fitWidth: Math.round(fitWidth),
    maxZoom: Math.round((maxRenderedWidth / fitWidth) * 10_000) / 10_000,
  };
}

function calculateImageCanvasGeometry(
  image: HTMLImageElement,
): ZoomableImageCanvasGeometry | null {
  const content = image.closest<HTMLElement>("[data-zoomable-image-content]");
  const scrollContainer = image.closest<HTMLElement>(
    "[data-zoomable-image-canvas='true']",
  );
  if (!content || !scrollContainer) {
    return image.naturalWidth > 0
      ? imageCanvasGeometry(image.naturalWidth, image.naturalWidth, 0)
      : null;
  }

  const contentStyle = getComputedStyle(content);
  const paddingLeft = cssPixelValue(contentStyle.paddingLeft);
  const paddingRight = cssPixelValue(contentStyle.paddingRight);
  const paddingTop = cssPixelValue(contentStyle.paddingTop);
  const paddingBottom = cssPixelValue(contentStyle.paddingBottom);
  const horizontalPadding = paddingLeft + paddingRight;
  const verticalPadding = paddingTop + paddingBottom;
  const availableWidth = scrollContainer.clientWidth - horizontalPadding;
  const availableHeight = scrollContainer.clientHeight - verticalPadding;
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;

  if (naturalWidth > 0 && naturalHeight > 0) {
    const widthScale = availableWidth > 0 ? availableWidth / naturalWidth : 1;
    const heightScale =
      availableHeight > 0 ? availableHeight / naturalHeight : 1;
    return imageCanvasGeometry(
      naturalWidth * Math.min(1, widthScale, heightScale),
      naturalWidth,
      availableWidth,
    );
  }

  if (naturalWidth > 0 && availableWidth > 0) {
    return imageCanvasGeometry(
      Math.min(naturalWidth, availableWidth),
      naturalWidth,
      availableWidth,
    );
  }

  if (availableWidth > 0) {
    return imageCanvasGeometry(availableWidth, naturalWidth, availableWidth);
  }

  return naturalWidth > 0
    ? imageCanvasGeometry(naturalWidth, naturalWidth, 0)
    : null;
}

/** Derive decoded geometry from the currently mounted image. */
export function createZoomableImageCanvasSignals(): ZoomableImageCanvasSignals {
  const image$ = state<HTMLImageElement | null>(null);
  const navigationOwner$ = state<HTMLDivElement | null>(null);
  const internalZoom$ = state(1);

  const geometry$ = computed(async (get) => {
    const image = get(image$);
    if (!image) {
      return null;
    }
    await image.decode();
    return calculateImageCanvasGeometry(image);
  });

  return {
    geometry$,
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
    reset$: command(({ set }) => {
      set(internalZoom$, 1);
    }),
    setZoom$: command(({ set }, zoom: number) => {
      // react-zoom-pan-pinch owns the scale bounds; this is its display value.
      set(internalZoom$, Math.round(zoom * 10_000) / 10_000);
    }),
  };
}
