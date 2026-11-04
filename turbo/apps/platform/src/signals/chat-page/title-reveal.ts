import { command } from "ccstate";

const TITLE_REVEAL_MS_PER_PX = 12.5;
const TITLE_REVEAL_MIN_DURATION_MS = 780;
const TITLE_REVEAL_MAX_DURATION_MS = 3000;
const TITLE_SELECTOR = "[data-title-reveal]";

/**
 * Sample pacing at input time, before enabling the CSS transition. CSS owns the
 * live distance and mask, including renames, font loads and layout changes.
 * Easing shapes velocity; bounded duration keeps long labels responsive.
 */
export const startTitleReveal$ = command((_context, control: HTMLElement) => {
  const title = control.querySelector<HTMLElement>(TITLE_SELECTOR);
  const text = title?.firstElementChild;
  if (!title || !text || Object.hasOwn(title.dataset, "titleRevealing")) {
    return;
  }

  const distance = Math.max(
    0,
    text.getBoundingClientRect().width - title.getBoundingClientRect().width,
  );
  const duration =
    distance > 0
      ? Math.min(
          TITLE_REVEAL_MAX_DURATION_MS,
          Math.max(
            TITLE_REVEAL_MIN_DURATION_MS,
            distance * TITLE_REVEAL_MS_PER_PX,
          ),
        )
      : 0;
  title.style.setProperty("--okou-nav-title-duration", `${duration}ms`);
  // A hover selector would already start a transition when the layout read
  // flushes styles, before its measured duration is available.
  title.dataset.titleRevealing = "";
});

export const endTitleReveal$ = command((_context, control: HTMLElement) => {
  // Pointer and keyboard focus are independent reasons to keep the end visible.
  // Native :hover also preserves the existing coarse-pointer sticky hover.
  if (control.matches(":hover, :focus-visible")) {
    return;
  }
  const title = control.querySelector<HTMLElement>(TITLE_SELECTOR);
  if (title) {
    delete title.dataset.titleRevealing;
  }
});
