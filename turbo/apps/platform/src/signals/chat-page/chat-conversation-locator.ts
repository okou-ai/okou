/**
 * Conversation locator
 *
 * A tick rail beside a long chat thread. The rail samples the thread's user
 * turns at an even interval, so a thread of any length reads as one scale
 * rather than as a list that runs off the end. Hovering magnifies neighbouring
 * ticks and names the sampled turn under the cursor; clicking jumps to it.
 *
 * Everything the rail draws is derived. The DOM contributes exactly one thing:
 * a viewport reading taken by `measure$`, which reports where the reader is as
 * two ratios plus the id of the turn they are looking at. Nothing else reads or
 * writes the DOM, and no element is held in a signal other than the scroll
 * container the reading is taken from.
 *
 * The reading is taken only when the reader moves the viewport: on scroll and
 * on resize. Content arriving during a run does not take one, because a reader
 * who is not scrolling has not changed where they are; the next scroll settles
 * the band. That keeps one synchronous read per trigger, each under the signal
 * of the scope that asked for it, with nothing queued between lifetimes.
 */

import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { timeout } from "signal-timers";
import { logger } from "../log.ts";
import { messageDocumentToDisplayText } from "../okou-page/user-message-document-codec.ts";
import { resetSignal } from "../utils.ts";
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import type { ScrollToEventOptions } from "./chat-thread-scroll.ts";

const L = logger("ConversationLocator");

/** Rail padding above and below the tick group, in CSS pixels. */
export const RAIL_PADDING_PX = 24;
/** Ticks drawn at once. Longer threads are sampled down to this many. */
const MAX_TICKS = 24;
/** Appearance floor A: fewer ticks read as stray dashes, not as a scale. */
const SHOW_MIN_TURNS = 8;
/** Appearance floor B: below this the reader can still scroll back by eye. */
const SHOW_MIN_SCREENS = 3;
/** Fraction of the viewport that decides which turn counts as "current". */
const CURRENT_TURN_VIEWPORT_RATIO = 0.38;
/** Where a jump parks its target inside the viewport. */
const JUMP_VIEWPORT_RATIO = 0.28;
/** Falloff radius, as a multiple of the tick interval, so density feels equal. */
const MAGNIFY_SIGMA_RATIO = 2.6;
/** A tick this close to the cursor is the one being named. */
const HIT_INTERVAL_RATIO = 0.5;
/** How long a jumped-to turn stays marked. */
const LANDED_MARK_MS = 1200;
/** Resting length and magnification of a tick. */
const TICK_BASE_WIDTH_PX = 7;
const TICK_GROW_RATIO = 3.1;

/**
 * Resting width of the viewport band. The band grows by exactly as much as the
 * widest tick it covers, so a magnified bar never spills out of the frame that
 * is supposed to contain it.
 */
const BAND_BASE_WIDTH_PX = 32;

const SCROLL_ANCHOR_SELECTOR = "[data-chat-scroll-anchor-event-id]";

/** One sampled user turn. `turnIndex` indexes the complete turn list. */
export interface LocatorTurn {
  readonly eventId: string;
  readonly turnIndex: number;
  readonly text: string;
  readonly createdAt: string | undefined;
}

export interface LocatorTick {
  readonly turnIndex: number;
  readonly eventId: string;
  /** Position along the rail track, 0 at the top and 1 at the bottom. */
  readonly fraction: number;
  /** Already magnified for the current pointer position, in CSS pixels. */
  readonly width: number;
  readonly current: boolean;
}

export interface LocatorLayout {
  /** False until the thread is long enough to be worth an instrument. */
  readonly visible: boolean;
  readonly ticks: readonly LocatorTick[];
  /** Band marking the part of the thread inside the viewport, 0..1. */
  readonly bandStart: number;
  readonly bandSize: number;
  /** Band width in CSS pixels, grown to enclose its widest tick. */
  readonly bandWidth: number;
  readonly turnCount: number;
}

