export type ScrollAnchorOptions = {
  readonly anchorSelector: string;
  readonly preserveNativeAnchoring?: boolean;
} & (
  | { readonly viewportSelector: string }
  | { readonly viewport: HTMLElement | null }
);

export type ScrollAnchorSnapshot = {
  readonly viewport: HTMLElement;
  readonly anchor: HTMLElement;
  readonly offset: number;
  readonly disabledNativeAnchoring: boolean;
};

export function captureScrollAnchor(
  container: ParentNode,
  options: ScrollAnchorOptions,
): ScrollAnchorSnapshot | null {
  const viewport =
    "viewport" in options
      ? options.viewport
      : container.querySelector<HTMLElement>(options.viewportSelector);
  if (!viewport) {
    return null;
  }
  const viewportBounds = viewport.getBoundingClientRect();
  for (const anchor of viewport.querySelectorAll<HTMLElement>(
    options.anchorSelector,
  )) {
    // Prefer the visible paragraph inside a list item or table row over a
    // potentially much taller ancestor whose start has already scrolled away.
    if (anchor.querySelector(options.anchorSelector)) {
      continue;
    }
    const bounds = anchor.getBoundingClientRect();
    if (
      bounds.height <= 0 ||
      bounds.width <= 0 ||
      bounds.bottom <= viewportBounds.top ||
      bounds.top >= viewportBounds.bottom
    ) {
      continue;
    }
    // Fullscreen changes can reflow the anchor itself. Page inserts can let
    // the browser compensate first and restore only the remaining delta.
    const disabledNativeAnchoring =
      !options.preserveNativeAnchoring &&
      !viewport.classList.contains("[overflow-anchor:none]");
    if (disabledNativeAnchoring) {
      viewport.classList.add("[overflow-anchor:none]");
    }
    return {
      viewport,
      anchor,
      offset: bounds.top - viewportBounds.top,
      disabledNativeAnchoring,
    };
  }
  return null;
}

export function restoreScrollAnchor(snapshot: ScrollAnchorSnapshot) {
  const { viewport, anchor, offset } = snapshot;
  if (!viewport.contains(anchor)) {
    return;
  }
  const bounds = anchor.getBoundingClientRect();
  // If a clipped paragraph becomes shorter than its old clipped portion,
  // keep that paragraph in view instead of scrolling past it entirely.
  const targetOffset = bounds.height + offset > 0 ? offset : 0;
  const delta =
    bounds.top - viewport.getBoundingClientRect().top - targetOffset;
  if (Math.abs(delta) >= 1) {
    viewport.scrollTop += delta;
  }
}
