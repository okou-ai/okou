import { command, computed, state } from "ccstate";
import { animationFrame } from "signal-timers";
import { onRef } from "../utils.ts";

function measureFilesViewport(
  viewport: HTMLElement,
  section: HTMLElement,
  list: HTMLElement | null,
) {
  const pageScrollTop = viewport.scrollTop;
  const origin =
    viewport.getBoundingClientRect().top + viewport.clientTop - pageScrollTop;
  const sectionTop = section.getBoundingClientRect().top - origin;
  const listTop = list ? list.getBoundingClientRect().top - origin : sectionTop;
  const toolbarHeight = Math.max(0, listTop - sectionTop);
  return {
    scrollTop: Math.max(0, pageScrollTop - sectionTop),
    clientHeight: Math.max(
      0,
      viewport.clientHeight - Math.max(toolbarHeight, listTop - pageScrollTop),
    ),
    sectionTop,
    pageScrollTop,
  };
}

/** Translate the Activity scrollport into the area below the sticky toolbar. */
export function createSandboxFilesScrollSignals() {
  const viewport$ = state<HTMLElement | null>(null);
  const section$ = state<HTMLElement | null>(null);
  const list$ = state<HTMLElement | null>(null);
  const metrics$ = state({
    scrollTop: 0,
    clientHeight: 0,
    sectionTop: 0,
    pageScrollTop: 0,
  });
  const measure$ = command(({ get, set }) => {
    const viewport = get(viewport$);
    const section = get(section$);
    if (!viewport || !section) {
      return get(metrics$);
    }
    const next = measureFilesViewport(viewport, section, get(list$));
    const previous = get(metrics$);
    if (
      previous.scrollTop !== next.scrollTop ||
      previous.clientHeight !== next.clientHeight ||
      previous.sectionTop !== next.sectionTop ||
      previous.pageScrollTop !== next.pageScrollTop
    ) {
      set(metrics$, next);
    }
    return next;
  });
  const scrollTo$ = command(({ get, set }, scrollTop: number) => {
    const viewport = get(viewport$);
    if (!viewport || !get(section$)) {
      set(metrics$, { ...get(metrics$), scrollTop: 0 });
      return;
    }
    const { sectionTop } = set(measure$);
    // A new folder returns to its toolbar without hiding Run information that
    // is already on screen. Saved list positions are relative to that toolbar.
    viewport.scrollTop =
      scrollTop > 0
        ? sectionTop + scrollTop
        : Math.min(viewport.scrollTop, sectionTop);
    set(measure$);
  });
  return {
    scrollViewport$: computed((get) => {
      return get(viewport$);
    }),
    focusTarget$: computed((get) => {
      return get(list$);
    }),
    scrollMetrics$: computed((get) => {
      return get(metrics$);
    }),
    scrollTo$,
    attachSection$: command(
      ({ get, set }, section: HTMLElement, signal: AbortSignal) => {
        set(section$, section);
        set(measure$);
        signal.addEventListener(
          "abort",
          () => {
            if (get(section$) === section) {
              set(section$, null);
            }
          },
          { once: true },
        );
      },
    ),
    setListRef$: onRef(
      command(({ get, set }, list: HTMLElement, signal: AbortSignal) => {
        set(list$, list);
        set(measure$);
        signal.addEventListener(
          "abort",
          () => {
            if (get(list$) === list) {
              set(list$, null);
            }
          },
          { once: true },
        );
      }),
    ),
    setScrollViewport$: onRef(
      command(({ get, set }, viewport: HTMLElement, signal: AbortSignal) => {
        set(viewport$, viewport);
        set(measure$);
        viewport.addEventListener(
          "scroll",
          () => {
            set(measure$);
          },
          { passive: true, signal },
        );
        const resize = () => {
          animationFrame(
            () => {
              set(measure$);
            },
            { signal },
          );
        };
        window.addEventListener("resize", resize, { signal });
        window.visualViewport?.addEventListener("resize", resize, { signal });
        signal.addEventListener(
          "abort",
          () => {
            if (get(viewport$) === viewport) {
              set(viewport$, null);
            }
            // The Files owner remembers its view during unmount. Do not replace
            // its last reading position with measurements of collapsing DOM.
          },
          { once: true },
        );
      }),
    ),
  };
}
