import { command, computed, state, type Command } from "ccstate";
import { i18n } from "../../i18n/index.ts";
import { onDomEventFn, onRef, waitForBrowserPaint } from "../utils.ts";

const mountedMeasurements$ = state<ReadonlySet<Command<void, []>>>(new Set());

/** Width-changing workspace commands call this after their own paint wait. */
export const refreshComposerTaskOverflow$ = command(({ get, set }) => {
  for (const measure$ of get(mountedMeasurements$)) {
    set(measure$);
  }
});

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
      // Choices keep their order; the leading ones that fit stay outside More.
      // The trigger shrinks with its hidden count. Measure all candidates in
      // one pass instead of letting the previous stack determine the next fit.
      let usedWidth = 0;
      let visibleCount = 0;
      for (const [position, width] of widths.entries()) {
        const moreWidth = moreWidths[items.length - position - 1];
        if (moreWidth !== undefined && usedWidth + moreWidth <= available) {
          visibleCount = position;
        }
        usedWidth += width + gap;
      }
      for (let index = 0; index < visibleCount; index++) {
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
  const refresh$ = command(async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const root = get(root$);
    if (!root) {
      return;
    }
    await waitForBrowserPaint(signal);
    signal.throwIfAborted();
    if (get(root$) === root) {
      set(measure$);
    }
  });
  const bindRoot$ = onRef(
    command(async ({ get, set }, root: HTMLElement, signal: AbortSignal) => {
      set(root$, root);
      set(
        mountedMeasurements$,
        new Set([...get(mountedMeasurements$), measure$]),
      );
      const measure = onDomEventFn(() => {
        return set(refresh$, signal);
      });
      window.addEventListener("resize", measure, { signal });
      window.addEventListener(
        "transitionend",
        (event) => {
          if (event.target instanceof Element && event.target.contains(root)) {
            measure(event);
          }
        },
        { capture: true, signal },
      );
      // Web fonts can change intrinsic label widths without a window resize.
      document.fonts.addEventListener("loadingdone", measure, { signal });
      i18n.on("languageChanged", measure);
      signal.addEventListener(
        "abort",
        () => {
          i18n.off("languageChanged", measure);
          if (get(root$) === root) {
            set(root$, null);
            const mounted = new Set(get(mountedMeasurements$));
            mounted.delete(measure$);
            set(mountedMeasurements$, mounted);
          }
        },
        { once: true },
      );
      await set(refresh$, signal);
    }),
  );
  return { hiddenTaskIndices$, measure$, bindRoot$ };
}
