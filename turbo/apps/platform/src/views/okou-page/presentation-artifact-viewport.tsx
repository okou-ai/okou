import type { ReactNode } from "react";
import { useSet } from "ccstate-react";
import {
  PRESENTATION_ARTIFACT_VIEWPORT_HEIGHT,
  PRESENTATION_ARTIFACT_VIEWPORT_WIDTH,
  presentationArtifactViewportRef$,
} from "../../signals/okou-page/presentation-artifact-viewport.ts";

export function PresentationArtifactViewport({
  children,
}: {
  readonly children: ReactNode;
}) {
  const viewportRef = useSet(presentationArtifactViewportRef$);

  return (
    <div
      ref={viewportRef}
      className="relative h-full w-full overflow-hidden bg-background"
      data-testid="presentation-artifact-viewport"
    >
      <div
        data-presentation-artifact-canvas
        data-testid="presentation-artifact-canvas"
        className="invisible absolute left-0 top-0 origin-top-left"
        style={{
          height: PRESENTATION_ARTIFACT_VIEWPORT_HEIGHT,
          width: PRESENTATION_ARTIFACT_VIEWPORT_WIDTH,
        }}
      >
        {children}
      </div>
    </div>
  );
}
