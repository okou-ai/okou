import type { ReactNode } from "react";

export function PresentationArtifactViewport({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <div
      className="relative h-full w-full min-h-0 min-w-0 overflow-hidden bg-background [container-type:size]"
      data-testid="presentation-artifact-viewport"
    >
      <div
        data-testid="presentation-artifact-canvas"
        className="absolute left-1/2 top-1/2 h-[1080px] w-[1920px] origin-center [--okou-presentation-fit-width:100cqw] [--okou-presentation-fit-height:100cqh] [transform:translate(-50%,-50%)_scale(calc(min(tan(atan2(var(--okou-presentation-fit-width),1920px)),tan(atan2(var(--okou-presentation-fit-height),1080px)))))] [@container(width:0px)]:invisible [@container(height:0px)]:invisible"
      >
        {children}
      </div>
    </div>
  );
}
