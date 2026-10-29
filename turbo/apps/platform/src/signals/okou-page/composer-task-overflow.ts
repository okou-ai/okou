import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";

/** Intrinsic chip widths decide which choices belong in More. */
export function createComposerTaskOverflowSignals() {
  const root$ = state<HTMLElement | null>(null);
  const hidden$ = state<readonly number[]>([]);
  const hiddenTaskIndices$ = computed((get) => {
    return get(hidden$);
  });
  const measure$ = command(({ get, set }) => {
    const root = get(root$);
    if (!root || root.clientWidth === 0) {
      return;
    }
    const sizing = root.querySelector<HTMLElement>("[data-task-sizing]");
    if (!sizing) {
      return;
    }
    const items = Array.from(
      sizing.querySelectorAll<HTMLElement>("[data-task-sizing-item]"),
    );
    const moreWidths = Array.from(
      sizing.querySelectorAll<HTMLElement>("[data-more-sizing]"),
      (item) => {
        return item.getBoundingClientRect().width;
      },
    );
    const style = getComputedStyle(sizing);
    const gap = Number.parseFloat(style.columnGap);
    const padding =
      Number.parseFloat(style.paddingLeft) +
      Number.parseFloat(style.paddingRight);
    const widths = items.map((item) => {
      return item.getBoundingClientRect().width;
    });
    const total =
      widths.reduce((sum, width) => {
        return sum + width;
      }, padding) +
      gap * Math.max(0, items.length - 1);
    const visible = new Set<number>();
    if (total <= root.clientWidth) {
      for (const index of items.keys()) {
        visible.add(index);
      }
    } else {
      const available = root.clientWidth - padding;
      // Suggestions stays outside More whenever it fits. The remaining choices
      // retain their original order, including Tasks when that rollout is on.
      const priority = items.findIndex((item) => {
        return item.dataset.priority !== undefined;
      });
      const order = items.map((_, index) => {
        return index;
      });
      if (priority !== -1) {
        order.splice(priority, 1);
        order.unshift(priority);
      }
      // The trigger shrinks with its hidden count. Measure all candidates in
      // one pass instead of letting the previous stack determine the next fit.
      let usedWidth = 0;
      let visibleCount = 0;
      for (const [position, index] of order.entries()) {
        const moreWidth = moreWidths[items.length - position - 1];
        if (moreWidth !== undefined && usedWidth + moreWidth <= available) {
          visibleCount = position;
        }
        const width = widths[index];
        if (width === undefined) {
          break;
        }
        usedWidth += width + gap;
      }
      for (const index of order.slice(0, visibleCount)) {
        visible.add(index);
      }
    }
    const hidden = items
      .map((_, index) => {
        return index;
      })
      .filter((index) => {
        return !visible.has(index);
      });
    const previous = get(hidden$);
    if (
      hidden.length !== previous.length ||
      hidden.some((index, i) => {
        return index !== previous[i];
      })
    ) {
      set(hidden$, hidden);
    }
  });
  const bindRoot$ = onRef(
    command(({ get, set }, root: HTMLElement, signal: AbortSignal) => {
      set(root$, root);
      const measure = () => {
        return set(measure$);
      };
      window.addEventListener("resize", measure, { signal });
      window.addEventListener(
        "transitionend",
        (event) => {
          if (event.target instanceof Element && event.target.contains(root)) {
            measure();
          }
        },
        { capture: true, signal },
      );
      // Web fonts can change intrinsic label widths without a window resize.
      document.fonts.addEventListener("loadingdone", measure, { signal });
      signal.addEventListener(
        "abort",
        () => {
          if (get(root$) === root) {
            set(root$, null);
          }
        },
        { once: true },
      );
    }),
  );
  return { hiddenTaskIndices$, measure$, bindRoot$ };
}
