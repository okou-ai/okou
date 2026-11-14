import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { logger } from "../log.ts";
import { pageSignal$ } from "../page-signal.ts";
import {
  detach,
  onDomEventFn,
  onRef,
  Reason,
  waitLoopUntil,
} from "../utils.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import {
  captureTextReadingAnchor,
  measureTextReadingAnchor,
  type TextReadingAnchor,
} from "./chat-text-reading-anchor.ts";

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
  /** Where the event lands, as a fraction of the viewport height from its top. */
  readonly viewportRatio: number;
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
  readonly scrollContainerOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
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
  // Hidden viewports cannot complete a requested position. Even a no-op at a
  // real viewport size does, so acknowledge measurement before early returns.
  if (!hasScrollViewport(container)) {
    return;
  }
  runtime.hasMeasuredPosition = true;
  runtime.geometry = scrollGeometry(container, runtime);
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

interface ReadingBookmark {
  readonly eventId: string;
  readonly text: TextReadingAnchor;
}

interface HiddenScrollLayout {
  readonly container: HTMLElement;
  position: ThreadScrollPosition | null;
  readonly readingBookmark: ReadingBookmark | null;
}

function releaseHiddenLayout(runtime: ScrollRuntime): void {
  runtime.hiddenLayout = null;
}

interface ScrollGeometry {
  readonly width: number;
  readonly height: number;
  readonly contentHeight: number;
  readonly top: number;
  readonly eventTop: number | null;
  readonly eventHeight: number | null;
  readonly eventWidth: number | null;
}

function hasScrollViewport(container: HTMLElement): boolean {
  return (
    container.clientHeight > 0 &&
    container.clientWidth > 0 &&
    container.getBoundingClientRect().width > 0
  );
}

function scrollGeometry(
  container: HTMLElement,
  runtime: ScrollRuntime,
): ScrollGeometry {
  const rect = container.getBoundingClientRect();
  const eventRect = runtime.readingBookmark
    ? scrollAnchorForEvent(
        container,
        runtime.readingBookmark.eventId,
      )?.getBoundingClientRect()
    : undefined;
  return {
    width: container.clientWidth || rect.width,
    height: container.clientHeight,
    contentHeight: container.scrollHeight,
    top: rect.top + container.clientTop,
    // Absolute content coordinates do not change during ordinary scrolling.
    eventTop: eventRect ? eventRect.top - rect.top + container.scrollTop : null,
    eventHeight: eventRect?.height ?? null,
    eventWidth: eventRect?.width ?? null,
  };
}

function sameScrollGeometry(
  left: ScrollGeometry | null,
  right: ScrollGeometry,
): boolean {
  return (
    left !== null &&
    left.width === right.width &&
    left.height === right.height &&
    left.contentHeight === right.contentHeight &&
    left.top === right.top &&
    left.eventTop === right.eventTop &&
    left.eventHeight === right.eventHeight &&
    left.eventWidth === right.eventWidth
  );
}

function invalidateReadingBookmark(runtime: ScrollRuntime): void {
  runtime.readingBookmark = null;
}

function captureReadingBookmark(
  runtime: ScrollRuntime,
  container: HTMLElement,
  position: ThreadScrollPosition,
): void {
  if (
    !hasScrollViewport(container) ||
    runtime.programmaticSmoothScrollTop !== null
  ) {
    return;
  }
  const anchor = scrollAnchorForEvent(container, position.targetEventId);
  const text = anchor ? captureTextReadingAnchor(container, anchor) : null;
  runtime.readingBookmark = text
    ? { eventId: position.targetEventId, text }
    : null;
  runtime.geometry = scrollGeometry(container, runtime);
}

function restoreTextPoint(
  runtime: ScrollRuntime,
  container: HTMLElement,
  bookmark: ReadingBookmark,
): boolean {
  const anchor = scrollAnchorForEvent(container, bookmark.eventId);
  const offset = anchor
    ? measureTextReadingAnchor(container, anchor, bookmark.text)
    : null;
  if (offset === null) {
    return false;
  }
  applyScrollTop(
    runtime,
    container,
    container.scrollTop + offset - bookmark.text.viewportOffsetTop,
  );
  return true;
}