export interface LocatorPreview {
  readonly turnIndex: number;
  readonly text: string;
  /** ISO timestamp of the turn, or undefined when it carries none. */
  readonly createdAt: string | undefined;
  /** Viewport y of the pointer, so the card can sit beside it. */
  readonly pointerClientY: number;
}

/** What `measure$` reads off the scroll container, and nothing more. */
interface LocatorViewportReading {
  /** Top of the viewport within the scrollable range, 0..1. */
  readonly startRatio: number;
  /** Fraction of the scrollable content currently visible, 0..1. */
  readonly visibleRatio: number;
  /** The turn the reader is looking at, by event id. */
  readonly currentEventId: string | null;
  /** False until the thread is physically long enough to instrument. */
  readonly enoughScroll: boolean;
}

function emptyReading(): LocatorViewportReading {
  return {
    startRatio: 0,
    visibleRatio: 1,
    currentEventId: null,
    enoughScroll: false,
  };
}

/**
 * The viewport half of the locator. It owns the scroll container reference and
 * the reading taken from it, and depends on nothing else, so the thread factory
 * can build it before the signals whose commands need to request a reading.
 */
export interface LocatorViewportSignals {
  /**
   * Binds the scroll container the reading is taken from. Unwrapped so the
   * thread factory gives the element one `onRef` lifetime for both owners.
   */
  readonly attachContainer$: Command<void, [HTMLElement, AbortSignal]>;
  readonly reading$: Computed<LocatorViewportReading>;
  /** Takes the viewport reading synchronously, under the caller's signal. */
  readonly measure$: Command<void, [AbortSignal]>;
  readonly container$: Computed<HTMLElement | null>;
}

export interface ChatConversationLocatorSignals {
  readonly layout$: Computed<LocatorLayout>;
  readonly preview$: Computed<LocatorPreview | null>;
  /** True while the pointer is over the rail. */
  readonly engaged$: Computed<boolean>;
  /** The sampled turn sequence the ticks are drawn from. */
  readonly sampledTurns$: Computed<readonly LocatorTurn[]>;
  /** Track the pointer as a rail fraction plus its viewport y. */
  readonly trackPointer$: Command<void, [number, number]>;
  readonly leaveRail$: Command<void, []>;
  /** Takes the viewport reading synchronously, under the caller's signal. */
  readonly measure$: Command<void, [AbortSignal]>;
  readonly jumpToPointer$: Command<Promise<void>, [AbortSignal]>;
  readonly jumpToTurn$: Command<Promise<void>, [number, AbortSignal]>;
}

// ---------------------------------------------------------------------------
// Turn projection
// ---------------------------------------------------------------------------

function normalizePreviewText(value: string | null | undefined): string {
  return value?.replace(/\s+/gu, " ").trim() ?? "";
}

function userMessageForLocator(event: EnrichedChatEvent) {
  return "userMessage" in event ? event.userMessage : undefined;
}

function userMessageAnnotationForLocator(event: EnrichedChatEvent) {
  return userMessageForLocator(event)?.parts.find((part) => {
    return part.type === "automation" || part.type === "goal";
  });
}

function rejectedGoalForLocator(event: EnrichedChatEvent): boolean {
  return (
    event.eventType === "input.rejected" &&
    userMessageAnnotationForLocator(event)?.type === "goal"
  );
}

function userPreviewText(event: EnrichedChatEvent): string {
  const messageText = normalizePreviewText(
    messageDocumentToDisplayText(userMessageForLocator(event)),
  );
  if (messageText) {
    return messageText;
  }
  const annotation = userMessageAnnotationForLocator(event);
  if (annotation?.type === "goal") {
    return normalizePreviewText(annotation.goalBrief);
  }
  if (annotation?.type === "automation") {
    const brief = normalizePreviewText(annotation.automationBrief);
    return brief || normalizePreviewText(annotation.workflowName);
  }
  return normalizePreviewText(event.content);
}

