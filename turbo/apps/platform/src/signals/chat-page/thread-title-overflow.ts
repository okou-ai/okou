import { command } from "ccstate";
import { onRef } from "../utils.ts";

/**
 * Titles travel at one speed instead of in one duration, so a barely clipped
 * title and a heavily clipped one read as the same gesture rather than one
 * crawling and the other flashing past.
 */
const TITLE_SCROLL_PX_PER_SECOND = 37;
const MIN_TITLE_SCROLL_MS = 780;
const MAX_TITLE_SCROLL_MS = 4200;

function titleScrollDurationMs(distance: number): number {
  return Math.round(
    Math.min(
      MAX_TITLE_SCROLL_MS,
      Math.max(
        MIN_TITLE_SCROLL_MS,
        (distance / TITLE_SCROLL_PX_PER_SECOND) * 1000,
      ),
    ),
  );
}

function writeTitleOverflow(element: HTMLElement): void {
  const distance = element.scrollWidth - element.clientWidth;
  element.style.setProperty("--okou-nav-title-overflow", `${distance}px`);
  element.style.setProperty(
    "--okou-nav-title-duration",
    `${titleScrollDurationMs(distance)}ms`,
  );
}

/**
 * Publishes how much of a thread title is cut off. The stylesheet
 * derives both the fade mask and the hover travel from that one number, so a
 * title that fits gets neither without a second code path.
 *
 * The observer watches the box for container width changes and the text for
 * renames and late web-font metrics. Neither remounts the element, so the ref
 * on its own would leave a stale distance behind.
 */
export const threadTitleOverflowRef$ = onRef(
  command((_context, element: HTMLElement, signal: AbortSignal) => {
    writeTitleOverflow(element);

    const observer = new ResizeObserver(() => {
      writeTitleOverflow(element);
    });
    observer.observe(element);
    const text = element.firstElementChild;
    if (text) {
      observer.observe(text);
    }

    signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
      },
      { once: true },
    );
  }),
);
