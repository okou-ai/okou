import type { ReactNode } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { TransformWrapper } from "react-zoom-pan-pinch";
import { cn, ZoomableImageViewport } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import {
  IMAGE_LIGHTBOX_MIN_ZOOM,
  type ZoomableImageCanvasSignals,
} from "../../signals/zoomable-image-canvas.ts";

const IMAGE_BUTTON_ZOOM_STEP = 0.15;
const IMAGE_WHEEL_ZOOM_STEP = 0.05;
const IMAGE_DOUBLE_CLICK_ZOOM_STEP = 1;

function isImageWheelZoomActivated(keys: string[]): boolean {
  return keys.includes("Control") || keys.includes("Meta");
}

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
  /** Overlays share the image's transform and stay registered with its pixels. */
  overlay?: ReactNode;
  canvasTestId?: string;
  children?: (controls: ZoomableImageControls) => ReactNode;
  className?: string;
  contentClassName?: string;
  imageClassName?: string;
  imageTestId: string;
  /** A dialog layout change whose committed dimensions need library alignment. */
  expanded?: boolean;
  pendingContent?: ReactNode;
  signals: ZoomableImageCanvasSignals;
  src: string;
};

export function ZoomableArtifactImageCanvas({
  alt,
  canvasTestId = "zoomable-image-canvas",
  children,
  overlay,
  className,
  contentClassName,
  imageClassName,
  imageTestId,
  expanded,
  pendingContent,
  signals,
  src,
}: ZoomableArtifactImageCanvasProps) {
  const { t } = useTranslation();
  const zoom = useGet(signals.zoom$);
  const maxZoom = useGet(signals.maxZoom$);
  const imageLoadable = useLoadable(signals.decodedImage$);
  const decodedImage =
    imageLoadable.state === "hasData" ? imageLoadable.data : null;
  const imageReady = decodedImage !== null;
  const setDisplayZoom = useSet(signals.setZoom$);
  const imageRef = useSet(signals.imageRef$);
  const viewportRef = useSet(signals.viewportRef$);
  const initialize = useSet(signals.initialize$);
  const syncLayout = useSet(signals.syncLayout$);
  const resetZoom = useSet(signals.reset$);
  const focusNavigationOwner = useSet(signals.focusNavigationOwner$);

  return (
    <TransformWrapper
      centerZoomedOut
      disablePadding
      doubleClick={{
        mode: zoom === 1 ? "zoomIn" : "reset",
        step: IMAGE_DOUBLE_CLICK_ZOOM_STEP,
      }}
      initialScale={1}
      maxScale={maxZoom}
      minScale={IMAGE_LIGHTBOX_MIN_ZOOM}
      autoAlignment={{ disabled: true }}
      onInit={initialize}
      onTransform={(_transform, state) => {
        setDisplayZoom(state.scale);
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
        step: IMAGE_WHEEL_ZOOM_STEP,
      }}
    >
      {({ zoomIn, zoomOut }) => {
        const controls: ZoomableImageControls = {
          canZoomIn: zoom < maxZoom,
          canZoomOut: zoom > IMAGE_LIGHTBOX_MIN_ZOOM,
          resetZoom,
          zoom,
          zoomIn: () => {
            zoomIn(IMAGE_BUTTON_ZOOM_STEP, 0);
          },
          zoomOut: () => {
            zoomOut(IMAGE_BUTTON_ZOOM_STEP, 0);
          },
        };

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
                {imageLoadable.state === "hasError" ? (
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
            <div className={cn("absolute inset-0 flex", contentClassName)}>
              <ZoomableImageViewport
                alt={alt}
                src={src}
                ready={imageReady}
                expanded={expanded}
                imageRef={imageRef}
                viewportRef={viewportRef}
                imageClassName={imageClassName}
                canvasTestId={canvasTestId}
                imageTestId={imageTestId}
                overlay={overlay}
                onLayoutCommit={syncLayout}
                onPointerDown={(event) => {
                  // Panning cancels native mousedown focus. Toolbar buttons
                  // remain siblings and retain their own focus behavior.
                  if (event.button === 0) {
                    focusNavigationOwner();
                  }
                }}
              />
            </div>
          </div>
        );
      }}
    </TransformWrapper>
  );
}
