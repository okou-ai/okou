import { command, computed, state, type Command, type Computed } from "ccstate";
import { logger } from "../log.ts";
import {
  onDomEventFn,
  onRef,
  waitForBrowserPaint,
  waitLoopUntil,
} from "../utils.ts";
import type { ChatEventSignals } from "./chat-event-signals.ts";

import { visibleTranscriptSpacer } from "./chat-transcript-pages.ts";

const L = logger("AutoScroll");
const AT_BOTTOM_THRESHOLD_PX = 10;
const SCROLL_ANCHOR_ATTRIBUTE = "data-chat-scroll-anchor-event-id";
const SCROLL_ANCHOR_ALIASES_ATTRIBUTE =
  "data-chat-scroll-anchor-alias-event-ids";

export interface ThreadScrollPosition {
  readonly targetEventId: string;
  readonly viewportOffsetTop: number;
}

export interface ScrollToEventOptions {
  readonly behavior: ScrollBehavior;
  /** Where the event lands, as a fraction of the viewport height from its top. */
  readonly viewportRatio: number;
  readonly preloadPreviousRenderWindow: boolean;
}

export interface ChatThreadScrollSignals {
  readonly scrollContainerOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly scrollContentOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  /** The mounted scroll viewport, for readers that measure it themselves. */
  readonly scrollContainer$: Computed<HTMLElement | null>;
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  readonly awayFromBottom$: Computed<boolean>;
  readonly isProgrammaticScrollEvent$: Command<boolean, [EventTarget | null]>;
  readonly readCapturedThreadScrollPosition$: Command<
    ThreadScrollPosition | null,
    []
  >;
  readonly readRenderedThreadScrollPosition$: Command<
    ThreadScrollPosition | null,
    [excludedAnchorAncestors?: string]
  >;
  readonly autoScroll$: Command<
    Promise<void>,
    [ThreadScrollPosition | null, AbortSignal]
  >;
  readonly scrollToEvent$: Command<
    Promise<void>,
    [string, ScrollToEventOptions, AbortSignal]
  >;
  readonly scrollTo$: Command<void, [ThreadScrollPosition]>;
  readonly scrollToTop$: Command<Promise<void>, [AbortSignal]>;
  readonly scrollToBottom$: Command<Promise<void>, [AbortSignal]>;
  readonly restoreScrollPosition$: Command<Promise<void>, [AbortSignal]>;
  readonly restoreScrollPositionForLayout$: Command<
    Promise<void>,
    [AbortSignal]
  >;
  readonly hasPreservedHiddenLayout$: Command<boolean, []>;
  readonly preserveHiddenLayout$: Command<void, []>;
  readonly restoreHiddenLayout$: Command<Promise<void>, [AbortSignal]>;
}

const threadScrollPositions$ = state(new Map<string, ThreadScrollPosition>());

interface ThreadScrollPositionSignals {
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  readonly awayFromBottom$: Computed<boolean>;
}

interface ChatThreadScrollRenderWindow {
  readonly awaitingAnchor$: Computed<boolean>;
  readonly tailMounted$: Computed<boolean>;
  readonly positionInSpacer$: Command<
    ThreadScrollPosition | null,
    [HTMLElement]
  >;
  readonly afterThreadScrollPositionChanged$: Command<
    Promise<void>,
    [AbortSignal]
  >;
  readonly preloadPreviousRenderWindowForEvent$: Command<
    Promise<void>,
    [string, AbortSignal]
  >;
  /** Prepends earlier groups to the window; resolves whether any were added. */
  readonly loadEarlierGroups$: Command<Promise<boolean>, [AbortSignal]>;
}

/**
 * Read-only view of a thread's held scroll position. Derived from module
 * state, so it can be created before the scroll signals themselves — the
 * render window is computed from it, while the commands that write the
 * position are wired to run the window's ensure step afterwards.
 */
export function createThreadScrollPositionSignals(
  threadId: string,
): ThreadScrollPositionSignals {
  const threadScrollPosition$ = computed((get) => {
    return get(threadScrollPositions$).get(threadId) ?? null;
  });
  const awayFromBottom$ = computed((get) => {
    return get(threadScrollPosition$) !== null;
  });
  return { threadScrollPosition$, awayFromBottom$ };
}

