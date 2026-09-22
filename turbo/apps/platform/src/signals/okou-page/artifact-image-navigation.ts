import { command } from "ccstate";
import { onDomEventFn, onRef } from "../utils.ts";
import { lightboxDialogVisible$ } from "./attachment-chips.ts";

function isEditableElementFocused(doc: Document): boolean {
  const active = doc.activeElement;
  return (
    active instanceof HTMLElement &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.tagName === "SELECT" ||
      active.isContentEditable)
  );
}

function createImageNavigationRef(surface: "lightbox" | "sidebar") {
  return onRef(
    command(({ get }, element: HTMLElement, signal: AbortSignal) => {
      const doc = element.ownerDocument;
      doc.addEventListener(
        "keydown",
        onDomEventFn((event: KeyboardEvent) => {
          if (
            (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
            event.defaultPrevented ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          ) {
            return;
          }

          if (surface === "sidebar") {
            // Even a lightbox without navigation owns the keyboard. Only the
            // ordinary sidebar yields arrows to a focused editable control.
            if (
              get(lightboxDialogVisible$) ||
              (element.dataset.imageNavigationFullscreen !== "true" &&
                isEditableElementFocused(doc))
            ) {
              return;
            }
          }

          const direction = event.key === "ArrowLeft" ? "previous" : "next";
          const button = element.querySelector<HTMLButtonElement>(
            `button[data-image-navigation="${direction}"]`,
          );
          if (!button || button.disabled) {
            return;
          }

          // React keeps the mounted button's action current, including the
          // loadable's pending/error/refresh behavior. Do not capture navigation
          // targets here or wait for their data during a key event.
          event.preventDefault();
          button.click();
        }),
        { capture: surface === "lightbox", signal },
      );
    }),
  );
}

export const bindLightboxImageNavigation$ =
  createImageNavigationRef("lightbox");
export const bindSidebarImageNavigation$ = createImageNavigationRef("sidebar");
