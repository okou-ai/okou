import { command, computed, state, type Command, type Computed } from "ccstate";
import { logger } from "../log.ts";
import { onDomEventFn, onRef, waitLoopUntil } from "../utils.ts";
import type { ChatEvent } from "./chat-event-types.ts";

const L = logger("AutoScroll");
const AT_BOTTOM_THRESHOLD_PX = 10;
const SCROLL_ANCHOR_ATTRIBUTE = "data-chat-scroll-anchor-event-id";
const SCROLL_ANCHOR_ALIASES_ATTRIBUTE =
  "data-chat-scroll-anchor-alias-event-ids";
const SCROLL_COMMIT_REVISION_ATTRIBUTE = "data-chat-scroll-commit-revision";
const SCROLL_COMMIT_TO_TAIL_ATTRIBUTE = "data-chat-scroll-commit-to-tail";

export interface ThreadScrollPosition {
  readonly targetEventId: string;
  readonly viewportOffsetTop: number;
}

export interface ScrollToEventOptions {
  readonly behavior: ScrollBehavior;
  readonly viewportOffsetTop: number;
  readonly preloadPreviousRenderWindow: boolean;
}

export interface ScrollAfterRenderRequest {
  readonly revision: number;
  readonly position: ThreadScrollPosition | null;
  readonly behavior: ScrollBehavior;
}

export interface ReadyScrollAfterRenderRequest {
  readonly request: ScrollAfterRenderRequest;
  readonly renderedEventKeys: readonly string[];
}

export interface ChatThreadScrollSignals {
  /**
   * Binds the scroll container. Unwrapped so the thread factory can give the
   * element one `onRef` lifetime shared with the locator's reading.
   */
  readonly attachScrollContainer$: Command<void, [HTMLElement, AbortSignal]>;
  readonly scrollContentOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly scrollCommitOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly pendingScrollAfterRenderRequest$: Computed<ScrollAfterRenderRequest | null>;
  /** The mounted scroll viewport, for readers that measure it themselves. */
  readonly scrollContainer$: Computed<HTMLElement | null>;
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  readonly awayFromBottom$: Computed<boolean>;
  readonly isProgrammaticScrollEvent$: Command<boolean, [EventTarget | null]>;
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
}

const threadScrollPositions$ = state(new Map<string, ThreadScrollPosition>());

interface ThreadScrollPositionSignals {
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  readonly awayFromBottom$: Computed<boolean>;
}

