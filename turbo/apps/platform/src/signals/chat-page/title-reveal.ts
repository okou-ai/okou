import { command } from "ccstate";

const TITLE_SCROLL_PX_PER_SECOND = 37;
const TITLE_SELECTOR = "[data-title-reveal]";

/**
 * Sample pacing at input time, before enabling the CSS transition. CSS owns the
 * live distance and mask, including renames, font loads and layout changes.
 * The sampled speed assumes that geometry stays unchanged during the reveal.
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
  title.style.setProperty(
    "--okou-nav-title-duration",
    `${(distance / TITLE_SCROLL_PX_PER_SECOND) * 1000}ms`,
  );
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
