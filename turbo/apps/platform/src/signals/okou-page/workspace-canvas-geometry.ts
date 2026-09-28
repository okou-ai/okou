import { command } from "ccstate";
import { onRef } from "../utils.ts";

function writeCanvasGeometry(element: HTMLElement): void {
  // The canvas is the `::before` layer at `inset-0`, so it spans the padding
  // box: the border rect moved in by the border, at the client size.
  const rect = element.getBoundingClientRect();
  element.style.setProperty(
    "--okou-workspace-canvas-left",
    `${rect.left + element.clientLeft}px`,
  );
  element.style.setProperty(
    "--okou-workspace-canvas-top",
    `${rect.top + element.clientTop}px`,
  );
  element.style.setProperty(
    "--okou-workspace-canvas-width",
    `${element.clientWidth}px`,
  );
  element.style.setProperty(
    "--okou-workspace-canvas-height",
    `${element.clientHeight}px`,
  );
}

/**
 * Publishes where the workspace canvas sits in the viewport. A surface that
 * has to occlude scrolled content inside the pane repaints the canvas through
 * `WORKSPACE_CANVAS_BACKDROP_CLASS`, a fixed-attachment background that reads
 * this box, so its gradient lands on the pixels it covers instead of a flat
 * fill that stands out under a gradient palette.
 *
 * The observer catches the chat list resizing or hiding, which moves and
 * resizes the pane together; the window listener catches a viewport change
 * that only moves it.
 */
export const workspaceCanvasGeometryRef$ = onRef(
  command((_context, element: HTMLElement, signal: AbortSignal) => {
    writeCanvasGeometry(element);

    const observer = new ResizeObserver(() => {
      writeCanvasGeometry(element);
    });
    observer.observe(element);
    const onResize = () => {
      writeCanvasGeometry(element);
    };
    window.addEventListener("resize", onResize, { signal });

    signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
      },
      { once: true },
    );
  }),
);