/**
 * Every user turn in the thread, in order. Assistant turns are deliberately
 * absent: a run is located by the request that started it, and one mark per
 * exchange keeps the scale even.
 */
function userTurns(groups: readonly ChatEventGroup[]): LocatorTurn[] {
  const turns: LocatorTurn[] = [];
  for (const group of groups) {
    if (group.role !== "user") {
      continue;
    }
    for (const event of group.events) {
      if (event.isQueued || rejectedGoalForLocator(event)) {
        continue;
      }
      turns.push({
        eventId: event.id,
        turnIndex: turns.length,
        text: userPreviewText(event),
        createdAt: event.createdAt,
      });
    }
  }
  return turns;
}

/**
 * At most `MAX_TICKS` marks spread evenly over the whole thread. Sampling
 * rather than windowing is what removes the rail's own navigation: there is no
 * off-screen remainder to page through, so the reader only ever moves the
 * thread.
 */
function sampleTurns(turns: readonly LocatorTurn[]): readonly LocatorTurn[] {
  if (turns.length <= MAX_TICKS) {
    return turns;
  }
  const sampled: LocatorTurn[] = [];
  for (let index = 0; index < MAX_TICKS; index += 1) {
    const source = Math.round((index * (turns.length - 1)) / (MAX_TICKS - 1));
    const turn = turns[source];
    if (turn && sampled.at(-1)?.turnIndex !== turn.turnIndex) {
      sampled.push(turn);
    }
  }
  return sampled;
}

function createSampledTurns(
  allChatGroups$: Computed<readonly ChatEventGroup[]>,
): Computed<readonly LocatorTurn[]> {
  return computed((get): readonly LocatorTurn[] => {
    return sampleTurns(userTurns(get(allChatGroups$)));
  });
}

// ---------------------------------------------------------------------------
// Viewport reading
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The event id nearest the reading focus. This is the one place the locator
 * walks the DOM, and it leaves with a single id rather than a table of
 * rectangles: turn geometry belongs to the transcript, not to the rail.
 */
function currentEventIdAt(
  container: HTMLElement,
  focus: number,
): string | null {
  const containerTop = container.getBoundingClientRect().top;
  const scrollTop = container.scrollTop;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of container.querySelectorAll<HTMLElement>(
    SCROLL_ANCHOR_SELECTOR,
  )) {
    const eventId = anchor.dataset.chatScrollAnchorEventId;
    if (!eventId) {
      continue;
    }
    const rect = anchor.getBoundingClientRect();
    if (rect.height === 0) {
      continue;
    }
    const top = rect.top - containerTop + scrollTop;
    const distance = Math.abs(top - focus);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = eventId;
    }
  }
  return best;
}

function readViewport(container: HTMLElement): LocatorViewportReading {
  const { scrollTop, scrollHeight, clientHeight } = container;
  if (clientHeight === 0) {
    return emptyReading();
  }
  const range = Math.max(scrollHeight - clientHeight, 0);
  return {
    startRatio: range === 0 ? 0 : clamp(scrollTop / range, 0, 1),
    visibleRatio: clamp(clientHeight / Math.max(scrollHeight, 1), 0, 1),
    currentEventId: currentEventIdAt(
      container,
      scrollTop + clientHeight * CURRENT_TURN_VIEWPORT_RATIO,
    ),
    enoughScroll: scrollHeight >= clientHeight * SHOW_MIN_SCREENS,
  };
}

function sameReading(
  a: LocatorViewportReading,
  b: LocatorViewportReading,
): boolean {
  return (
    a.startRatio === b.startRatio &&
    a.visibleRatio === b.visibleRatio &&
    a.currentEventId === b.currentEventId &&
    a.enoughScroll === b.enoughScroll
  );
}