function isAtBottom(container: HTMLElement): boolean {
  return (
    container.scrollHeight - container.scrollTop - container.clientHeight <=
    AT_BOTTOM_THRESHOLD_PX
  );
}

function scrollAnchors(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(`[${SCROLL_ANCHOR_ATTRIBUTE}]`),
  );
}

function scrollAnchorForEvent(
  container: HTMLElement,
  eventId: string,
): HTMLElement | null {
  const anchor = scrollAnchors(container).find((candidate) => {
    return candidate.getAttribute(SCROLL_ANCHOR_ATTRIBUTE) === eventId;
  });
  if (anchor) {
    return anchor;
  }
  // A projection can replace source messages with one retained body. Resolve
  // their anchors within that same group until the next capture holds its
  // current event, including when a live answer replaces the previous one.
  const projectedGroup = Array.from(
    container.querySelectorAll<HTMLElement>(
      `[${SCROLL_ANCHOR_ALIASES_ATTRIBUTE}]`,
    ),
  ).find((group) => {
    return group
      .getAttribute(SCROLL_ANCHOR_ALIASES_ATTRIBUTE)
      ?.split(" ")
      .includes(eventId);
  });
  return (
    projectedGroup?.querySelector<HTMLElement>(
      `[${SCROLL_ANCHOR_ATTRIBUTE}]`,
    ) ?? null
  );
}

function applyScrollTop(
  runtime: ScrollRuntime,
  container: HTMLElement,
  scrollTop: number,
  behavior: ScrollBehavior = "instant",
): void {
  // Hidden viewports cannot complete a requested position. Even a no-op at a
  // real viewport size does, so acknowledge measurement before early returns.
  if (container.clientHeight > 0) {
    runtime.hasMeasuredPosition = true;
  }
  const targetScrollTop = Math.max(
    0,
    Math.min(scrollTop, container.scrollHeight - container.clientHeight),
  );
  if (behavior === "smooth") {
    if (runtime.programmaticSmoothScrollTop === targetScrollTop) {
      return;
    }
    runtime.programmaticScrollTop = null;
    runtime.programmaticSmoothScrollTop = targetScrollTop;
    container.scrollTo({ top: targetScrollTop, behavior });
    return;
  }
  runtime.programmaticSmoothScrollTop = null;
  if (container.scrollTop === targetScrollTop) {
    // A no-op assignment is not inert in every browser. Safari can reveal
    // layout-taking descendant scrollbars after a programmatic scroll, so keep
    // an already-restored viewport untouched.
    runtime.programmaticScrollTop = container.scrollTop;
    return;
  }
  container.scrollTop = scrollTop;
  // Remember where this module left the container. The browser clamps the
  // assignment, so read the offset back instead of trusting the requested one.
  runtime.programmaticScrollTop = container.scrollTop;
}

/** Returns false when the anchored event is not in the DOM. */
function scrollToPosition(
  runtime: ScrollRuntime,
  container: HTMLElement,
  position: ThreadScrollPosition,
  behavior: ScrollBehavior = "instant",
): boolean {
  const target = scrollAnchorForEvent(container, position.targetEventId);
  if (!target) {
    return false;
  }
  const currentViewportOffsetTop =
    target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  applyScrollTop(
    runtime,
    container,
    container.scrollTop + currentViewportOffsetTop - position.viewportOffsetTop,
    behavior,
  );
  return true;
}

function firstVisibleScrollAnchor(
  container: HTMLElement,
  excludedAnchorAncestors?: string,
  preferredAnchor?: HTMLElement | null,
): HTMLElement | null {
  const anchors = scrollAnchors(container).filter((anchor) => {
    return !excludedAnchorAncestors || !anchor.closest(excludedAnchorAncestors);
  });
  const containerRect = container.getBoundingClientRect();
  const visibleAnchors = anchors.filter((anchor) => {
    const rect = anchor.getBoundingClientRect();
    return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
  });
  return (
    visibleAnchors.find((anchor) => {
      return anchor === preferredAnchor;
    }) ??
    visibleAnchors[0] ??
    (excludedAnchorAncestors
      ? anchors.find((anchor) => {
          return anchor.getBoundingClientRect().top >= containerRect.bottom;
        })
      : undefined) ??
    anchors.at(-1) ??
    null
  );
}

