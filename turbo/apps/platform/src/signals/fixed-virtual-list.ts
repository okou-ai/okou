import { command, computed, state } from "ccstate";
import { animationFrame } from "signal-timers";
import { onRef } from "./utils.ts";

interface FixedVirtualScrollMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
}
const FIXED_VIRTUAL_OVERSCAN = 8;
const SCROLL_VIEWPORT_LAYOUT_EVENT = "okou-sidebar-layout-change";
function emptyScrollMetrics(): FixedVirtualScrollMetrics {
  return { scrollTop: 0, clientHeight: 0 };
}

export function createFixedVirtualScrollSignals(
  restoreScrollPosition: boolean,
) {
  const internalViewport$ = state<HTMLElement | null>(null);
  const resizeScheduled$ = state(false);
  const internalScrollMetrics$ =
    state<FixedVirtualScrollMetrics>(emptyScrollMetrics());

  const scrollViewport$ = computed((get) => {
    return get(internalViewport$);
  });
  const scrollMetrics$ = computed((get) => {
    return get(internalScrollMetrics$);
  });
  const isScrolled$ = computed((get) => {
    return get(internalScrollMetrics$).scrollTop > 0;
  });

  const measureScrollViewport$ = command(
    ({ get, set }, viewport: HTMLElement) => {
      const metrics = {
        scrollTop: viewport.scrollTop,
        clientHeight: viewport.clientHeight,
      };
      const previous = get(internalScrollMetrics$);
      if (
        previous.scrollTop === metrics.scrollTop &&
        previous.clientHeight === metrics.clientHeight
      ) {
        return;
      }
      set(internalScrollMetrics$, metrics);
    },
  );
  const scheduleViewportMeasurement$ = command(
    ({ get, set }, viewport: HTMLElement, signal: AbortSignal) => {
      if (get(resizeScheduled$)) {
        return;
      }
      set(resizeScheduled$, true);
      // Layout refs and window resize events share one pending measurement.
      // Read after the DOM commit, using the latest layout in this frame.
      animationFrame(
        () => {
          set(resizeScheduled$, false);
          set(measureScrollViewport$, viewport);
        },
        { signal },
      );
    },
  );
  const refreshScrollViewport$ = command(({ get }) => {
    // A layout change is only a notification. The mounted viewport supplies
    // the lifetime for the measurement, including when a sibling unmounts.
    get(internalViewport$)?.dispatchEvent(
      new Event(SCROLL_VIEWPORT_LAYOUT_EVENT),
    );
  });
  const clearScrollViewport$ = command(
    ({ get, set }, viewport: HTMLElement) => {
      if (get(internalViewport$) !== viewport) {
        return;
      }
      set(internalViewport$, null);
      set(resizeScheduled$, false);
      if (!restoreScrollPosition) {
        set(internalScrollMetrics$, emptyScrollMetrics());
      }
    },
  );
  const setScrollViewport$ = onRef(
    command(({ get, set }, viewport: HTMLElement, signal: AbortSignal) => {
      if (restoreScrollPosition) {
        viewport.scrollTop = get(internalScrollMetrics$).scrollTop;
      }
      set(internalViewport$, viewport);
      set(resizeScheduled$, false);
      set(measureScrollViewport$, viewport);
      const observer = new ResizeObserver(() => {
        set(scheduleViewportMeasurement$, viewport, signal);
      });
      observer.observe(viewport);
      window.addEventListener(
        "resize",
        () => {
          set(scheduleViewportMeasurement$, viewport, signal);
        },
        { signal },
      );
      viewport.addEventListener(
        SCROLL_VIEWPORT_LAYOUT_EVENT,
        () => {
          set(scheduleViewportMeasurement$, viewport, signal);
        },
        { signal },
      );
      signal.addEventListener(
        "abort",
        () => {
          observer.disconnect();
          set(clearScrollViewport$, viewport);
        },
        { once: true },
      );
    }),
  );
  const setScrollMetrics$ = command(
    ({ set }, metrics: FixedVirtualScrollMetrics) => {
      set(internalScrollMetrics$, metrics);
    },
  );

  return {
    isScrolled$,
    scrollViewport$,
    scrollMetrics$,
    setScrollViewport$,
    setScrollMetrics$,
    refreshScrollViewport$,
  };
}

export function getFixedVirtualRange({
  itemCount,
  scrollTop,
  viewportHeight,
  rowHeight,
}: {
  itemCount: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
}) {
  const requestedFirstVisibleIndex = Math.floor(
    Math.max(0, scrollTop) / rowHeight,
  );
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const firstVisibleIndex = Math.min(
    requestedFirstVisibleIndex,
    Math.max(0, itemCount - visibleCount),
  );
  const startIndex = Math.max(0, firstVisibleIndex - FIXED_VIRTUAL_OVERSCAN);
  const endIndex = Math.min(
    itemCount,
    firstVisibleIndex + visibleCount + FIXED_VIRTUAL_OVERSCAN,
  );

  return { startIndex, endIndex };
}