export function createLocatorViewportSignals(): LocatorViewportSignals {
  const internalContainer$ = state<HTMLElement | null>(null);
  const internalReading$ = state<LocatorViewportReading>(emptyReading());
  const container$ = computed((get) => {
    return get(internalContainer$);
  });
  const reading$ = computed((get) => {
    return get(internalReading$);
  });

  const measure$ = command(({ get, set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    const container = get(internalContainer$);
    if (!container) {
      return;
    }
    const next = readViewport(container);
    if (!sameReading(next, get(internalReading$))) {
      set(internalReading$, next);
    }
  });

  const attachContainer$ = command(
    ({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(internalContainer$, element);
      // The reading only exists while the container does, so the window
      // listener is that element's resource and shares its lifetime.
      // A window listener owned by this element's lifetime, taking the same
      // synchronous reading the scroll handler takes.
      globalThis.addEventListener(
        "resize",
        () => {
          set(measure$, signal);
        },
        { signal },
      );
      set(measure$, signal);
      signal.addEventListener(
        "abort",
        () => {
          set(internalContainer$, null);
          set(internalReading$, emptyReading());
        },
        { once: true },
      );
    },
  );

  return {
    attachContainer$,
    container$,
    reading$,
    measure$,
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function tickFraction(index: number, count: number): number {
  return count <= 1 ? 0.5 : index / (count - 1);
}

function magnifiedWidth(distance: number, sigma: number): number {
  const weight = Math.exp(-(distance * distance) / (2 * sigma * sigma));
  return TICK_BASE_WIDTH_PX * (1 + weight * TICK_GROW_RATIO);
}

function createLayout(
  sampledTurns$: Computed<readonly LocatorTurn[]>,
  reading$: Computed<LocatorViewportReading>,
  pointerFraction$: State<number | null>,
): Computed<LocatorLayout> {
  return computed((get): LocatorLayout => {
    const turns = get(sampledTurns$);
    const reading = get(reading$);
    if (turns.length < SHOW_MIN_TURNS || !reading.enoughScroll) {
      return {
        visible: false,
        ticks: [],
        bandStart: 0,
        bandSize: 0,
        bandWidth: BAND_BASE_WIDTH_PX,
        turnCount: turns.length,
      };
    }
    const pointer = get(pointerFraction$);
    const interval = tickFraction(1, turns.length);
    const sigma = Math.max(interval * MAGNIFY_SIGMA_RATIO, Number.EPSILON);
    // The band spans the visible slice of the thread, positioned so a reader at
    // the bottom sees it flush with the last tick rather than overhanging it.
    const bandSize = clamp(reading.visibleRatio, 0, 1);
    const bandStart = clamp(reading.startRatio * (1 - bandSize), 0, 1);
    const bandEnd = bandStart + bandSize;
    let bandWidth = BAND_BASE_WIDTH_PX;
    const ticks = turns.map((turn, index): LocatorTick => {
      const fraction = tickFraction(index, turns.length);
      const width =
        pointer === null
          ? TICK_BASE_WIDTH_PX
          : magnifiedWidth(Math.abs(fraction - pointer), sigma);
      if (fraction >= bandStart && fraction <= bandEnd) {
        bandWidth = Math.max(
          bandWidth,
          BAND_BASE_WIDTH_PX + width - TICK_BASE_WIDTH_PX,
        );
      }
      return {
        turnIndex: turn.turnIndex,
        eventId: turn.eventId,
        fraction,
        width,
        current: turn.eventId === reading.currentEventId,
      };
    });
    return {
      visible: true,
      ticks,
      bandStart,
      bandSize,
      bandWidth,
      turnCount: turns.length,
    };
  });
}

/** The sampled turn the cursor is naming, or none when it is between marks. */
function createHitIndex(
  layout$: Computed<LocatorLayout>,
  pointerFraction$: State<number | null>,
): Computed<number | null> {
  return computed((get): number | null => {
    const pointer = get(pointerFraction$);
    const layout = get(layout$);
    if (pointer === null || !layout.visible || layout.ticks.length === 0) {
      return null;
    }
    const interval = tickFraction(1, layout.ticks.length);
    let best: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [index, tick] of layout.ticks.entries()) {
      const distance = Math.abs(tick.fraction - pointer);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return bestDistance <= interval * HIT_INTERVAL_RATIO ? best : null;
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChatConversationLocatorSignals({
  threadId,
  viewport,
  allChatGroups$,
  scrollToEvent$,
}: {
  threadId: string;
  viewport: LocatorViewportSignals;
  allChatGroups$: Computed<readonly ChatEventGroup[]>;
  scrollToEvent$: Command<
    Promise<void>,
    [string, ScrollToEventOptions, AbortSignal]
  >;
}): ChatConversationLocatorSignals {
  const pointerFraction$ = state<number | null>(null);
  const pointerClientY$ = state(0);
  const engaged$ = state(false);
  const resetLandedSignal$ = resetSignal();

  const sampledTurns$ = createSampledTurns(allChatGroups$);
  const layout$ = createLayout(
    sampledTurns$,
    viewport.reading$,
    pointerFraction$,
  );
  const hitIndex$ = createHitIndex(layout$, pointerFraction$);

  const preview$ = computed((get): LocatorPreview | null => {
    const hit = get(hitIndex$);
    if (hit === null) {
      return null;
    }
    const turn = get(sampledTurns$)[hit];
    return turn === undefined
      ? null
      : {
          turnIndex: turn.turnIndex,
          text: turn.text,
          createdAt: turn.createdAt,
          pointerClientY: get(pointerClientY$),
        };
  });

  const trackPointer$ = command(
    ({ set }, fraction: number, clientY: number): void => {
      set(engaged$, true);
      set(pointerFraction$, clamp(fraction, 0, 1));
      set(pointerClientY$, clientY);
    },
  );

  const leaveRail$ = command(({ set }): void => {
    set(engaged$, false);
    set(pointerFraction$, null);
  });

  const jumpToTurn$ = command(
    async (
      { get, set },
      turnIndex: number,
      signal: AbortSignal,
    ): Promise<void> => {
      const turn = get(sampledTurns$).find((candidate) => {
        return candidate.turnIndex === turnIndex;
      });
      const container = get(viewport.container$);
      if (!turn || !container) {
        return;
      }
      L.debug("jump to turn", { threadId, turnIndex, eventId: turn.eventId });
      await set(
        scrollToEvent$,
        turn.eventId,
        {
          behavior: "smooth",
          viewportOffsetTop: container.clientHeight * JUMP_VIEWPORT_RATIO,
          preloadPreviousRenderWindow: true,
        },
        signal,
      );
      signal.throwIfAborted();
      const landed = get(viewport.container$)?.querySelector<HTMLElement>(
        `[data-chat-scroll-anchor-event-id="${CSS.escape(turn.eventId)}"]`,
      );
      if (!landed) {
        return;
      }
      const landedSignal = set(resetLandedSignal$, signal);
      landed.dataset.locatorLanded = "";
      const clearLanded = () => {
        delete landed.dataset.locatorLanded;
      };
      landedSignal.addEventListener("abort", clearLanded, { once: true });
      timeout(
        () => {
          landedSignal.removeEventListener("abort", clearLanded);
          clearLanded();
        },
        LANDED_MARK_MS,
        { signal: landedSignal },
      );
    },
  );

  const jumpToPointer$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const hit = get(hitIndex$);
      const turn = hit === null ? undefined : get(sampledTurns$)[hit];
      if (turn) {
        await set(jumpToTurn$, turn.turnIndex, signal);
      }
    },
  );

  return {
    layout$,
    preview$,
    engaged$: computed((get) => {
      return get(engaged$);
    }),
    sampledTurns$,
    trackPointer$,
    leaveRail$,
    measure$: viewport.measure$,
    jumpToPointer$,
    jumpToTurn$,
  };
}
