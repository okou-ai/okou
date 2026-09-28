import { useSet } from "ccstate-react";
import type { ReactNode } from "react";
import { workspaceCanvasGeometryRef$ } from "../../signals/okou-page/workspace-canvas-geometry.ts";

/**
 * Repaints the workspace canvas under a surface that has to occlude scrolled
 * content, such as a sticky toolbar. A plain fill cannot stand in for the
 * canvas under a gradient palette, where it is `--card` plus two corner
 * gradients; this paints both, fixed to the viewport and sized and placed at
 * the box `WorkspaceInset` publishes, so the surface matches the pixels it
 * covers in every theme.
 */
export const WORKSPACE_CANVAS_BACKDROP_CLASS =
  "bg-workspace-canvas bg-workspace-canvas-image bg-fixed bg-no-repeat bg-position-[var(--okou-workspace-canvas-left)_var(--okou-workspace-canvas-top)] bg-size-[var(--okou-workspace-canvas-width)_var(--okou-workspace-canvas-height)]";

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
  const measureCanvas = useSet(workspaceCanvasGeometryRef$);

  return (
    <div
      ref={measureCanvas}
      className={`relative z-0 before:absolute before:inset-0 before:-z-1 before:bg-workspace-canvas before:bg-workspace-canvas-image before:bg-[length:100%_100%] before:content-[''] flex min-h-0 min-w-0 flex-1 flex-col bg-background md:m-2 md:overflow-hidden md:rounded-xl md:border md:border-border ${
        beside === "chat-list" ? "md:ml-0" : ""
      }`}
      data-testid="workspace-inset"
      // The chrome the sheet is framed against, so the rendered layout case is
      // readable as data rather than inferred from the margin utility.
      data-beside={beside}
    >
      {children}
    </div>
  );
}
