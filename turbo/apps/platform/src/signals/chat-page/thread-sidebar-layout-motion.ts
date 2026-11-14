import { command, computed, state, type Command } from "ccstate";
import type { TabStripMotion } from "../browser/tab-strip.ts";
import { CHAT_THREAD_SIDEBAR_MIN_WIDTH } from "./chat-thread-sidebar-layout.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../../views/okou-page/sidebar-breakpoint.ts";

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

function canTransitionWidth(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.transitionProperty.split(",").some((property) => {
      return ["width", "flex-basis", "all"].includes(property.trim());
    }) &&
    style.transitionDuration.split(",").some((duration) => {
      return Number.parseFloat(duration) > 0;
    })
  );
}

interface ChatListIntent {
  readonly token: object;
  readonly opening: boolean;
  readonly painted: boolean;
}

function isChatListStaged(
  intent: ChatListIntent | null,
  owners: readonly HTMLElement[],
): boolean {
  if (
    !intent ||
    !window.matchMedia(SIDEBAR_DESKTOP_MEDIA_QUERY).matches ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return false;
  }
  if (!intent.painted) {
    return owners.some(canTransitionWidth);
  }
  const list = owners.find((element) => {
    return element.dataset.sidebarLayoutOwner === "chat-list";
  });
  return (
    list !== undefined &&
    canTransitionWidth(list) &&
    (intent.opening
      ? list.getBoundingClientRect().width <= 1
      : list.getBoundingClientRect().width > 1)
  );
}

/** A finite layout transaction includes both independently animated width owners. */
export function createThreadSidebarLayoutMotion(
  sync$: Command<void, [TabStripMotion | null]>,
) {
  const mountedRoot$ = state<HTMLDivElement | null>(null);
  const chatListIntent$ = state<ChatListIntent | null>(null);
  const root$ = computed((get) => {
    return get(mountedRoot$);
  });
  const commit$ = command(({ get, set }, preparation?: object): void => {
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
    let intent = get(chatListIntent$);
    if (intent && intent.token === preparation) {
      intent = { ...intent, painted: true };
      set(chatListIntent$, intent);
    }
    // Hold the semantic action before its own paint, then only bridge a
    // still-staged list. Positive opening geometry need not equal the stored
    // preference (responsive layouts can clamp it). Native animations below
    // own completion once they exist; absent/mobile/no-motion lists settle.
    const approachingTarget = !resizing && isChatListStaged(intent, owners);
    const nativeMotion = owners.some((element) => {
      return element.getAnimations().some(isWidthTransition);
    });
    if (!approachingTarget || (intent?.painted && nativeMotion)) {
      set(chatListIntent$, null);
    }
    // Resolving styles materializes replacement CSS transitions, including
    // cancel followed by a new run. One terminal event cannot unlock the row.
    const moving =
      !resizing &&
      (approachingTarget ||
        nativeMotion ||
        owners.some((element) => {
          return (
            element.dataset.sidebarLayoutStarting !== undefined &&
            canTransitionWidth(element)
          );
        }));
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
  const prepareChatList$ = command(
    ({ set }, targetWidth: number, resizing: boolean): object => {
      const token = {};
      set(
        chatListIntent$,
        resizing ? null : { token, opening: targetWidth > 0, painted: false },
      );
      set(commit$);
      return token;
    },
  );
  const cancelChatList$ = command(({ get, set }, preparation: object): void => {
    if (get(chatListIntent$)?.token !== preparation) {
      return;
    }
    set(chatListIntent$, null);
    // The caller retired its intent, not the shell's native width motion.
    set(commit$);
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
            set(chatListIntent$, null);
          }
        },
        { once: true },
      );
      set(commit$);
    },
  );
  return { prepareChatList$, cancelChatList$, commit$, mount$, root$ };
}
