import type { ReactNode, Ref, WheelEvent as ReactWheelEvent } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import {
  type ReactZoomPanPinchContext,
  TransformComponent,
  TransformWrapper,
} from "react-zoom-pan-pinch";
import { cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import {
  IMAGE_LIGHTBOX_MAX_ZOOM,
  IMAGE_LIGHTBOX_MIN_ZOOM,
  type ZoomableImageCanvasSignals,
} from "../../signals/zoomable-image-canvas.ts";

const IMAGE_ZOOM_STEP = 0.15;
const IMAGE_DOUBLE_CLICK_ZOOM_STEP = 1;
const IMAGE_TRACKPAD_ZOOM_SENSITIVITY = 0.03;
const IMAGE_TRACKPAD_ZOOM_MAX_DELTA = 10;
const IMAGE_WHEEL_LINE_HEIGHT = 16;

function isImageWheelZoomActivated(keys: string[]): boolean {
  return keys.includes("Control") || keys.includes("Meta");
}

function normalizedImageWheelDelta(
  event: ReactWheelEvent<HTMLDivElement>,
): number {
  let delta = event.deltaY;
  if (event.deltaMode === 1) {
    delta *= IMAGE_WHEEL_LINE_HEIGHT;
  } else if (event.deltaMode === 2) {
    delta *= event.currentTarget.clientHeight;
  }

  return Math.max(
    -IMAGE_TRACKPAD_ZOOM_MAX_DELTA,
    Math.min(IMAGE_TRACKPAD_ZOOM_MAX_DELTA, delta),
  );
}

function proportionalImageWheelStep(
  event: ReactWheelEvent<HTMLDivElement>,
  scale: number,
): number {
  if (event.deltaY === 0) {
    return 0;
  }

  const normalizedDelta = normalizedImageWheelDelta(event);
  const targetScale =
    scale * Math.exp(-normalizedDelta * IMAGE_TRACKPAD_ZOOM_SENSITIVITY);
  return Math.abs(targetScale - scale);
}

function proportionalImageWheelHandler(instance: ReactZoomPanPinchContext) {
  return (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    // Convert the exponential target into the linear step expected by the library.
    instance.setup.wheel.step = proportionalImageWheelStep(
      event,
      instance.state.scale,
    );
  };
}

type SetZoomHandler = (zoom: number) => void;

export type ZoomableImageControls = {
  canZoomIn: boolean;
  canZoomOut: boolean;
  resetZoom: () => void;
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
};

type ZoomableArtifactImageCanvasProps = {
  alt: string;
  /**
   * Drawn over the image *inside* the zoom transform, so an overlay stays
   * registered with the pixels it describes at every zoom level.
   */
  overlay?: ReactNode;
  canvasTestId?: string;
  children?: (controls: ZoomableImageControls) => ReactNode;
  className?: string;
  contentClassName?: string;
  imageClassName?: string;
  imageTestId: string;
  pendingContent?: ReactNode;
  signals: ZoomableImageCanvasSignals;
  src: string;
};

type ZoomableArtifactImageElementProps = {
  alt: string;
  imageClassName?: string;
  imageRef?: Ref<HTMLImageElement>;
  imageTestId: string;
  imageWidth: string;
  src: string;
};

function controlsFromTransformState({
  displayZoom,
  maxZoom,
  setDisplayZoom,
  resetTransform,
  zoomIn,
  zoomOut,
}: {
  displayZoom: number;
  maxZoom: number;
  setDisplayZoom: SetZoomHandler;
  resetTransform: (animationTime?: number) => void;
  zoomIn: (step?: number, animationTime?: number) => void;
  zoomOut: (step?: number, animationTime?: number) => void;
}): ZoomableImageControls {
  const zoom = displayZoom;

  return {
    canZoomIn: zoom < maxZoom,
    canZoomOut: zoom > IMAGE_LIGHTBOX_MIN_ZOOM,
    resetZoom: () => {
      resetTransform(0);
      setDisplayZoom(1);
    },
    zoom,
    zoomIn: () => {
      zoomIn(IMAGE_ZOOM_STEP, 0);
    },
    zoomOut: () => {
      zoomOut(IMAGE_ZOOM_STEP, 0);
    },
  };
}

function ZoomableArtifactImageElement({
  alt,
  imageClassName,
  imageRef,
  imageTestId,
  imageWidth,
  src,
}: ZoomableArtifactImageElementProps) {
  return (
    <img
      ref={imageRef}
      src={src}
      alt={alt}
      data-testid={imageTestId}
      loading="eager"
      decoding="async"
      fetchPriority="high"
      draggable={false}
      style={{ width: imageWidth }}
      className={cn(
        // The zoom library disables image hit testing in an unlayered rule.
        "pointer-events-auto! block h-auto max-w-none shrink-0 select-none object-contain [-webkit-touch-callout:default]",
        imageClassName,
      )}
    />
  );
}

function ZoomableArtifactImageFrame({
  element,
  overlay,
  ready,
}: {
  element: ZoomableArtifactImageElementProps;
  overlay?: ReactNode;
  ready: boolean;
}) {
  return (
    <div className="relative shrink-0" hidden={!ready}>
      {/* A resolved or refreshed URL owns its own native decode lifecycle. */}
      <ZoomableArtifactImageElement key={element.src} {...element} />
      {overlay}
    </div>
  );
}

function ZoomableArtifactImageViewport({
  canvasTestId,
  contentClassName,
  element,
  instance,
  onCanvasPointerDown,
  overlay,
  ready,
}: {
  canvasTestId: string;
  contentClassName?: string;
  element: ZoomableArtifactImageElementProps;
  instance: ReactZoomPanPinchContext;
  onCanvasPointerDown: () => void;
  overlay?: ReactNode;
  ready: boolean;
}) {
  return (
    <div
      className="h-full min-h-0 w-full cursor-grab touch-none overscroll-contain active:cursor-grabbing"
      data-testid={canvasTestId}
      data-zoomable-image-canvas="true"
      onPointerDown={(event) => {
        // Panning cancels the native mousedown focus. Focus only this canvas's
        // owner; zoom/navigation buttons are siblings of the viewport.
        if (event.button === 0) {
          onCanvasPointerDown();
        }
      }}
    >
      <TransformComponent
        contentStyle={{ height: "100%", width: "100%" }}
        wrapperClass="h-full min-h-0 w-full"
        wrapperProps={{
          onWheelCapture: proportionalImageWheelHandler(instance),
        }}
        wrapperStyle={{
          height: "100%",
          touchAction: "none",
          width: "100%",
        }}
      >
        <div
          className={cn(
            "flex h-full w-full items-center justify-center",
            contentClassName,
          )}
          data-testid={`${canvasTestId}-content`}
          data-zoomable-image-content
        >
          <ZoomableArtifactImageFrame
            element={element}
            overlay={overlay}
            ready={ready}
          />
        </div>
      </TransformComponent>
    </div>
  );
}

export function ZoomableArtifactImageCanvas({
  alt,
  canvasTestId = "zoomable-image-canvas",
  children,
  overlay,
  className,
  contentClassName,
  imageClassName,
  imageTestId,
  pendingContent,
  signals,
  src,
}: ZoomableArtifactImageCanvasProps) {
  const { t } = useTranslation();
  const displayZoom = useGet(signals.zoom$);
  const geometryLoadable = useLoadable(signals.geometry$);
  const imageGeometry =
    geometryLoadable.state === "hasData" ? geometryLoadable.data : null;
  const setDisplayZoom = useSet(signals.setZoom$);
  const imageRef = useSet(signals.imageRef$);
  const focusNavigationOwner = useSet(signals.focusNavigationOwner$);
  const imageReady = imageGeometry !== null;
  const maxZoom = imageGeometry?.maxZoom ?? IMAGE_LIGHTBOX_MAX_ZOOM;
  const imageWidth = imageGeometry ? `${imageGeometry.fitWidth}px` : "0px";

  return (
    <TransformWrapper
      centerZoomedOut
      disablePadding
      doubleClick={{
        mode: displayZoom === 1 ? "zoomIn" : "reset",
        step: IMAGE_DOUBLE_CLICK_ZOOM_STEP,
      }}
      initialScale={1}
      maxScale={maxZoom}
      minScale={IMAGE_LIGHTBOX_MIN_ZOOM}
      autoAlignment={{ disabled: true }}
      onInit={(transformRef) => {
        setDisplayZoom(transformRef.state.scale);
      }}
      onTransform={(_transformRef, transformState) => {
        setDisplayZoom(transformState.scale);
      }}
      panning={{
        allowMiddleClickPan: false,
        allowRightClickPan: false,
        velocityDisabled: true,
      }}
      pinch={{ allowPanning: false }}
      smooth={false}
      trackPadPanning={{ disabled: false }}
      wheel={{
        activationKeys: isImageWheelZoomActivated,
        step: 0,
      }}
    >
      {({ instance, resetTransform, zoomIn, zoomOut }) => {
        const controls = controlsFromTransformState({
          displayZoom,
          maxZoom,
          resetTransform,
          setDisplayZoom,
          zoomIn,
          zoomOut,
        });

        return (
          <div
            className={cn(
              "relative h-full min-h-0 w-full flex-1 overflow-hidden bg-muted/30",
              className,
            )}
          >
            {imageReady ? children?.(controls) : null}
            {!imageReady ? (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-muted-foreground">
                {geometryLoadable.state === "hasError" ? (
                  <span role="alert">
                    {t(($) => {
                      return $.artifacts.preview.genericUnavailable;
                    })}
                  </span>
                ) : (
                  pendingContent
                )}
              </div>
            ) : null}
            <ZoomableArtifactImageViewport
              canvasTestId={canvasTestId}
              contentClassName={contentClassName}
              element={{
                alt,
                imageClassName,
                imageRef,
                imageTestId,
                imageWidth,
                src,
              }}
              instance={instance}
              onCanvasPointerDown={focusNavigationOwner}
              overlay={overlay}
              ready={imageReady}
            />
          </div>
        );
      }}
    </TransformWrapper>
  );
}
