import { command, computed, state } from "ccstate";
import { animationFrame } from "signal-timers";

import { onRef } from "../../utils.ts";

/**
 * A browsed category is the whole of a catalog section, and the largest one
 * holds more than a thousand connectors. The grid therefore mounts the rows
 * around the viewport and reserves the rest as two spanning placeholders, so
 * entering a category costs a screen of cards instead of a category of them.
 *
 * Row height is a constant rather than a per-row measurement: a card's tallest
 * state is its two-line description, `grid-auto-rows` pins every track to that
 * height, and the reserved rows and the rendered rows then describe the same
 * geometry without reading layout back.
 */
export const CONNECTOR_CATEGORY_GRID_ROW_HEIGHT = 102;

/** The `gap-3` between the grid's rows. */
const CONNECTOR_CATEGORY_GRID_ROW_GAP = 12;

const CONNECTOR_CATEGORY_GRID_OVERSCAN_ROWS = 2;

/**
 * What an unmeasured grid renders. A category is entered by its count, so an
 * environment without layout shows a screenful rather than an empty grid.
 */
const CONNECTOR_CATEGORY_GRID_FALLBACK_ROWS = 40;

interface ConnectorCategoryGridMetrics {
  /** How far the grid's top sits above the viewport's top, never negative. */
  readonly scrolledPast: number;
  readonly viewportHeight: number;
  /** Columns the responsive grid resolved to, or 0 while unmeasured. */
  readonly columns: number;
}

interface ConnectorCategoryGridWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly leadingRows: number;
  readonly trailingRows: number;
}

function emptyMetrics(): ConnectorCategoryGridMetrics {
  return { scrolledPast: 0, viewportHeight: 0, columns: 0 };
}

function sameMetrics(
  previous: ConnectorCategoryGridMetrics,
  next: ConnectorCategoryGridMetrics,
): boolean {
  return (
    previous.scrolledPast === next.scrolledPast &&
    previous.viewportHeight === next.viewportHeight &&
    previous.columns === next.columns
  );
}

/**
 * The column count the responsive grid resolved to. The breakpoints live in the
 * class list, so the count is read back from the resolved template instead of
 * being restated here as a media query.
 */
function resolveColumns(grid: HTMLElement): number {
  const template = getComputedStyle(grid).gridTemplateColumns;
  if (!template || template === "none") {
    return 0;
  }
  return template.split(" ").filter((track) => {
    return track.length > 0;
  }).length;
}

const internalGridMetrics$ =
  state<ConnectorCategoryGridMetrics>(emptyMetrics());

/** One category is open at a time, so one set of metrics describes the page. */
export const connectorCategoryGridMetrics$ = computed((get) => {
  return get(internalGridMetrics$);
});

const setConnectorCategoryGridMetrics$ = command(
  ({ get, set }, metrics: ConnectorCategoryGridMetrics) => {
    if (sameMetrics(get(internalGridMetrics$), metrics)) {
      return;
    }
    set(internalGridMetrics$, metrics);
  },
);

const measureConnectorCategoryGrid$ = command(({ set }, grid: HTMLElement) => {
  set(setConnectorCategoryGridMetrics$, {
    scrolledPast: Math.max(0, -grid.getBoundingClientRect().top),
    viewportHeight: window.innerHeight,
    columns: resolveColumns(grid),
  });
});

/**
 * Owns the grid's scroll and resize listeners while a category is open. The
 * listener is a capture-phase one on the window: the page scrolls an element
 * several layers above this grid, and scroll events do not bubble.
 */
export const bindConnectorCategoryGrid$ = onRef(
  command(({ set }, grid: HTMLElement, signal: AbortSignal) => {
    let scheduled = false;
    const measure = () => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      // Scroll and resize settle into one read per frame, taken against the
      // layout that frame is about to paint.
      animationFrame(
        () => {
          scheduled = false;
          set(measureConnectorCategoryGrid$, grid);
        },
        { signal },
      );
    };
    set(measureConnectorCategoryGrid$, grid);
    window.addEventListener("scroll", measure, {
      capture: true,
      passive: true,
      signal,
    });
    window.addEventListener("resize", measure, { signal });
    signal.addEventListener(
      "abort",
      () => {
        set(setConnectorCategoryGridMetrics$, emptyMetrics());
      },
      { once: true },
    );
  }),
);

/**
 * The slice of a `count`-connector category to mount, with the rows above and
 * below reported as the row spans the grid reserves without mounting a card.
 */
export function connectorCategoryGridWindow(
  count: number,
  metrics: ConnectorCategoryGridMetrics,
): ConnectorCategoryGridWindow {
  const columns = Math.max(1, metrics.columns);
  const totalRows = Math.ceil(count / columns);
  if (metrics.columns === 0 || metrics.viewportHeight === 0) {
    const rows = Math.min(totalRows, CONNECTOR_CATEGORY_GRID_FALLBACK_ROWS);
    return {
      startIndex: 0,
      endIndex: Math.min(count, rows * columns),
      leadingRows: 0,
      trailingRows: totalRows - rows,
    };
  }
  const pitch =
    CONNECTOR_CATEGORY_GRID_ROW_HEIGHT + CONNECTOR_CATEGORY_GRID_ROW_GAP;
  const firstVisibleRow = Math.floor(metrics.scrolledPast / pitch);
  const visibleRows = Math.max(1, Math.ceil(metrics.viewportHeight / pitch));
  const startRow = Math.max(
    0,
    firstVisibleRow - CONNECTOR_CATEGORY_GRID_OVERSCAN_ROWS,
  );
  const endRow = Math.min(
    totalRows,
    firstVisibleRow + visibleRows + CONNECTOR_CATEGORY_GRID_OVERSCAN_ROWS,
  );
  return {
    startIndex: startRow * columns,
    endIndex: Math.min(count, endRow * columns),
    leadingRows: startRow,
    trailingRows: totalRows - endRow,
  };
}
