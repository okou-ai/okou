import { command, computed, state, type Command } from "ccstate";
import type { TabStripMotion } from "../browser/tab-strip.ts";
import { CHAT_THREAD_SIDEBAR_MIN_WIDTH } from "./chat-thread-sidebar-layout.ts";

const OWNER_SELECTOR = "[data-sidebar-layout-owner]";

function isWidthTransition(animation: Animation): boolean {
  return (
    "transitionProperty" in animation &&
    (animation.transitionProperty === "width" ||
      animation.transitionProperty === "flex-basis") &&
    animation.playState !== "finished" &&
    animation.playState !== "idle"
  );
}

function isStagedWidth(element: HTMLElement): boolean {
  if (element.dataset.sidebarLayoutStarting === undefined) {
    return false;
  }
  const style = getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.transitionProperty.split(",").some((property) => {
      return property.trim() === "width" || property.trim() === "all";
    }) &&
    style.transitionDuration.split(",").some((duration) => {
      return Number.parseFloat(duration) > 0;
    })
  );
}

/** A finite layout transaction includes both independently animated width owners. */
export function createThreadSidebarLayoutMotion(
  sync$: Command<void, [TabStripMotion | null]>,
) {
  const mountedRoot$ = state<HTMLDivElement | null>(null);
  const root$ = computed((get) => {
    return get(mountedRoot$);
  });
  const commit$ = command(({ get, set }): void => {
    const root = get(root$);
    if (!root) {
      return;
    }
    const owners = [...root.querySelectorAll<HTMLElement>(OWNER_SELECTOR)];
    // Committed direct gestures disable transitions on every geometry owner.
    const resizing =
      owners.length > 0 &&
      owners.every((element) => {
        return element.dataset.sidebarLayoutResizing === "true";
      });
    // Otherwise resolving styles materializes replacement CSS transitions,
    // including cancel followed by a new run. One terminal event cannot unlock.
    const moving =
      !resizing &&
      owners.some((element) => {
        const staged = isStagedWidth(element);
        return staged || element.getAnimations().some(isWidthTransition);
      });
    const panel = owners.find((element) => {
      return element.dataset.sidebarLayoutOwner === "panel";
    });
    // At xl the open split is flex-none and every width preference has a
    // 400px floor. Below xl the panel fills the row; use zero during motion.
    // Entry from zero retains zero through the lower-only runtime budget lock.
    const minimumWidth =
      moving && panel && getComputedStyle(panel).flexGrow === "0"
        ? Math.min(
            CHAT_THREAD_SIDEBAR_MIN_WIDTH,
            panel.getBoundingClientRect().width,
          )
        : 0;
    set(sync$, moving ? { minimumWidth } : null);
  });
  const mount$ = command(
    ({ get, set }, root: HTMLDivElement, signal: AbortSignal): void => {
      set(mountedRoot$, root);
      const transition = (event: TransitionEvent) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.matches(OWNER_SELECTOR) &&
          (event.propertyName === "width" ||
            event.propertyName === "flex-basis")
        ) {
          set(commit$);
        }
      };
      root.addEventListener("transitionrun", transition, { signal });
      root.addEventListener("transitionend", transition, { signal });
      root.addEventListener("transitioncancel", transition, { signal });
      const resize = () => {
        set(commit$);
      };
      window.addEventListener("resize", resize, { signal });
      window.visualViewport?.addEventListener("resize", resize, { signal });
      window
        .matchMedia("(prefers-reduced-motion: reduce)")
        .addEventListener("change", resize, { signal });
      signal.addEventListener(
        "abort",
        () => {
          if (get(root$) === root) {
            set(mountedRoot$, null);
          }
        },
        { once: true },
      );
      set(commit$);
    },
  );
  return { commit$, mount$, root$ };
}