/** A missing/changed text point keeps the native result, never an unrelated alias. */
function restoreReadingBookmark(
  runtime: ScrollRuntime,
  container: HTMLElement,
): boolean {
  const bookmark = runtime.readingBookmark;
  if (!bookmark) {
    return false;
  }
  if (hasScrollViewport(container)) {
    restoreTextPoint(runtime, container, bookmark);
    // A failed context check waits for a real capture instead of guessing.
    runtime.geometry = scrollGeometry(container, runtime);
  }
  return true;
}

function preserveReadingBookmark(
  runtime: ScrollRuntime,
  container: HTMLElement,
  position: ThreadScrollPosition,
): void {
  const bookmark = runtime.readingBookmark;
  if (bookmark) {
    const anchor = scrollAnchorForEvent(container, bookmark.eventId);
    const offset = anchor
      ? measureTextReadingAnchor(container, anchor, bookmark.text)
      : null;
    if (
      offset !== null &&
      (!sameScrollGeometry(
        runtime.geometry,
        scrollGeometry(container, runtime),
      ) ||
        Math.abs(offset - bookmark.text.viewportOffsetTop) <= 1)
    ) {
      // The logical point can outgrow a landscape scrollport. Another toolbar
      // opening is not reader takeover and must not select a different line.
      return;
    }
  }
  captureReadingBookmark(runtime, container, position);
}

