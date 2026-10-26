import type { ComponentPropsWithoutRef, ReactEventHandler } from "react";

type AutoFocusedArtifactIframeProps = Omit<
  ComponentPropsWithoutRef<"iframe">,
  "ref"
> & {
  focusKey: string;
  focusOnMount: boolean;
};

export function AutoFocusedArtifactIframe({
  focusKey,
  focusOnMount,
  onLoad,
  tabIndex,
  ...props
}: AutoFocusedArtifactIframeProps) {
  const handleLoad: ReactEventHandler<HTMLIFrameElement> = (event) => {
    onLoad?.(event);
    deferIframeFocus(event.currentTarget, focusKey, focusOnMount, "load");
  };

  return (
    <iframe
      {...props}
      ref={(element) => {
        deferIframeFocus(element, focusKey, focusOnMount, "mount");
      }}
      onLoad={handleLoad}
      tabIndex={focusOnMount && tabIndex === undefined ? -1 : tabIndex}
    />
  );
}

function deferIframeFocus(
  element: HTMLIFrameElement | null,
  focusKey: string,
  focusOnMount: boolean,
  phase: "load" | "mount",
) {
  if (!element || !focusOnMount) {
    return;
  }
  const datasetKey =
    phase === "load"
      ? "artifactIframeLoadFocusKey"
      : "artifactIframeMountFocusKey";
  if (element.dataset[datasetKey] === focusKey) {
    return;
  }

  element.dataset[datasetKey] = focusKey;
  window.requestAnimationFrame(() => {
    if (element.isConnected && element.dataset[datasetKey] === focusKey) {
      element.focus({ preventScroll: true });
    }
  });
}