function captureScrollPosition(
  container: HTMLElement,
  excludedAnchorAncestors?: string,
  preferredAnchor?: HTMLElement | null,
): ThreadScrollPosition | null {
  const anchor = firstVisibleScrollAnchor(
    container,
    excludedAnchorAncestors,
    preferredAnchor,
  );
  const targetEventId = anchor?.getAttribute(SCROLL_ANCHOR_ATTRIBUTE);
  if (!anchor || !targetEventId) {
    return null;
  }
  const anchorRect = anchor.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  // If the entire viewport is being removed, continue at the nearest retained
  // message rather than jumping to an unrelated message at the thread's end.
  const removedViewport =
    excludedAnchorAncestors &&
    (anchorRect.bottom <= containerRect.top ||
      anchorRect.top >= containerRect.bottom);
  return {
    targetEventId,
    viewportOffsetTop: removedViewport ? 0 : anchorRect.top - containerRect.top,
  };
}

function sameScrollPosition(
  left: ThreadScrollPosition | undefined,
  right: ThreadScrollPosition,
): boolean {
  return (
    left?.targetEventId === right.targetEventId &&
    left.viewportOffsetTop === right.viewportOffsetTop
  );
}

interface HiddenScrollLayout {
  readonly container: HTMLElement;
  position: ThreadScrollPosition | null;
  readonly release: () => void;
}

function releaseHiddenLayout(runtime: ScrollRuntime): void {
  runtime.hiddenLayout?.release();
  runtime.hiddenLayout = null;
}

interface ScrollRuntime {
  hiddenLayout: HiddenScrollLayout | null;
  initialized: boolean;
  hasMeasuredPosition: boolean;
  pendingScroll: symbol | null;
  // Offset this module last wrote to the container, cleared once the container
  // reports a different one. Scroll events are delivered asynchronously, so
  // content rendered in between (an async diagram, a late image) can make that
  // event measure as "not at the bottom" and park the thread on an anchor
  // nobody chose.
  programmaticScrollTop: number | null;
  // Smooth scrolling spans several browser scroll events. Keep its target so
  // those events do not rewrite the held event position, and so a resize
  // restore during the animation preserves the requested behavior.
  programmaticSmoothScrollTop: number | null;
}

function isProgrammaticScroll(
  runtime: ScrollRuntime,
  container: HTMLElement,
): boolean {
  return (
    runtime.hiddenLayout !== null ||
    runtime.programmaticSmoothScrollTop !== null ||
    runtime.programmaticScrollTop === container.scrollTop
  );
}

function createRecordThreadScrollPosition(threadId: string) {
  return command(({ get, set }, position: ThreadScrollPosition | null) => {
    const positions = get(threadScrollPositions$);
    if (
      position === null
        ? !positions.has(threadId)
        : sameScrollPosition(positions.get(threadId), position)
    ) {
      return false;
    }
    const next = new Map(positions);
    if (position === null) {
      next.delete(threadId);
    } else {
      next.set(threadId, position);
    }
    set(threadScrollPositions$, next);
    return true;
  });
}