interface ScrollRuntime {
  hiddenLayout: HiddenScrollLayout | null;
  readingBookmark: ReadingBookmark | null;
  geometry: ScrollGeometry | null;
  readerRevision: number;
  pendingRequestReaderRevision: number;
  initialized: boolean;
  hasMeasuredPosition: boolean;
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

function createCapturedPositionReader(
  runtime: ScrollRuntime,
  threadScrollPosition$: Computed<ThreadScrollPosition | null>,
) {
  return command(({ get }) => {
    return runtime.hiddenLayout
      ? runtime.hiddenLayout.position
      : get(threadScrollPosition$);
  });
}

function createRenderedPositionReader(
  runtime: ScrollRuntime,
  threadScrollPosition$: Computed<ThreadScrollPosition | null>,
  scrollContainer$: Computed<HTMLElement | null>,
) {
  return command(({ get }, excludedAnchorAncestors?: string) => {
    if (runtime.hiddenLayout) {
      return runtime.hiddenLayout.position;
    }
    const currentPosition = get(threadScrollPosition$);
    const container = get(scrollContainer$);
    if (!currentPosition || !container || !hasScrollViewport(container)) {
      return currentPosition;
    }
    if (
      isAtBottom(container) &&
      sameScrollGeometry(runtime.geometry, scrollGeometry(container, runtime))
    ) {
      return null;
    }
    // Do not recapture an existing point from post-reflow DOM.
    if (!excludedAnchorAncestors && runtime.readingBookmark) {
      return currentPosition;
    }
    return (
      captureScrollPosition(
        container,
        excludedAnchorAncestors,
        scrollAnchorForEvent(container, currentPosition.targetEventId),
      ) ?? (excludedAnchorAncestors ? null : currentPosition)
    );
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
      if (!hasScrollViewport(container)) {
        return;
      }
      if (isAtBottom(container)) {
        runtime.readingBookmark = null;
        runtime.geometry = scrollGeometry(container, runtime);
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
        captureReadingBookmark(runtime, container, position);
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
  const readCapturedThreadScrollPosition$ = createCapturedPositionReader(
    runtime,
    threadScrollPosition$,
  );
  const readRenderedThreadScrollPosition$ = createRenderedPositionReader(
    runtime,
    threadScrollPosition$,
    scrollContainer$,
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

function createDirectScrollNavigationSignals(
  threadId: string,
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
) {
  const scrollTo$ = command(({ get }, position: ThreadScrollPosition) => {
    runtime.readerRevision += 1;
    releaseHiddenLayout(runtime);
    const container = get(scroll.scrollContainer$);
    if (!container) {
      throw new Error("Chat scroll container is not mounted");
    }
    invalidateReadingBookmark(runtime);
    if (!scrollToPosition(runtime, container, position)) {
      throw new Error(
        `Chat scroll target is not rendered: ${position.targetEventId}`,
      );
    }
    runtime.initialized = true;
    captureReadingBookmark(runtime, container, position);
  });

  const scrollToBottom$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      runtime.readerRevision += 1;
      releaseHiddenLayout(runtime);
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
      invalidateReadingBookmark(runtime);
      // The DOM write happens before the awaited state clear so the jump is
      // part of the current task and cannot paint at the old offset first.
      applyScrollTop(runtime, container, container.scrollHeight);
      runtime.initialized = true;
      await set(scroll.clearThreadScrollPosition$, signal);
    },
  );

  const scrollToTop$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      runtime.readerRevision += 1;
      releaseHiddenLayout(runtime);
      const container = get(scroll.scrollContainer$);
      if (!container) {
        throw new Error("Chat scroll container is not mounted");
      }
      invalidateReadingBookmark(runtime);
      applyScrollTop(runtime, container, 0);
      runtime.initialized = true;
      await set(scroll.syncThreadScrollPosition$, container, true, signal);
    },
  );

  return { scrollTo$, scrollToTop$, scrollToBottom$ };
}

function createScrollNavigationSignals(
  threadId: string,
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
  pendingScrollAfterRenderRequest$: Computed<ScrollAfterRenderRequest | null>,
) {
  const direct = createDirectScrollNavigationSignals(threadId, scroll, runtime);
  const restoreScrollPosition$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const position = get(scroll.threadScrollPosition$);
      const container = get(scroll.scrollContainer$);
      signal.throwIfAborted();
      if (
        runtime.hiddenLayout ||
        !runtime.initialized ||
        !container ||
        !hasScrollViewport(container)
      ) {
        return;
      }
      if (
        get(pendingScrollAfterRenderRequest$) !== null &&
        runtime.hasMeasuredPosition
      ) {
        // Only the matching event-batch commit can restore preserved history.
        return;
      }
      if (
        position &&
        runtime.programmaticSmoothScrollTop === null &&
        restoreReadingBookmark(runtime, container)
      ) {
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
          captureReadingBookmark(runtime, container, position);
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
      // Layout/resource completion follows the existing tail intent without
      // converting native geometry/clamp events into a reader navigation.
      applyScrollTop(runtime, container, container.scrollHeight);
      runtime.initialized = true;
      await set(scroll.clearThreadScrollPosition$, signal);
    },
  );

  const restoreScrollPositionForLayout$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const container = get(scroll.scrollContainer$);
      if (runtime.hiddenLayout) {
        return;
      }
      if (
        get(scroll.threadScrollPosition$) !== null &&
        runtime.hasMeasuredPosition
      ) {
        if (
          container &&
          get(pendingScrollAfterRenderRequest$) === null &&
          runtime.programmaticSmoothScrollTop === null
        ) {
          restoreReadingBookmark(runtime, container);
        }
        return;
      }
      await set(restoreScrollPosition$, signal);
    },
  );

  return {
    ...direct,
    restoreScrollPosition$,
    restoreScrollPositionForLayout$,
  };
}

