import type { ReactNode } from "react";
import { cn } from "@okouai/ui";

/**
 * Repaints the workspace canvas behind a surface that has to occlude scrolled
 * content, such as a sticky toolbar. A flat fill cannot stand in for the canvas
 * under a gradient palette, where it is `--card` plus two corner gradients
 * sized to the pane. The inner layer is a fixed box anchored to
 * `WorkspaceInset`, so it paints the canvas at exactly the pane's position and
 * size, and the host's clip keeps only the part behind the host. The layer
 * follows the pane through sidebar and viewport changes with no measurement.
 *
 * The wrapper's own flat fill is a presentational fallback for browsers
 * without CSS anchor positioning (Safari before 26): there the anchored layer
 * collapses, and the host keeps occluding scrolled content with the canvas
 * fill rather than turning transparent. Where anchors work, the opaque layer
 * covers it. Remove it once the supported browser floor includes anchor
 * positioning.
 *
 * Mount it as the first child of a `relative isolate` host; `className` lets
 * the host mask the layer, as the toolbar fade does.
 */
export function WorkspaceCanvasBackdrop({
  className = "",
}: {
  readonly className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 -z-1 bg-workspace-canvas [clip-path:inset(0)] ${className}`}
    >
      <div className="fixed left-[anchor(left)] top-[anchor(top)] h-[anchor-size(height)] w-[anchor-size(width)] bg-workspace-canvas bg-workspace-canvas-image bg-[length:100%_100%] [position-anchor:--workspace-canvas]" />
    </div>
  );
}

/**
 * The workspace pane's leading corners inside the shell's sheet. The sheet owns
 * the frame and exposes the chat list's state as `data-chat-list` on the
 * `workspace-sheet` group; the pane meets the sheet's leading corners only
 * while the list is collapsed, because otherwise the list holds them.
 */
export const SHEET_PANE_LEADING_CORNERS =
  "md:group-data-[chat-list=collapsed]/workspace-sheet:rounded-l-2xl";

/** A pane that ends the sheet always meets its trailing corners. */
export const SHEET_PANE_CORNERS =
  "md:rounded-r-2xl md:group-data-[chat-list=collapsed]/workspace-sheet:rounded-l-2xl";

// Kept outside `cn()`: the class merger reads both background utilities as
// colours and would drop the fill in favour of the gradient.
const CANVAS_PAINT =
  "before:absolute before:inset-0 before:-z-1 before:bg-workspace-canvas before:bg-workspace-canvas-image before:bg-[length:100%_100%] before:content-[''] bg-background [anchor-name:--workspace-canvas]";

/**
 * The workspace pane: the app's canvas. Inside the app shell it is the
 * trailing part of the workspace sheet, which owns the margin, hairline and
 * corners (`sheet`). A page with no shell frames the pane itself on all four
 * sides (`standalone`). A shell-owned frame that already paints the canvas
 * leaves the pane transparent and supplies its corners (`transparent`).
 */
export function WorkspaceInset({
  surface = "sheet",
  children,
  className,
}: {
  readonly surface?: "sheet" | "standalone" | "transparent";
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const layout = cn(
    "relative z-0 flex min-h-0 min-w-0 flex-1 flex-col md:overflow-clip",
    surface === "standalone" &&
      "md:m-2 md:rounded-2xl md:border md:border-border",
    surface === "sheet" && SHEET_PANE_CORNERS,
    surface === "transparent" && "bg-transparent",
    className,
  );
  return (
    <div
      className={
        surface === "transparent" ? layout : `${layout} ${CANVAS_PAINT}`
      }
      data-testid="workspace-inset"
      // Which frame the pane is drawn in, readable as data rather than
      // inferred from the margin utility.
      data-surface={surface}
    >
      {children}
    </div>
  );
}
