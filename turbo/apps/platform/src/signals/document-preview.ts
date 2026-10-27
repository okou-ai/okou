import { command } from "ccstate";
import { onRef } from "./utils.ts";

function preventDocumentPinch(event: Event): void {
  // Document previews do not own a zoom transform. Consume gestures delivered
  // to this surface before descendant or bubbling handlers interpret them.
  event.preventDefault();
  event.stopPropagation();
}

function bindDocumentPreviewGestures(
  element: HTMLElement | Document,
  signal: AbortSignal,
): void {
  // React wheel handlers are passive. The preview needs its own blocking
  // listener rather than relying on the route's viewport zoom policy.
  const options: AddEventListenerOptions = {
    capture: true,
    passive: false,
    signal,
  };
  element.addEventListener(
    "wheel",
    (event: Event) => {
      if ("ctrlKey" in event && event.ctrlKey) {
        preventDocumentPinch(event);
      }
    },
    options,
  );
  element.addEventListener("gesturestart", preventDocumentPinch, options);
  element.addEventListener("gesturechange", preventDocumentPinch, options);
}

export const documentPreviewRef$ = onRef(
  command((_context, element: HTMLDivElement, signal: AbortSignal) => {
    bindDocumentPreviewGestures(element, signal);
  }),
);

export const wordDocumentFrameRef$ = onRef(
  command((_context, frame: HTMLIFrameElement, signal: AbortSignal) => {
    const fitContents = () => {
      const content = frame.contentDocument;
      if (!content?.body) {
        return;
      }
      const viewportWidth = String(frame.clientWidth);
      if (
        frame.clientWidth === 0 ||
        content.body.dataset.previewFitWidth === viewportWidth
      ) {
        return;
      }
      // Fit only when the container width changes. Reattaching a React ref
      // must not reset the document's scale or scroll position.
      content.body.style.zoom = "1";
      const width = content.body.scrollWidth;
      if (width > 0) {
        content.body.style.zoom = String(
          Math.min(1, content.documentElement.clientWidth / width),
        );
        content.body.dataset.previewFitWidth = viewportWidth;
      }
    };
    const observer = new ResizeObserver(fitContents);
    observer.observe(frame);
    signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
      },
      { once: true },
    );
    const bindContent = () => {
      const content = frame.contentDocument;
      if (content === null) {
        throw new Error("Word preview must remain in its owned document");
      }
      bindDocumentPreviewGestures(content, signal);
      content.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            // Keyboard events do not bubble across documents. Let the owning
            // dialog handle dismissal through its normal event boundary.
            const forwarded = new KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
              cancelable: true,
            });
            frame.dispatchEvent(forwarded);
            if (forwarded.defaultPrevented) {
              event.preventDefault();
            }
          }
        },
        { signal },
      );
      content.addEventListener(
        "click",
        (event) => {
          const target = event.target;
          const elementClass = content.defaultView?.Element;
          if (!elementClass || !(target instanceof elementClass)) {
            return;
          }
          const href = target.closest("a")?.getAttribute("href");
          if (href?.startsWith("#")) {
            event.preventDefault();
            content.getElementById(href.slice(1))?.scrollIntoView();
          }
        },
        { signal },
      );
      // Until this document has its listener, input stays on the guarded
      // parent surface, including during the iframe's initial load.
      fitContents();
      frame.dataset.previewReady = "true";
    };
    frame.addEventListener("load", bindContent, { signal });
    // React may reattach the composed focus ref without navigating the iframe.
    if (frame.dataset.previewReady === "true") {
      bindContent();
    }
  }),
);