function createRequestScrollAfterRender(
  threadId: string,
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
  internalPendingRequest$: State<ScrollAfterRenderRequest | null>,
) {
  return command(
    async (
      { set },
      position: ThreadScrollPosition | null,
      behavior: ScrollBehavior,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (
        position === null ||
        behavior === "smooth" ||
        (runtime.readingBookmark &&
          runtime.readingBookmark.eventId !== position.targetEventId)
      ) {
        invalidateReadingBookmark(runtime);
      }
      runtime.latestRenderRequestRevision += 1;
      runtime.pendingRequestReaderRevision = runtime.readerRevision;
      // A preserved history point is already measured, even while its new
      // render window awaits the revision-owned commit.
      runtime.hasMeasuredPosition = runtime.readingBookmark !== null;
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
}

/**
 * Following the tail again commits the larger window, whose commit measures
 * the viewport and repeats until the transcript overflows or history ends. A
 * newer scroll request, such as a jump to a linked message, keeps its target
 * and measures again on its own commit.
 */
function createFillViewportWithEarlierGroups(
  runtime: ScrollRuntime,
  loadEarlierGroups$: ChatThreadScrollRenderWindow["loadEarlierGroups$"],
  requestScrollAfterRender$: ReturnType<typeof createRequestScrollAfterRender>,
) {
  return command(
    async (
      { set },
      committedRevision: number,
      signal: AbortSignal,
    ): Promise<void> => {
      const didPrepend = await set(loadEarlierGroups$, signal);
      signal.throwIfAborted();
      if (
        didPrepend &&
        runtime.latestRenderRequestRevision === committedRevision
      ) {
        await set(requestScrollAfterRender$, null, "instant", signal);
      }
    },
  );
}

function applyCommittedScroll(
  runtime: ScrollRuntime,
  container: HTMLElement,
  request: ScrollAfterRenderRequest,
  commitToTail: boolean,
): void {
  if (commitToTail) {
    invalidateReadingBookmark(runtime);
    applyScrollTop(
      runtime,
      container,
      container.scrollHeight,
      request.behavior,
    );
  } else if (
    !request.position ||
    (!restoreReadingBookmark(runtime, container) &&
      !scrollToPosition(runtime, container, request.position, request.behavior))
  ) {
    throw new Error(
      `Chat scroll target is not rendered: ${request.position?.targetEventId ?? "none"}`,
    );
  }
  runtime.initialized = true;
  if (!commitToTail && request.position && !runtime.readingBookmark) {
    captureReadingBookmark(runtime, container, request.position);
  }
}

/** Commits scroll only when React acknowledges the matching event batch. */
function createRenderScrollSignals(
  threadId: string,
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
  loadEarlierGroups$: ChatThreadScrollRenderWindow["loadEarlierGroups$"],
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
  const requestScrollAfterRender$ = createRequestScrollAfterRender(
    threadId,
    scroll,
    runtime,
    internalPendingRequest$,
  );
  const fillViewportWithEarlierGroups$ = createFillViewportWithEarlierGroups(
    runtime,
    loadEarlierGroups$,
    requestScrollAfterRender$,
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
        if (runtime.pendingRequestReaderRevision !== runtime.readerRevision) {
          set(clearPendingRequest$, revision);
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
        if (runtime.hiddenLayout) {
          // A background batch is rendered, not measured. The closing command
          // alone restores the covered transcript at its real geometry.
          set(clearPendingRequest$, revision);
          return;
        }
        const commitToTail = marker.hasAttribute(
          SCROLL_COMMIT_TO_TAIL_ATTRIBUTE,
        );
        applyCommittedScroll(runtime, container, request, commitToTail);
        // A tail that fits the viewport cannot produce the scroll event that
        // loads earlier history, so this commit requests it instead.
        const viewportUnfilled =
          commitToTail &&
          container.clientHeight > 0 &&
          container.scrollHeight <= container.clientHeight;
        set(clearPendingRequest$, revision);
        L.debug("render scroll committed", {
          threadId,
          revision,
          targetEventId: request.position?.targetEventId ?? null,
          viewportOffsetTop: request.position?.viewportOffsetTop ?? null,
          behavior: request.behavior,
          scrollTop: container.scrollTop,
        });
        if (viewportUnfilled) {
          // Like a scroll-triggered load, this outlives the marker, which
          // unmounts once its request clears.
          detach(
            set(fillViewportWithEarlierGroups$, revision, get(pageSignal$)),
            Reason.DomCallback,
            "load earlier chat history into an unfilled viewport",
          );
        }
        if (commitToTail) {
          // After the DOM write: the commit runs during React's ref phase, and
          // the offset must be applied before this frame paints.
          await set(scroll.clearThreadScrollPosition$, signal);
        }
      },
    ),
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

  return {
    autoScroll$,
    requestScrollAfterRender$,
    pendingScrollAfterRenderRequest$,
    scrollCommitOnRef$,
  };
}

type ScrollNavigationSignals = ReturnType<typeof createScrollNavigationSignals>;

function isScrollNavigationKey(event: Event): boolean {
  return (
    event instanceof KeyboardEvent &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(
      event.key,
    ) &&
    !(
      event.target instanceof Element &&
      event.target.closest("input, textarea, [contenteditable]")
    )
  );
}

function consumesVerticalWheel(element: Element, event: WheelEvent): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style || !/(auto|scroll)/.test(style.overflowY || style.overflow)) {
    return false;
  }
  const remaining =
    element.scrollHeight - element.clientHeight - element.scrollTop;
  return (
    (event.deltaY < 0 ? element.scrollTop > 0 : remaining > 0) ||
    /^(contain|none)$/.test(
      style.overscrollBehaviorY || style.overscrollBehavior,
    )
  );
}