function createInternalScrollSignals(
  threadId: string,
  position: ThreadScrollPositionSignals,
  runtime: ScrollRuntime,
  afterThreadScrollPositionChanged$: Command<Promise<void>, [AbortSignal]>,
) {
  const internalScrollContainer$ = state<HTMLElement | null>(null);
  const scrollContainer$ = computed((get) => {
    return get(internalScrollContainer$);
  });
  const { threadScrollPosition$, awayFromBottom$ } = position;

  const recordThreadScrollPosition$ =
    createRecordThreadScrollPosition(threadId);
  // The held position selects the render window. Ordinary writes prepare that
  // window immediately; hidden capture keeps the already-rendered anchor and
  // lets presentation/reveal own preparation, never an untracked render effect.
  const setThreadScrollPosition$ = command(
    async (
      { set },
      position: ThreadScrollPosition,
      signal: AbortSignal,
    ): Promise<void> => {
      if (!set(recordThreadScrollPosition$, position)) {
        return;
      }
      await set(afterThreadScrollPositionChanged$, signal);
    },
  );
  const clearThreadScrollPosition$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      if (!set(recordThreadScrollPosition$, null)) {
        return;
      }
      await set(afterThreadScrollPositionChanged$, signal);
    },
  );
  const syncThreadScrollPosition$ = command(
    async (
      { set },
      container: HTMLElement,
      capturePosition: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      if (isAtBottom(container)) {
        L.debug("scroll position cleared at bottom", {
          threadId,
          scrollTop: container.scrollTop,
        });
        await set(clearThreadScrollPosition$, signal);
        return;
      }
      if (!capturePosition) {
        L.debug("programmatic scroll position ignored", {
          threadId,
          scrollTop: container.scrollTop,
        });
        return;
      }
      const position = captureScrollPosition(container);
      if (position) {
        L.debug("scroll position captured", {
          threadId,
          ...position,
          scrollTop: container.scrollTop,
        });
        await set(setThreadScrollPosition$, position, signal);
      }
    },
  );
  // Background batches may run against empty/stale DOM. Read captured intent,
  // including the live pre-hide anchor, without measuring that DOM again.
  const readCapturedThreadScrollPosition$ = command(({ get }) => {
    return runtime.hiddenLayout
      ? runtime.hiddenLayout.position
      : get(threadScrollPosition$);
  });
  const readRenderedThreadScrollPosition$ = command(
    ({ get }, excludedAnchorAncestors?: string) => {
      if (runtime.hiddenLayout) {
        return runtime.hiddenLayout.position;
      }
      const currentPosition = get(threadScrollPosition$);
      if (currentPosition === null) {
        return null;
      }
      const container = get(scrollContainer$);
      if (!container) {
        return currentPosition;
      }
      if (isAtBottom(container)) {
        return null;
      }
      // Keep the reader's held message when it survives the layout change.
      // Collapsing content can expose an earlier message above that anchor.
      return (
        captureScrollPosition(
          container,
          excludedAnchorAncestors,
          scrollAnchorForEvent(container, currentPosition.targetEventId),
        ) ?? (excludedAnchorAncestors ? null : currentPosition)
      );
    },
  );
  const bindScrollContainer$ = command(
    ({ set }, container: HTMLElement): void => {
      set(internalScrollContainer$, container);
    },
  );
  const clearScrollContainer$ = command(
    ({ get, set }, container: HTMLElement): void => {
      if (get(internalScrollContainer$) === container) {
        set(internalScrollContainer$, null);
      }
    },
  );

  return {
    scrollContainer$,
    threadScrollPosition$,
    awayFromBottom$,
    readCapturedThreadScrollPosition$,
    readRenderedThreadScrollPosition$,
    recordThreadScrollPosition$,
    ensureRenderedPosition$: afterThreadScrollPositionChanged$,
    syncThreadScrollPosition$,
    setThreadScrollPosition$,
    clearThreadScrollPosition$,
    bindScrollContainer$,
    clearScrollContainer$,
  };
}

type InternalScrollSignals = ReturnType<typeof createInternalScrollSignals>;

