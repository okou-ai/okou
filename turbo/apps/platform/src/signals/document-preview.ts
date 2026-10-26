import { command } from "ccstate";
import { onRef } from "./utils.ts";

function preventDocumentPinch(event: Event): void {
  // Document previews do not own a zoom transform. Consume gestures delivered
  // to this surface before descendant or bubbling handlers interpret them.
  event.preventDefault();
  event.stopPropagation();
}

export const documentPreviewRef$ = onRef(
  command((_context, element: HTMLDivElement, signal: AbortSignal) => {
    // React wheel handlers are passive. The preview needs its own blocking
    // listener rather than relying on the route's viewport zoom policy.
    const options: AddEventListenerOptions = {
      capture: true,
      passive: false,
      signal,
    };
    element.addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey) {
          preventDocumentPinch(event);
        }
      },
      options,
    );
    element.addEventListener("gesturestart", preventDocumentPinch, options);
    element.addEventListener("gesturechange", preventDocumentPinch, options);
  }),
);