function isReaderInputControl(event: Event, target: Element): boolean {
  return Boolean(
    target.closest("input, textarea, [contenteditable], select") ||
    (!(event instanceof WheelEvent) && target.closest("button")),
  );
}

function isReaderScrollInput(event: Event, container: HTMLElement): boolean {
  const target = event.target;
  if (!(target instanceof Element)) {
    return false;
  }
  if (
    isReaderInputControl(event, target) ||
    (event instanceof WheelEvent && event.deltaY === 0)
  ) {
    return false;
  }
  if (event instanceof KeyboardEvent && !isScrollNavigationKey(event)) {
    return false;
  }
  // The Base UI track/thumb is a sibling of the viewport, not its descendant.
  if (!container.contains(target)) {
    return Boolean(target.closest('[data-slot="scroll-area-scrollbar"]'));
  }
  if (event.type === "pointerdown" && target !== container) {
    return false;
  }
  for (
    let element: Element | null = target;
    element && element !== container;
    element = element.parentElement
  ) {
    if (event instanceof WheelEvent) {
      if (consumesVerticalWheel(element, event)) {
        return false;
      }
      continue;
    }
    const style =
      container.ownerDocument.defaultView?.getComputedStyle(element);
    if (
      style &&
      /(auto|scroll)/.test(
        style.overflow + style.overflowX + style.overflowY,
      ) &&
      (element.scrollHeight > element.clientHeight ||
        element.scrollWidth > element.clientWidth)
    ) {
      return false;
    }
  }
  return true;
}

function createReaderInputHandler(
  runtime: ScrollRuntime,
  container: HTMLElement,
) {
  return (event: Event) => {
    const cancelsHiddenSnapshot =
      runtime.hiddenLayout !== null &&
      event.type !== "touchstart" &&
      (event.type !== "keydown" || isScrollNavigationKey(event));
    if (!cancelsHiddenSnapshot && !isReaderScrollInput(event, container)) {
      return;
    }
    releaseHiddenLayout(runtime);
    if (cancelsHiddenSnapshot) {
      invalidateReadingBookmark(runtime);
    }
    // Input cancels older work, but only an actual outer scroll chooses a
    // new reading point. A motionless gesture must not discard valid prose.
    runtime.readerRevision += 1;
    runtime.latestRenderRequestRevision += 1;
    runtime.programmaticScrollTop = null;
    runtime.programmaticSmoothScrollTop = null;
    runtime.geometry = scrollGeometry(container, runtime);
  };
}