interface ChatThreadScrollRenderWindow {
  readonly afterThreadScrollPositionChanged$: Command<
    Promise<void>,
    [AbortSignal]
  >;
  readonly preloadPreviousRenderWindowForEvent$: Command<
    Promise<void>,
    [string, AbortSignal]
  >;
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

function scrollContainerForCommitMarker(marker: HTMLElement): HTMLElement {
  const container = marker.closest("[data-scroll-container]");
  if (!(container instanceof HTMLElement)) {
    throw new Error("Chat scroll commit marker has no scroll container");
  }
  return container;
}

function scrollRenderRevision(marker: HTMLElement): number {
  const value = marker.getAttribute(SCROLL_COMMIT_REVISION_ATTRIBUTE);
  const revision = Number(value);
  if (value === null || revision < 1 || !Number.isSafeInteger(revision)) {
    throw new Error("Chat scroll commit marker has no valid revision");
  }
  return revision;
}

function applyScrollTop(
  runtime: ScrollRuntime,
  container: HTMLElement,
  scrollTop: number,
  behavior: ScrollBehavior = "instant",
): void {
  if (behavior === "smooth") {
    const targetScrollTop = Math.max(
      0,
      Math.min(scrollTop, container.scrollHeight - container.clientHeight),
    );
    if (runtime.programmaticSmoothScrollTop === targetScrollTop) {
      return;
    }
    runtime.programmaticScrollTop = null;
    runtime.programmaticSmoothScrollTop = targetScrollTop;
    container.scrollTo({ top: targetScrollTop, behavior });
    return;
  }
  runtime.programmaticSmoothScrollTop = null;
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

interface ScrollRuntime {
  initialized: boolean;
  latestRenderRequestRevision: number;
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
    runtime.programmaticSmoothScrollTop !== null ||
    runtime.programmaticScrollTop === container.scrollTop
  );
}

function createInternalScrollSignals(
  threadId: string,
  position: ThreadScrollPositionSignals,
  afterThreadScrollPositionChanged$: Command<Promise<void>, [AbortSignal]>,
) {
  const internalScrollContainer$ = state<HTMLElement | null>(null);
  const scrollContainer$ = computed((get) => {
    return get(internalScrollContainer$);
  });
  const { threadScrollPosition$, awayFromBottom$ } = position;

  // The held position feeds the render window, so every write below runs the
  // window's ensure step afterwards — parsing is command-driven, and this is
  // one of the places the set of visible events can change.
  const setThreadScrollPosition$ = command(
    async (
      { get, set },
      position: ThreadScrollPosition,
      signal: AbortSignal,
    ): Promise<void> => {
      const positions = get(threadScrollPositions$);
      if (sameScrollPosition(positions.get(threadId), position)) {
        return;
      }
      const next = new Map(positions);
      next.set(threadId, position);
      set(threadScrollPositions$, next);
      await set(afterThreadScrollPositionChanged$, signal);
    },
  );
  const clearThreadScrollPosition$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const positions = get(threadScrollPositions$);
      if (!positions.has(threadId)) {
        return;
      }
      const next = new Map(positions);
      next.delete(threadId);
      set(threadScrollPositions$, next);
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
  const readRenderedThreadScrollPosition$ = command(
    ({ get }, excludedAnchorAncestors?: string) => {
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
    readRenderedThreadScrollPosition$,
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
  pendingScrollAfterRenderRequest$: Computed<ScrollAfterRenderRequest | null>,
) {
  const scrollTo$ = command(({ get }, position: ThreadScrollPosition) => {
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
      await set(scroll.clearThreadScrollPosition$, signal);
    },
  );

  const scrollToTop$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const container = get(scroll.scrollContainer$);
      if (!container) {
        throw new Error("Chat scroll container is not mounted");
      }
      applyScrollTop(runtime, container, 0);
      runtime.initialized = true;
      await set(scroll.syncThreadScrollPosition$, container, true, signal);
    },
  );

  const restoreScrollPosition$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const position = get(scroll.threadScrollPosition$);
      const container = get(scroll.scrollContainer$);
      if (!runtime.initialized || !container) {
        return;
      }
      L.debug("layout scroll restore", {
        threadId,
        targetEventId: position?.targetEventId ?? null,
        viewportOffsetTop: position?.viewportOffsetTop ?? null,
      });
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
        if (get(pendingScrollAfterRenderRequest$) !== null) {
          // The commit marker owns the pending event batch. Keep its anchor
          // until React acknowledges the final DOM for that batch.
          L.debug("layout scroll restore waiting for render commit", {
            threadId,
            targetEventId: position.targetEventId,
          });
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

  return {
    scrollTo$,
    scrollToBottom$,
    scrollToTop$,
    restoreScrollPosition$,
  };
}

/** Commits scroll only when React acknowledges the matching event batch. */
function createRenderScrollSignals(
  threadId: string,
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
) {
  const internalPendingRequest$ = state<ScrollAfterRenderRequest | null>(null);
  const pendingScrollAfterRenderRequest$ = computed((get) => {
    return get(internalPendingRequest$);
  });
  const clearPendingRequest$ = command(
    ({ get, set }, revision: number): void => {
      if (get(internalPendingRequest$)?.revision === revision) {
        set(internalPendingRequest$, null);
      }
    },
  );
  const scrollCommitOnRef$ = onRef(
    command(
      async (
        { get, set },
        marker: HTMLElement,
        signal: AbortSignal,
      ): Promise<void> => {
        signal.throwIfAborted();
        const revision = scrollRenderRevision(marker);
        const request = get(pendingScrollAfterRenderRequest$);
        if (!request || request.revision !== revision) {
          L.debug("stale render scroll commit ignored", {
            threadId,
            revision,
            currentRevision: request?.revision ?? null,
          });
          return;
        }
        const container = scrollContainerForCommitMarker(marker);
        if (scrollAnchors(container).length === 0) {
          L.debug("render scroll commit waiting for messages", {
            threadId,
            revision,
          });
          return;
        }
        const commitToTail = marker.hasAttribute(
          SCROLL_COMMIT_TO_TAIL_ATTRIBUTE,
        );
        if (commitToTail) {
          applyScrollTop(
            runtime,
            container,
            container.scrollHeight,
            request.behavior,
          );
        } else if (
          !request.position ||
          !scrollToPosition(
            runtime,
            container,
            request.position,
            request.behavior,
          )
        ) {
          throw new Error(
            `Chat scroll target is not rendered: ${request.position?.targetEventId ?? "none"}`,
          );
        }
        runtime.initialized = true;
        set(clearPendingRequest$, revision);
        L.debug("render scroll committed", {
          threadId,
          revision,
          targetEventId: request.position?.targetEventId ?? null,
          viewportOffsetTop: request.position?.viewportOffsetTop ?? null,
          behavior: request.behavior,
          scrollTop: container.scrollTop,
        });
        if (commitToTail) {
          // After the DOM write: the commit runs during React's ref phase, and
          // the offset must be applied before this frame paints.
          await set(scroll.clearThreadScrollPosition$, signal);
        }
      },
    ),
  );
  const requestScrollAfterRender$ = command(
    async (
      { set },
      position: ThreadScrollPosition | null,
      behavior: ScrollBehavior,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      runtime.latestRenderRequestRevision += 1;
      const request: ScrollAfterRenderRequest = {
        revision: runtime.latestRenderRequestRevision,
        position,
        behavior,
      };
      L.debug("render scroll requested", {
        threadId,
        revision: request.revision,
        targetEventId: position?.targetEventId ?? null,
        viewportOffsetTop: position?.viewportOffsetTop ?? null,
        behavior,
      });
      set(internalPendingRequest$, request);
      if (position === null) {
        await set(scroll.clearThreadScrollPosition$, signal);
      } else {
        // Layout commits and the matching render commit must restore the same
        // anchor, including when a projection removes the previously held one.
        await set(scroll.setThreadScrollPosition$, position, signal);
      }
    },
  );
  const autoScroll$ = command(
    (
      { set },
      position: ThreadScrollPosition | null,
      signal: AbortSignal,
    ): Promise<void> => {
      return set(requestScrollAfterRender$, position, "instant", signal);
    },
  );

  return {
    autoScroll$,
    requestScrollAfterRender$,
    pendingScrollAfterRenderRequest$,
    scrollCommitOnRef$,
  };
}

type ScrollNavigationSignals = ReturnType<typeof createScrollNavigationSignals>;

function createAttachScrollContainer(
  threadId: string,
  scroll: InternalScrollSignals,
  navigation: ScrollNavigationSignals,
  runtime: ScrollRuntime,
) {
  return command(({ set }, container: HTMLElement, signal: AbortSignal) => {
    set(scroll.bindScrollContainer$, container);
    L.debug("container bound", {
      threadId,
      initialized: runtime.initialized,
    });

    const handleScroll = onDomEventFn((event: Event) => {
      if (!runtime.initialized) {
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
      }
      return set(
        scroll.syncThreadScrollPosition$,
        container,
        !programmatic,
        signal,
      );
    });
    const restoreLayout = onDomEventFn(() => {
      return set(navigation.restoreScrollPosition$, signal);
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
    container.ownerDocument.fonts?.addEventListener(
      "loadingdone",
      restoreLayout,
      { signal },
    );
    view?.visualViewport?.addEventListener("resize", restoreLayout, {
      signal,
    });

    signal.addEventListener(
      "abort",
      () => {
        container.removeEventListener("scroll", handleScroll, {
          capture: true,
        });
        container.removeEventListener("scrollend", handleScrollEnd);
        set(scroll.clearScrollContainer$, container);
        runtime.initialized = false;
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
      // details element. React-owned changes restore at their commit marker.
      for (const event of ["load", "error", "loadedmetadata", "toggle"]) {
        content.addEventListener(event, restoreLayout, {
          capture: true,
          signal,
        });
      }
    }),
  );
}

export function createChatThreadScrollSignals(
  threadId: string,
  position: ThreadScrollPositionSignals,
  renderWindow: ChatThreadScrollRenderWindow,
  chatEvents$: Computed<readonly ChatEvent[]>,
  initialEventsReady$: Computed<boolean>,
): ChatThreadScrollSignals {
  const runtime: ScrollRuntime = {
    initialized: false,
    latestRenderRequestRevision: 0,
    programmaticScrollTop: null,
    programmaticSmoothScrollTop: null,
  };
  const scroll = createInternalScrollSignals(
    threadId,
    position,
    renderWindow.afterThreadScrollPositionChanged$,
  );
  const render = createRenderScrollSignals(threadId, scroll, runtime);
  const navigation = createScrollNavigationSignals(
    threadId,
    scroll,
    runtime,
    render.pendingScrollAfterRenderRequest$,
  );
  const attachScrollContainer$ = createAttachScrollContainer(
    threadId,
    scroll,
    navigation,
    runtime,
  );
  const scrollContentOnRef$ = createScrollContentOnRef(threadId, navigation);
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
      await waitLoopUntil(
        () => {
          return get(initialEventsReady$);
        },
        16,
        signal,
        { retryTransientErrors: false },
      );
      signal.throwIfAborted();
      const eventExists = get(chatEvents$).some((event) => {
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
      const position: ThreadScrollPosition = {
        targetEventId: eventId,
        viewportOffsetTop: options.viewportOffsetTop,
      };
      await set(scroll.setThreadScrollPosition$, position, signal);
      signal.throwIfAborted();
      await set(
        render.requestScrollAfterRender$,
        position,
        options.behavior,
        signal,
      );
    },
  );

  return {
    attachScrollContainer$,
    scrollContentOnRef$,
    scrollCommitOnRef$: render.scrollCommitOnRef$,
    pendingScrollAfterRenderRequest$: render.pendingScrollAfterRenderRequest$,
    scrollContainer$: scroll.scrollContainer$,
    threadScrollPosition$: scroll.threadScrollPosition$,
    awayFromBottom$: scroll.awayFromBottom$,
    isProgrammaticScrollEvent$,
    readRenderedThreadScrollPosition$: scroll.readRenderedThreadScrollPosition$,
    autoScroll$: render.autoScroll$,
    scrollToEvent$,
    scrollTo$: navigation.scrollTo$,
    scrollToTop$: navigation.scrollToTop$,
    scrollToBottom$: navigation.scrollToBottom$,
    restoreScrollPosition$: navigation.restoreScrollPosition$,
  };
}