function createScrollNavigationSignals(
  threadId: string,
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
  render: ReturnType<typeof createRenderScrollSignals>,
  window: ChatThreadScrollRenderWindow,
) {
  const seekSpacer$ = command(
    ({ set }, container: HTMLElement, signal: AbortSignal) => {
      const position = set(window.positionInSpacer$, container);
      return position
        ? set(render.requestScrollAfterRender$, position, "instant", signal)
        : null;
    },
  );
  const scrollTo$ = command(({ get }, position: ThreadScrollPosition) => {
    releaseHiddenLayout(runtime);
    runtime.pendingScroll = null;
    const container = get(scroll.scrollContainer$);
    if (!container) {
      throw new Error("Chat scroll container is not mounted");
    }
    if (!scrollToPosition(runtime, container, position)) {
      throw new Error(
        `Chat scroll target is not rendered: ${position.targetEventId}`,
      );
    }
    runtime.initialized = true;
  });

  const scrollToBottom$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      releaseHiddenLayout(runtime);
      runtime.pendingScroll = null;
      const container = get(scroll.scrollContainer$);
      if (!container) {
        throw new Error("Chat scroll container is not mounted");
      }
      L.debug("scroll to bottom", {
        threadId,
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        heldTargetEventId:
          get(scroll.threadScrollPosition$)?.targetEventId ?? null,
      });
      // The DOM write happens before the awaited state clear so the jump is
      // part of the current task and cannot paint at the old offset first.
      applyScrollTop(runtime, container, container.scrollHeight);
      runtime.initialized = true;
      if (get(scroll.threadScrollPosition$) && !get(window.tailMounted$)) {
        // Supersede an incoming history commit while the tail page is preparing.
        await set(render.requestScrollAfterRender$, null, "instant", signal);
      } else {
        await set(scroll.clearThreadScrollPosition$, signal);
      }
    },
  );

  const scrollToTop$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      releaseHiddenLayout(runtime);
      runtime.pendingScroll = null;
      const container = get(scroll.scrollContainer$);
      if (!container) {
        throw new Error("Chat scroll container is not mounted");
      }
      applyScrollTop(runtime, container, 0);
      runtime.initialized = true;
      const seek = set(seekSpacer$, container, signal);
      if (seek) {
        await seek;
      } else {
        await set(scroll.syncThreadScrollPosition$, container, true, signal);
      }
    },
  );

  const restoreScrollPosition$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const position = get(scroll.threadScrollPosition$);
      const container = get(scroll.scrollContainer$);
      if (
        runtime.hiddenLayout ||
        runtime.pendingScroll ||
        !runtime.initialized ||
        !container
      ) {
        return;
      }
      if (position) {
        if (
          scrollToPosition(
            runtime,
            container,
            position,
            runtime.programmaticSmoothScrollTop === null ? "instant" : "smooth",
          )
        ) {
          runtime.initialized = true;
          return;
        }
        if (get(window.awaitingAnchor$)) {
          return;
        }
        L.debug("layout scroll restore target no longer rendered", {
          threadId,
          targetEventId: position.targetEventId,
        });
      }
      await set(scrollToBottom$, signal);
    },
  );

  const restoreScrollPositionForLayout$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      // Once a reading position was measured, native anchoring owns reflow.
      // Otherwise finish the existing request when real geometry is available.
      if (
        get(scroll.threadScrollPosition$) !== null &&
        runtime.hasMeasuredPosition
      ) {
        return;
      }
      await set(restoreScrollPosition$, signal);
    },
  );

  return {
    seekSpacer$,
    scrollTo$,
    scrollToBottom$,
    scrollToTop$,
    restoreScrollPosition$,
    restoreScrollPositionForLayout$,
  };
}

function transcriptViewportNeedsContent(
  container: HTMLElement,
  atTail: boolean,
): boolean {
  return (
    container.clientHeight > 0 &&
    ((atTail && container.scrollHeight <= container.clientHeight) ||
      visibleTranscriptSpacer(container) !== null)
  );
}

function createRenderScrollSignals(
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
  loadEarlierGroups$: ChatThreadScrollRenderWindow["loadEarlierGroups$"],
  events: Pick<ChatEventSignals, "chatEvents$" | "queuedEvents$">,
) {
  const requestScrollAfterRender$ = command(
    async (
      { get, set },
      position: ThreadScrollPosition | null,
      behavior: ScrollBehavior,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      const request = Symbol();
      runtime.pendingScroll = request;
      runtime.hasMeasuredPosition = false;
      async function alignAfterPaint() {
        if (position) {
          await set(scroll.setThreadScrollPosition$, position, signal);
        } else {
          await set(scroll.clearThreadScrollPosition$, signal);
        }
        if (runtime.hiddenLayout || !get(events.chatEvents$).length) {
          return;
        }
        do {
          await waitForBrowserPaint(signal);
          signal.throwIfAborted();
          const container = get(scroll.scrollContainer$);
          if (
            runtime.pendingScroll !== request ||
            runtime.hiddenLayout ||
            !container ||
            !scrollAnchors(container).length
          ) {
            return;
          }
          const atTail =
            !position ||
            get(events.queuedEvents$).some((event) => {
              return event.id === position.targetEventId;
            });
          if (atTail) {
            applyScrollTop(
              runtime,
              container,
              container.scrollHeight,
              behavior,
            );
          } else if (
            !scrollToPosition(runtime, container, position, behavior)
          ) {
            return;
          }
          runtime.initialized = true;
          if (atTail && position) {
            await set(scroll.clearThreadScrollPosition$, signal);
          }
          if (
            !transcriptViewportNeedsContent(container, atTail) ||
            runtime.pendingScroll !== request
          ) {
            return;
          }
        } while (await set(loadEarlierGroups$, signal));
      }
      await alignAfterPaint().finally(() => {
        if (runtime.pendingScroll === request) {
          runtime.pendingScroll = null;
        }
      });
    },
  );
  const autoScroll$ = command(
    (
      { set },
      position: ThreadScrollPosition | null,
      signal: AbortSignal,
    ): Promise<void> => {
      // A new sent message requests the tail even while the chat is covered;
      // ordinary incoming batches must not replace its saved reading offset.
      if (runtime.hiddenLayout && position === null) {
        runtime.hiddenLayout.position = null;
      }
      return set(requestScrollAfterRender$, position, "instant", signal);
    },
  );

  return { autoScroll$, requestScrollAfterRender$ };
}