function createHandleContainerScroll(
  threadId: string,
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
) {
  return command(
    ({ set }, container: HTMLElement, event: Event, signal: AbortSignal) => {
      if (runtime.hiddenLayout || !runtime.initialized) {
        return;
      }
      // Nested scrollers do not describe the thread's position.
      if (event.target !== container || !hasScrollViewport(container)) {
        return;
      }
      const programmatic = isProgrammaticScroll(runtime, container);
      if (
        runtime.geometry &&
        !sameScrollGeometry(
          runtime.geometry,
          scrollGeometry(container, runtime),
        )
      ) {
        // Native reflow is not reader takeover. Keep the pre-reflow intent.
        return;
      }
      if (!programmatic) {
        runtime.readerRevision += 1;
        runtime.programmaticScrollTop = null;
        runtime.hasMeasuredPosition = true;
        L.debug("reader scroll captured", { threadId });
      }
      return set(
        scroll.syncThreadScrollPosition$,
        container,
        !programmatic,
        signal,
      );
    },
  );
}

function createAttachScrollContainer(
  threadId: string,
  scroll: InternalScrollSignals,
  navigation: ScrollNavigationSignals,
  runtime: ScrollRuntime,
) {
  const handleContainerScroll$ = createHandleContainerScroll(
    threadId,
    scroll,
    runtime,
  );
  return command(
    ({ get, set }, container: HTMLElement, signal: AbortSignal) => {
      set(scroll.bindScrollContainer$, container);
      L.debug("container bound", {
        threadId,
        initialized: runtime.initialized,
      });

      const inputRoot = container.parentElement;
      if (!inputRoot) {
        throw new Error("Chat scroll viewport has no interaction root");
      }
      const takeReaderControl = createReaderInputHandler(runtime, container);
      const handleScroll = onDomEventFn((event: Event) => {
        return set(handleContainerScroll$, container, event, signal);
      });
      const restoreLayout = onDomEventFn(() => {
        return set(navigation.restoreScrollPositionForLayout$, signal);
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
          const position = get(scroll.threadScrollPosition$);
          if (position) {
            captureReadingBookmark(runtime, container, position);
          }
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
      for (const event of [
        "wheel",
        "touchstart",
        "touchmove",
        "keydown",
        "pointerdown",
      ]) {
        inputRoot.addEventListener(event, takeReaderControl, {
          capture: event === "pointerdown",
          passive: true,
          signal,
        });
      }
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
          invalidateReadingBookmark(runtime);
          runtime.geometry = null;
          runtime.initialized = false;
          runtime.hasMeasuredPosition = false;
          runtime.programmaticScrollTop = null;
          runtime.programmaticSmoothScrollTop = null;
          L.debug("container unbound", { threadId });
        },
        { once: true },
      );
    },
  );
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

function createHiddenScrollLayoutSignals(
  scroll: InternalScrollSignals,
  navigation: ScrollNavigationSignals,
  runtime: ScrollRuntime,
  pendingRequest$: Computed<ScrollAfterRenderRequest | null>,
) {
  const preserveHiddenLayout$ = command(({ get, set }) => {
    const container = get(scroll.scrollContainer$);
    if (
      runtime.hiddenLayout ||
      !runtime.initialized ||
      runtime.programmaticSmoothScrollTop !== null ||
      get(pendingRequest$) !== null ||
      !container?.isConnected ||
      container.clientWidth <= 0 ||
      container.clientHeight <= 0
    ) {
      return;
    }
    let position = isAtBottom(container)
      ? null
      : captureScrollPosition(container);
    // Capture live reader movement, but keep a valid logical point across
    // native reflow even when its paragraph no longer fits the scrollport.
    if (position) {
      preserveReadingBookmark(runtime, container, position);
      const bookmark = runtime.readingBookmark;
      const anchor = bookmark
        ? scrollAnchorForEvent(container, bookmark.eventId)
        : null;
      if (bookmark && anchor && bookmark.eventId !== position.targetEventId) {
        // Render-window admission must retain the logical point's event even
        // when native reflow has exposed a different message above it.
        position = {
          targetEventId: bookmark.eventId,
          viewportOffsetTop:
            anchor.getBoundingClientRect().top -
            container.getBoundingClientRect().top,
        };
      }
    } else {
      runtime.readingBookmark = null;
    }
    runtime.hiddenLayout = {
      container,
      position,
      readingBookmark: runtime.readingBookmark,
    };
    // The mounted interaction-root listener also owns cancellation of this
    // snapshot, including pointer input on Base UI's sibling scrollbar.
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
      } else {
        runtime.readingBookmark = snapshot.readingBookmark;
        const restoredText =
          snapshot.readingBookmark !== null &&
          restoreTextPoint(runtime, container, snapshot.readingBookmark);
        if (!restoredText) {
          runtime.readingBookmark = null;
          if (!scrollToPosition(runtime, container, snapshot.position)) {
            return;
          }
          captureReadingBookmark(runtime, container, snapshot.position);
        }
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

function createIsProgrammaticScrollEvent(
  scroll: InternalScrollSignals,
  runtime: ScrollRuntime,
) {
  return command(({ get }, target: EventTarget | null): boolean => {
    const container = get(scroll.scrollContainer$);
    return (
      container !== null &&
      target === container &&
      isProgrammaticScroll(runtime, container)
    );
  });
}

export function createChatThreadScrollSignals(
  threadId: string,
  position: ThreadScrollPositionSignals,
  renderWindow: ChatThreadScrollRenderWindow,
  chatEvents$: Computed<readonly ChatEvent[]>,
  initialEventsReady$: Computed<boolean>,
): ChatThreadScrollSignals {
  const runtime: ScrollRuntime = {
    hiddenLayout: null,
    readingBookmark: null,
    geometry: null,
    readerRevision: 0,
    pendingRequestReaderRevision: 0,
    initialized: false,
    hasMeasuredPosition: false,
    latestRenderRequestRevision: 0,
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
    threadId,
    scroll,
    runtime,
    renderWindow.loadEarlierGroups$,
  );
  const navigation = createScrollNavigationSignals(
    threadId,
    scroll,
    runtime,
    render.pendingScrollAfterRenderRequest$,
  );
  const scrollContainerOnRef$ = onRef(
    createAttachScrollContainer(threadId, scroll, navigation, runtime),
  );
  const scrollContentOnRef$ = createScrollContentOnRef(threadId, navigation);
  const isProgrammaticScrollEvent$ = createIsProgrammaticScrollEvent(
    scroll,
    runtime,
  );
  const scrollToEvent$ = command(
    async (
      { get, set },
      eventId: string,
      options: ScrollToEventOptions,
      signal: AbortSignal,
    ): Promise<void> => {
      releaseHiddenLayout(runtime);
      invalidateReadingBookmark(runtime);
      runtime.readerRevision += 1;
      const readerRevision = runtime.readerRevision;
      await waitLoopUntil(
        () => {
          return get(initialEventsReady$);
        },
        16,
        signal,
      );
      signal.throwIfAborted();
      const eventExists = get(chatEvents$).some((event) => {
        return event.id === eventId;
      });
      if (!eventExists || runtime.readerRevision !== readerRevision) {
        L.debug("scroll target event unavailable", { threadId, eventId });
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
      if (runtime.readerRevision !== readerRevision) {
        return;
      }
      // Measure once the events are ready: a pane opened by a link has no
      // viewport when the scroll is requested.
      const viewportHeight = get(scroll.scrollContainer$)?.clientHeight ?? 0;
      const position: ThreadScrollPosition = {
        targetEventId: eventId,
        viewportOffsetTop: viewportHeight * options.viewportRatio,
      };
      await set(scroll.setThreadScrollPosition$, position, signal);
      signal.throwIfAborted();
      if (runtime.readerRevision === readerRevision) {
        await set(
          render.requestScrollAfterRender$,
          position,
          options.behavior,
          signal,
        );
      }
    },
  );

  const hiddenLayout = createHiddenScrollLayoutSignals(
    scroll,
    navigation,
    runtime,
    render.pendingScrollAfterRenderRequest$,
  );

  return {
    ...hiddenLayout,
    scrollContainerOnRef$,
    scrollContentOnRef$,
    scrollCommitOnRef$: render.scrollCommitOnRef$,
    pendingScrollAfterRenderRequest$: render.pendingScrollAfterRenderRequest$,
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
