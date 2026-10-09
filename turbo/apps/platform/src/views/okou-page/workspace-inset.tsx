import type { ReactNode } from "react";
import { useGet } from "ccstate-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";

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
 * The workspace sheet: the app's canvas, framed by the chrome around it. The
 * chat list supplies the left edge in the app shell, so the sheet drops that
 * margin there; beside the bare nav rail -- or with no chrome at all -- nothing
 * supplies it, so the sheet keeps the frame on all four sides.
 */
export function WorkspaceInset({
  beside = "chat-list",
  children,
}: {
  readonly beside?: "chat-list" | "nav-rail" | "nothing";
  readonly children: ReactNode;
}) {
  const fixedLayout =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatComposerLayout];

  return (
    <div
      className={`relative z-0 before:absolute before:inset-0 before:-z-1 before:bg-workspace-canvas before:bg-workspace-canvas-image before:bg-[length:100%_100%] before:content-[''] flex min-h-0 min-w-0 flex-1 flex-col bg-background md:m-2 md:rounded-xl md:border md:border-border [anchor-name:--workspace-canvas] ${
        fixedLayout ? "md:overflow-clip" : "md:overflow-hidden"
      } ${beside === "chat-list" ? "md:ml-0" : ""}`}
      data-testid="workspace-inset"
      // The chrome the sheet is framed against, so the rendered layout case is
      // readable as data rather than inferred from the margin utility.
      data-beside={beside}
    >
      {children}
    </div>
  );
}
