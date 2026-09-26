import type { MouseEvent } from "react";

/** Whether a link activation belongs to the current app browsing context. */
export function shouldHandleLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
): boolean {
  const target = event.currentTarget.target;
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (!target || target === "_self") &&
    !event.currentTarget.hasAttribute("download")
  );
}