type ScrollNavigationSignals = ReturnType<typeof createScrollNavigationSignals>;

function createAttachScrollContainer(
  threadId: string,
  scroll: InternalScrollSignals,
  navigation: ScrollNavigationSignals,
  runtime: ScrollRuntime,
  seekSpacer$: Command<Promise<void> | null, [HTMLElement, AbortSignal]>,
) {
  return command(({ set }, container: HTMLElement, signal: AbortSignal) => {
    set(scroll.bindScrollContainer$, container);
    L.debug("container bound", {
      threadId,
      initialized: runtime.initialized,
    });

    const handleScroll = onDomEventFn((event: Event) => {
      // Zero/intermediate reveal geometry is not a new reader position.
      if (runtime.hiddenLayout) {
        return;
      }
      if (
        !runtime.initialized &&
        !(
          runtime.pendingScroll &&
          container.clientHeight > 0 &&
          scrollAnchors(container).length
        )
      ) {
        L.debug("pre-initialization scroll ignored", { threadId });
        return;
      }
      if (event.target !== container) {
        // The listener runs in the capture phase, so nested scrollers (wide
        // diagrams, code blocks, tables) deliver their scroll events here
        // too. Where they sit says nothing about where the thread sits.
        return;
      }
      const programmatic = isProgrammaticScroll(runtime, container);
      if (!programmatic) {
        // The container has left the offset this module wrote, so the reader
        // moved it. Until that happens the offset is still ours no matter how
        // many events describe it, and content growing every frame delivers
        // more of them than the restores that wrote them.
        runtime.programmaticScrollTop = null;
        // A reader takeover with real geometry supersedes an initial hidden
        // viewport attempt; a later layout must not replay its stale anchor.
        if (container.clientHeight > 0) {
          // Reader input between the two frames supersedes the scheduled write.
          runtime.initialized = true;
          runtime.pendingScroll = null;
          runtime.hasMeasuredPosition = true;
        }
      }
      if (!programmatic && !isAtBottom(container)) {
        const seek = set(seekSpacer$, container, signal);
        if (seek) {
          return seek;
        }
      }
      return set(
        scroll.syncThreadScrollPosition$,
        container,
        !programmatic,
        signal,
      );
    });
    const restoreLayout = onDomEventFn((event: Event) => {
      return set(
        event.type === "resize"
          ? navigation.restoreScrollPositionForLayout$
          : navigation.restoreScrollPosition$,
        signal,
      );
    });
    const handleScrollEnd = (event: Event) => {
      if (
        event.target === container &&
        runtime.programmaticSmoothScrollTop !== null
      ) {
        // A fractional target can produce one near-terminal integer scroll
        // offset before the browser reports its final rounded offset. Keep
        // the whole animation programmatic until scrollend, then carry the
        // actual terminal offset into the ordinary duplicate-event guard.
        runtime.programmaticScrollTop = container.scrollTop;
        runtime.programmaticSmoothScrollTop = null;
      }
    };
    const view = container.ownerDocument.defaultView;

    container.addEventListener("scroll", handleScroll, {
      capture: true,
      passive: true,
    });
    container.addEventListener("scrollend", handleScrollEnd, {
      passive: true,
    });
    view?.addEventListener("resize", restoreLayout, { signal });
    view?.visualViewport?.addEventListener("resize", restoreLayout, {
      signal,
    });
    container.ownerDocument.fonts?.addEventListener(
      "loadingdone",
      restoreLayout,
      { signal },
    );

    signal.addEventListener(
      "abort",
      () => {
        container.removeEventListener("scroll", handleScroll, {
          capture: true,
        });
        container.removeEventListener("scrollend", handleScrollEnd);
        releaseHiddenLayout(runtime);
        set(scroll.clearScrollContainer$, container);
        runtime.pendingScroll = null;
        runtime.initialized = false;
        runtime.hasMeasuredPosition = false;
        runtime.programmaticScrollTop = null;
        runtime.programmaticSmoothScrollTop = null;
        L.debug("container unbound", { threadId });
      },
      { once: true },
    );
  });
}

