import {
  useLayoutEffect,
  type PointerEventHandler,
  type ReactNode,
  type Ref,
} from "react";
import { TransformComponent } from "react-zoom-pan-pinch";
import { cn } from "../../lib/utils";

type ZoomableImageViewportProps = {
  readonly alt: string;
  readonly src: string;
  readonly ready: boolean;
  readonly expanded?: boolean;
  readonly imageRef: Ref<HTMLImageElement>;
  readonly viewportRef: Ref<HTMLDivElement>;
  readonly imageClassName?: string;
  readonly canvasTestId: string;
  readonly imageTestId: string;
  readonly overlay?: ReactNode;
  readonly onPointerDown: PointerEventHandler<HTMLDivElement>;
  readonly onLayoutCommit: () => void;
};

/** The measurable image surface inside a react-zoom-pan-pinch TransformWrapper. */
export function ZoomableImageViewport({
  alt,
  src,
  ready,
  expanded,
  imageRef,
  viewportRef,
  imageClassName,
  canvasTestId,
  imageTestId,
  overlay,
  onPointerDown,
  onLayoutCommit,
}: ZoomableImageViewportProps) {
  // Notify the imperative viewer after this image becomes measurable or its
  // dialog changes layout. Ordinary rerenders and pan updates do not recenter it.
  useLayoutEffect(() => {
    if (ready) {
      onLayoutCommit();
    }
  }, [ready, src, expanded, onLayoutCommit]);

  return (
    <div
      ref={viewportRef}
      className="min-h-0 min-w-0 flex-1 cursor-grab touch-none overscroll-contain active:cursor-grabbing [container-type:size]"
      data-testid={canvasTestId}
      data-zoomable-image-canvas="true"
      onPointerDown={onPointerDown}
    >
      <TransformComponent wrapperStyle={{ height: "100%", width: "100%" }}>
        <div
          className="relative shrink-0"
          hidden={!ready}
          data-testid={`${canvasTestId}-content`}
          data-zoomable-image-content
        >
          <img
            key={src}
            ref={imageRef}
            src={src}
            alt={alt}
            data-testid={imageTestId}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            draggable={false}
            className={cn(
              // Override the library's unlayered image hit-testing rule.
              // Container units refer to the untransformed viewport.
              "pointer-events-auto! block h-auto w-auto max-h-[100cqh] max-w-[100cqw] shrink-0 select-none [-webkit-touch-callout:default]",
              imageClassName,
            )}
          />
          {overlay}
        </div>
      </TransformComponent>
    </div>
  );
}
