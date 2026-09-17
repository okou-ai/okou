/** What a row reports after laying out: whether either pager has anywhere to go. */
export interface RailTravel {
  readonly canScrollBack: boolean;
  readonly canScrollForward: boolean;
}

/** How far the rail can still travel in each direction, right now. */
export function measureRail(element: HTMLElement): RailTravel {
  // A scroll position is fractional under zoom, so a whole pixel of slack
  // keeps a rail that is visually at its end from claiming otherwise.
  const remaining =
    element.scrollWidth - element.clientWidth - element.scrollLeft;
  return {
    canScrollBack: element.scrollLeft > 1,
    canScrollForward: remaining > 1,
  };
}

/**
 * A page is one visible width less an item's worth of overlap, so whatever sat
 * at the edge stays on screen and tells the reader where they landed.
 */
const RAIL_PAGE_OVERLAP = 64;

/** Moves a rail by one page in `side`. */
export function pageRail(element: HTMLElement, side: "back" | "forward"): void {
  const step = Math.max(element.clientWidth - RAIL_PAGE_OVERLAP, 1);
  element.scrollBy({ left: side === "back" ? -step : step });
}

/**
 * Watches everything that can move a row's ends and calls `report` when it
 * does. Whether a row can still travel is a layout outcome rather than a
 * constant: the rail's width and its items' widths both move the end, and
 * neither is settled until the browser has laid them out. The size observer
 * covers a resized column and an item that changes width; the child observer
 * covers a catalog that finishes loading after the row mounted.
 *
 * Each surface keeps its own travel state — two composers side by side would
 * otherwise collide on a shared rail id — so only this wiring is shared.
 */
export function observeRail(
  element: HTMLElement,
  signal: AbortSignal,
  report: (travel: RailTravel) => void,
): void {
  const size = new ResizeObserver(() => {
    report(measureRail(element));
  });
  const observeAll = () => {
    size.disconnect();
    size.observe(element);
    for (const child of element.children) {
      size.observe(child);
    }
    report(measureRail(element));
  };
  observeAll();
  const children = new MutationObserver(observeAll);
  children.observe(element, { childList: true });
  signal.addEventListener("abort", () => {
    size.disconnect();
    children.disconnect();
  });
}