/** Native resource and disclosure events run after their layout changes. */
function createScrollContentOnRef(
  threadId: string,
  navigation: ScrollNavigationSignals,
) {
  return onRef(
    command(({ set }, content: HTMLElement, signal: AbortSignal) => {
      L.debug("content bound", { threadId });
      const restoreLayout = onDomEventFn(() => {
        return set(navigation.restoreScrollPosition$, signal);
      });
      // These events do not bubble; capture them from the actual resource or
      // details element.
      for (const event of ["load", "error", "loadedmetadata", "toggle"]) {
        content.addEventListener(event, restoreLayout, {
          capture: true,
          signal,
        });
      }
    }),
  );
}

function createHiddenScrollLayoutSignals(
  scroll: InternalScrollSignals,
  navigation: ScrollNavigationSignals,
  runtime: ScrollRuntime,
) {
  const preserveHiddenLayout$ = command(({ get, set }) => {
    const container = get(scroll.scrollContainer$);
    if (
      runtime.hiddenLayout ||
      !runtime.initialized ||
      runtime.programmaticSmoothScrollTop !== null ||
      runtime.pendingScroll ||
      !container?.isConnected ||
      container.clientWidth <= 0 ||
      container.clientHeight <= 0
    ) {
      return;
    }
    const position = isAtBottom(container)
      ? null
      : captureScrollPosition(container);
    // The viewport and Base UI's track/thumb share this interaction root.
    const inputRoot = container.parentElement;
    if (!inputRoot) {
      throw new Error("Chat scroll viewport has no interaction root");
    }
    const cancel = () => {
      if (runtime.hiddenLayout === snapshot) {
        releaseHiddenLayout(runtime);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key) &&
        !(
          event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, [contenteditable]")
        )
      ) {
        cancel();
      }
    };
    const snapshot: HiddenScrollLayout = {
      container,
      position,
      release: () => {
        inputRoot.removeEventListener("wheel", cancel);
        inputRoot.removeEventListener("touchmove", cancel);
        inputRoot.removeEventListener("pointerdown", cancel, true);
        inputRoot.removeEventListener("keydown", onKeyDown);
      },
    };
    runtime.hiddenLayout = snapshot;
    // Reader input after reveal wins over the pending one-shot restore. These
    // listeners never prevent native scrolling or change focus behavior.
    inputRoot.addEventListener("wheel", cancel, { passive: true });
    inputRoot.addEventListener("touchmove", cancel, { passive: true });
    inputRoot.addEventListener("pointerdown", cancel, {
      passive: true,
      capture: true,
    });
    inputRoot.addEventListener("keydown", onKeyDown);
    // Publish the live intent to the existing window authority before hiding.
    // Incoming rows must retain this anchor even if their resource preparation
    // is still pending when the reader reveals the transcript.
    set(scroll.recordThreadScrollPosition$, position);
  });
  const restoreHiddenLayout$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const snapshot = runtime.hiddenLayout;
      if (!snapshot) {
        return;
      }
      const container = get(scroll.scrollContainer$);
      if (container !== snapshot.container || !container.isConnected) {
        releaseHiddenLayout(runtime);
        return;
      }
      // Another utility pane can still cover the chat after an unrelated
      // dismiss. Keep the snapshot until the actual reveal or container unbind.
      if (container.clientWidth <= 0 || container.clientHeight <= 0) {
        return;
      }
      releaseHiddenLayout(runtime);
      if (snapshot.position === null) {
        await set(navigation.scrollToBottom$, signal);
        signal.throwIfAborted();
      } else if (!scrollToPosition(runtime, container, snapshot.position)) {
        return;
      }
      // Capture already published this position. Prepare its window even when
      // that atom is unchanged; the visible restore must not await diagram I/O.
      await set(scroll.ensureRenderedPosition$, signal);
    },
  );
  return {
    hasPreservedHiddenLayout$: command(() => {
      return runtime.hiddenLayout !== null;
    }),
    preserveHiddenLayout$,
    restoreHiddenLayout$,
  };
}

export function createChatThreadScrollSignals(
  threadId: string,
  position: ThreadScrollPositionSignals,
  renderWindow: ChatThreadScrollRenderWindow,
  events: Pick<ChatEventSignals, "chatEvents$" | "queuedEvents$">,
  initialEventsReady$: Computed<boolean>,
): ChatThreadScrollSignals {
  const runtime: ScrollRuntime = {
    hiddenLayout: null,
    initialized: false,
    hasMeasuredPosition: false,
    pendingScroll: null,
    programmaticScrollTop: null,
    programmaticSmoothScrollTop: null,
  };
  const scroll = createInternalScrollSignals(
    threadId,
    position,
    runtime,
    renderWindow.afterThreadScrollPositionChanged$,
  );
  const render = createRenderScrollSignals(
    scroll,
    runtime,
    renderWindow.loadEarlierGroups$,
    events,
  );
  const navigation = createScrollNavigationSignals(
    threadId,
    scroll,
    runtime,
    render,
    renderWindow,
  );
  const attachContainer$ = createAttachScrollContainer(
    threadId,
    scroll,
    navigation,
    runtime,
    navigation.seekSpacer$,
  );
  const isProgrammaticScrollEvent$ = command(
    ({ get }, target: EventTarget | null): boolean => {
      const container = get(scroll.scrollContainer$);
      return (
        container !== null &&
        target === container &&
        isProgrammaticScroll(runtime, container)
      );
    },
  );
  const scrollToEvent$ = command(
    async (
      { get, set },
      eventId: string,
      options: ScrollToEventOptions,
      signal: AbortSignal,
    ): Promise<void> => {
      releaseHiddenLayout(runtime);
      await waitLoopUntil(
        () => {
          return get(initialEventsReady$);
        },
        16,
        signal,
      );
      signal.throwIfAborted();
      const eventExists = get(events.chatEvents$).some((event) => {
        return event.id === eventId;
      });
      if (!eventExists) {
        L.debug("scroll target event not found", { threadId, eventId });
        return;
      }
      if (options.preloadPreviousRenderWindow) {
        await set(
          renderWindow.preloadPreviousRenderWindowForEvent$,
          eventId,
          signal,
        );
        signal.throwIfAborted();
      }
      // Measure once the events are ready: a pane opened by a link has no
      // viewport when the scroll is requested.
      const viewportHeight = get(scroll.scrollContainer$)?.clientHeight ?? 0;
      const position: ThreadScrollPosition = {
        targetEventId: eventId,
        viewportOffsetTop: viewportHeight * options.viewportRatio,
      };
      await set(
        render.requestScrollAfterRender$,
        position,
        options.behavior,
        signal,
      );
    },
  );

  const hiddenLayout = createHiddenScrollLayoutSignals(
    scroll,
    navigation,
    runtime,
  );

  return {
    ...hiddenLayout,
    scrollContainerOnRef$: onRef(attachContainer$),
    scrollContentOnRef$: createScrollContentOnRef(threadId, navigation),
    scrollContainer$: scroll.scrollContainer$,
    threadScrollPosition$: scroll.threadScrollPosition$,
    awayFromBottom$: scroll.awayFromBottom$,
    isProgrammaticScrollEvent$,
    readCapturedThreadScrollPosition$: scroll.readCapturedThreadScrollPosition$,
    readRenderedThreadScrollPosition$: scroll.readRenderedThreadScrollPosition$,
    autoScroll$: render.autoScroll$,
    scrollToEvent$,
    scrollTo$: navigation.scrollTo$,
    scrollToTop$: navigation.scrollToTop$,
    scrollToBottom$: navigation.scrollToBottom$,
    restoreScrollPosition$: navigation.restoreScrollPosition$,
    restoreScrollPositionForLayout$: navigation.restoreScrollPositionForLayout$,
  };
}
