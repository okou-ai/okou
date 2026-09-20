/**
 * Conversation locator
 *
 * A tick rail beside a long chat thread. One tick per visible turn, evenly
 * spaced; hovering magnifies neighbouring ticks, names the turn under the
 * cursor in a floating preview, and clicking jumps to it.
 *
 * The turn sequence comes from the complete, non-virtual chat projection.
 * The DOM contributes geometry only for the currently rendered window; a jump
 * asks the thread scroll signals to reveal an off-window event before landing.
 */

import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { animationFrame } from "signal-timers";
import {
  chatEventDisplayError,
  isRenderableAssistantEvent,
} from "./chat-event-display.ts";
import {
  applyRunWorkExpansion,
  buildRunWorkFolding,
  runWorkExpandedKeys$,
  runWorkExpandedKeysForScrollTarget,
} from "./run-work-folding.ts";
import { logger } from "../log.ts";
import { messageDocumentToDisplayText } from "../okou-page/user-message-document-codec.ts";
import { onDomEventFn, onRef, resetSignal } from "../utils.ts";
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import type {
  ScrollToEventOptions,
  ThreadScrollPosition,
} from "./chat-thread-scroll.ts";

const L = logger("ConversationLocator");

/** Rail padding above and below the tick group. */
const RAIL_PADDING_PX = 24;
/** Comfortable tick spacing; the rail pages rather than packs tighter. */
const PITCH_MAX_PX = 10;
const PITCH_MIN_PX = 3;
/** Ticks drawn at once. Beyond this the rail becomes a window over the turns. */
const MAX_TICKS = 24;
/** Appearance floor A: fewer ticks read as stray dashes, not as a scale. */
const SHOW_MIN_TURNS = 8;
/** Appearance floor B: below this the reader can still scroll back by eye. */
const SHOW_MIN_SCREENS = 3;
/** Fraction of the viewport that decides which turn counts as "current". */
const CURRENT_TURN_VIEWPORT_RATIO = 0.38;
/** Where a jump parks its target inside the viewport. */
const JUMP_VIEWPORT_RATIO = 0.28;
/** Wheel travel that advances the window by one tick. */
const WHEEL_STEP_PX = 26;
/** Follow coefficient for the preview card; below 1 it trails the cursor. */
const POINTER_FOLLOW = 0.22;
const POINTER_OFFSET_X_PX = 26;
const POINTER_EDGE_MARGIN_PX = 16;
/** Falloff radius, as a multiple of pitch, so density does not change feel. */
const MAGNIFY_SIGMA_RATIO = 2.6;
const MAGNIFY_SIGMA_MIN_PX = 26;
/** Turns overlapping the viewport by less than this do not extend the band. */
const BAND_EDGE_SLACK_PX = 8;

/** Resting length and magnification, per role. Two discrete steps, no more. */
const TICK_METRICS = {
  user: { base: 7, grow: 3.1 },
  assistant: { base: 12, grow: 2.5 },
} as const;

/**
 * Resting width of the viewport band. The band grows by exactly as much as the
 * widest tick it covers, so a magnified bar never spills out of the frame that
 * is supposed to contain it.
 */
export const BAND_BASE_WIDTH_PX = 32;

const GROUP_SELECTOR = '[data-role="user"], [data-role="assistant"]';
const SCROLL_ANCHOR_SELECTOR = "[data-chat-scroll-anchor-event-id]";
const RUN_WORK_MAIN_SCROLL_ANCHOR_SELECTOR = `[data-chat-run-work-main] ${SCROLL_ANCHOR_SELECTOR}`;

export type LocatorRole = keyof typeof TICK_METRICS;

export interface LocatorTurn {
  readonly eventId: string;
  readonly role: LocatorRole;
  readonly text: string;
  readonly createdAt: string | undefined;
}

interface LocatorTick {
  readonly turnIndex: number;
  readonly role: LocatorRole;
  /** Integer offset from the rail top, so ticks land on device pixels. */
  readonly y: number;
  /** 0 = fully shown; 1 and 2 fade toward an edge that still has turns. */
  readonly edge: 0 | 1 | 2;
  readonly current: boolean;
}

export interface LocatorLayout {
  /** False until the thread is long enough to be worth an instrument. */
  readonly visible: boolean;
  readonly ticks: readonly LocatorTick[];
  readonly pitch: number;
  /** Band marking the turns currently inside the viewport. */
  readonly bandTop: number;
  readonly bandHeight: number;
  readonly turnCount: number;
}

export interface LocatorPreview {
  readonly turnIndex: number;
  readonly role: LocatorRole;
  readonly text: string;
  /** ISO timestamp of the turn, or undefined when it carries none. */
  readonly createdAt: string | undefined;
}

interface LocatorLanding {
  readonly eventId: string | null;
  readonly revision: number;
}

export interface ChatConversationLocatorSignals {
  readonly railOnRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
  readonly previewOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly layout$: Computed<LocatorLayout>;
  readonly preview$: Computed<LocatorPreview | null>;
  readonly landing$: Computed<LocatorLanding>;
  readonly turnOnRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
  /** True while the pointer is over the rail. */
  readonly engaged$: Computed<boolean>;
  /** Complete folded turn sequence, independent of the DOM render window. */
  readonly visibleTurns$: Computed<readonly LocatorTurn[]>;
  readonly jumpToTurn$: Command<Promise<void>, [number, AbortSignal]>;
}

function emptyLayout(): LocatorLayout {
  return {
    visible: false,
    ticks: [],
    pitch: PITCH_MAX_PX,
    bandTop: 0,
    bandHeight: 0,
    turnCount: 0,
  };
}

interface DomTurn {
  readonly element: HTMLElement;
  readonly eventId: string;
  /** Offset inside the scroll content, not the offsetParent chain. */
  readonly top: number;
  readonly height: number;
}

interface IndexedDomTurn extends DomTurn {
  readonly turnIndex: number;
}

interface LocatorMeasurement {
  readonly renderedTurns: readonly DomTurn[];
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly railHeight: number;
}

interface ResolvedLocatorLayout {
  readonly layout: LocatorLayout;
  readonly windowStart: number;
}

interface LocatorStore {
  readonly rail$: State<HTMLElement | null>;
  readonly previewElement$: State<HTMLElement | null>;
  readonly measurement$: State<LocatorMeasurement>;
  readonly preview$: State<LocatorPreview | null>;
  readonly landing$: State<LocatorLanding>;
  readonly engaged$: State<boolean>;
  readonly windowStart$: State<number>;
  readonly pagedByReader$: State<boolean>;
}

/** Per-binding pointer and scheduling bookkeeping. */
interface RailRuntime {
  pointerX: number | null;
  pointerY: number | null;
  followX: number;
  followY: number;
  followStarted: boolean;
  followRunning: boolean;
  wheelTravel: number;
  remeasurePending: boolean;
  recomputeQueued: boolean;
  magnifyQueued: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readTurnAnchor(element: HTMLElement): HTMLElement | null {
  // Expanded history precedes the main result in the DOM, while the locator
  // represents the result as the assistant turn.
  return element.matches(SCROLL_ANCHOR_SELECTOR)
    ? element
    : (element.querySelector<HTMLElement>(
        RUN_WORK_MAIN_SCROLL_ANCHOR_SELECTOR,
      ) ?? element.querySelector<HTMLElement>(SCROLL_ANCHOR_SELECTOR));
}

/**
 * Outermost group wrappers only. Assistant events nest their own `data-role`
 * markers, and the thinking indicator carries one without being a turn.
 */
function readTurns(container: HTMLElement): DomTurn[] {
  const content = container.querySelector<HTMLElement>(
    "[data-message-container]",
  );
  if (!content) {
    return [];
  }
  const containerTop = container.getBoundingClientRect().top;
  const scrollTop = container.scrollTop;
  const turns: DomTurn[] = [];
  for (const element of content.querySelectorAll<HTMLElement>(GROUP_SELECTOR)) {
    if (Object.hasOwn(element.dataset, "thinkingIndicator")) {
      continue;
    }
    if (element.parentElement?.closest(GROUP_SELECTOR)) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.height === 0) {
      continue;
    }
    const anchor = readTurnAnchor(element);
    const eventId = anchor?.dataset.chatScrollAnchorEventId;
    if (!eventId) {
      continue;
    }
    turns.push({
      element,
      eventId,
      top: rect.top - containerTop + scrollTop,
      height: rect.height,
    });
  }
  return turns;
}

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

function assistantPreviewText(event: EnrichedChatEvent): string {
  return normalizePreviewText(chatEventDisplayError(event) ?? event.content);
}

function activeGroupsForLocator(
  groups: readonly ChatEventGroup[],
): ChatEventGroup[] {
  return groups.flatMap((group) => {
    if (group.role === "assistant") {
      return [group];
    }
    const activeEvents = group.events.filter((event) => {
      return !event.isQueued;
    });
    const beginEventId = activeEvents[0]?.id;
    return beginEventId === undefined
      ? []
      : [{ ...group, beginEventId, events: activeEvents }];
  });
}

function turnsFromGroups(groups: readonly ChatEventGroup[]): LocatorTurn[] {
  return groups.flatMap((group): LocatorTurn[] => {
    if (group.role === "user") {
      return group.events.flatMap((event) => {
        return rejectedGoalForLocator(event)
          ? []
          : [
              {
                eventId: event.id,
                role: "user" as const,
                text: userPreviewText(event),
                createdAt: event.createdAt,
              },
            ];
      });
    }
    const event = group.events.find(isRenderableAssistantEvent);
    return event === undefined
      ? []
      : [
          {
            eventId: event.id,
            role: "assistant" as const,
            text: assistantPreviewText(event),
            createdAt:
              group.events.find((candidate) => {
                return candidate.id === group.beginEventId;
              })?.createdAt ?? group.events[0]?.createdAt,
          },
        ];
  });
}

function createVisibleTurns(
  allChatGroups$: Computed<readonly ChatEventGroup[]>,
  threadScrollPosition$: Computed<ThreadScrollPosition | null>,
): Computed<readonly LocatorTurn[]> {
  return computed((get): readonly LocatorTurn[] => {
    const activeGroups = activeGroupsForLocator(get(allChatGroups$));
    const targetEventId = get(threadScrollPosition$)?.targetEventId ?? null;
    const runWorkFolding = buildRunWorkFolding(activeGroups);
    const runWorkExpandedKeys = runWorkExpandedKeysForScrollTarget(
      runWorkFolding,
      get(runWorkExpandedKeys$),
      targetEventId,
    );
    return turnsFromGroups(
      applyRunWorkExpansion(activeGroups, runWorkFolding, runWorkExpandedKeys),
    );
  });
}

function indexedDomTurns(
  turns: readonly LocatorTurn[],
  renderedTurns: readonly DomTurn[],
): IndexedDomTurn[] {
  const indexByEventId = new Map(
    turns.map((turn, turnIndex) => {
      return [turn.eventId, turnIndex] as const;
    }),
  );
  return renderedTurns.flatMap((turn) => {
    const turnIndex = indexByEventId.get(turn.eventId);
    return turnIndex === undefined ? [] : [{ ...turn, turnIndex }];
  });
}

function currentTurnIndex(
  turns: readonly IndexedDomTurn[],
  scrollTop: number,
  clientHeight: number,
): number {
  const focus = scrollTop + clientHeight * CURRENT_TURN_VIEWPORT_RATIO;
  let best = turns[0]?.turnIndex ?? 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const turn of turns) {
    const distance = Math.abs(turn.top + turn.height / 2 - focus);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = turn.turnIndex;
    }
  }
  return best;
}

function edgeFor(
  offset: number,
  windowCount: number,
  moreAbove: boolean,
  moreBelow: boolean,
): 0 | 1 | 2 {
  if (
    (moreAbove && offset === 0) ||
    (moreBelow && offset === windowCount - 1)
  ) {
    return 2;
  }
  if (
    (moreAbove && offset === 1) ||
    (moreBelow && offset === windowCount - 2)
  ) {
    return 1;
  }
  return 0;
}

interface WindowGeometry {
  readonly windowStart: number;
  readonly windowCount: number;
  readonly pitch: number;
  readonly origin: number;
}

function windowGeometry(
  turnCount: number,
  railHeight: number,
  current: number,
  requestedStart: number | null,
): WindowGeometry {
  const usable = railHeight - RAIL_PADDING_PX * 2;
  const windowCount = Math.min(turnCount, MAX_TICKS);
  // Without a reader-paged window the rail follows the reading position,
  // centring the current turn.
  const preferredStart =
    requestedStart ?? Math.round(current - windowCount / 2);
  const windowStart = clamp(preferredStart, 0, turnCount - windowCount);
  // Integer pitch and origin keep every tick on a whole device pixel; a
  // half-pixel bar renders as a blurred triple line instead of a hairline.
  const pitch =
    windowCount > 1
      ? clamp(
          Math.floor(usable / (windowCount - 1)),
          PITCH_MIN_PX,
          PITCH_MAX_PX,
        )
      : 0;
  const origin = Math.round(
    RAIL_PADDING_PX + (usable - pitch * (windowCount - 1)) / 2,
  );
  return { windowStart, windowCount, pitch, origin };
}

function buildTicks(
  turns: readonly LocatorTurn[],
  geometry: WindowGeometry,
  current: number,
): LocatorTick[] {
  const { windowStart, windowCount, pitch, origin } = geometry;
  const moreAbove = windowStart > 0;
  const moreBelow = windowStart + windowCount < turns.length;
  const ticks: LocatorTick[] = [];
  for (let offset = 0; offset < windowCount; offset += 1) {
    const turnIndex = windowStart + offset;
    const turn = turns[turnIndex];
    if (!turn) {
      continue;
    }
    ticks.push({
      turnIndex,
      role: turn.role,
      y: origin + offset * pitch,
      edge: edgeFor(offset, windowCount, moreAbove, moreBelow),
      current: turnIndex === current,
    });
  }
  return ticks;
}

function buildBand(
  turns: readonly IndexedDomTurn[],
  geometry: WindowGeometry,
  scrollTop: number,
  clientHeight: number,
): { bandTop: number; bandHeight: number } {
  const { windowStart, windowCount, pitch, origin } = geometry;
  const viewportBottom = scrollTop + clientHeight;
  const turnByIndex = new Map(
    turns.map((turn) => {
      return [turn.turnIndex, turn] as const;
    }),
  );
  let first = -1;
  let last = -1;
  for (let offset = 0; offset < windowCount; offset += 1) {
    const turn = turnByIndex.get(windowStart + offset);
    if (!turn) {
      continue;
    }
    const overlaps =
      turn.top + turn.height > scrollTop + BAND_EDGE_SLACK_PX &&
      turn.top < viewportBottom - BAND_EDGE_SLACK_PX;
    if (overlaps) {
      if (first < 0) {
        first = offset;
      }
      last = offset;
    }
  }
  if (first < 0) {
    return { bandTop: 0, bandHeight: 0 };
  }
  return {
    bandTop: origin + first * pitch - pitch / 2 - 3,
    bandHeight: (last - first) * pitch + pitch + 6,
  };
}

function tickNodes(rail: HTMLElement): HTMLElement[] {
  return [...rail.querySelectorAll<HTMLElement>("[data-locator-tick]")];
}

/**
 * The band is the frame around the ticks inside the viewport, so it widens by
 * whatever its widest tick gained rather than by a growth of its own: one
 * dimension, one source, and the bars stay enclosed at every magnification.
 */
function writeBandWidth(rail: HTMLElement, growth: number): void {
  const band = rail.querySelector<HTMLElement>(
    "[data-conversation-locator-band]",
  );
  if (band) {
    band.style.width = `${(BAND_BASE_WIDTH_PX + growth).toFixed(2)}px`;
  }
}

function resetRailWidths(rail: HTMLElement): void {
  for (const node of tickNodes(rail)) {
    const role: LocatorRole =
      node.dataset.locatorTick === "user" ? "user" : "assistant";
    node.style.width = `${TICK_METRICS[role].base}px`;
    delete node.dataset.locatorHot;
  }
  writeBandWidth(rail, 0);
}

/**
 * Writes magnified widths and returns the tick under the cursor. Widths change
 * every pointer frame, so they bypass the layout signal: re-rendering the rail
 * at that rate to move a few pixels is work nobody sees.
 */
function applyMagnification(
  rail: HTMLElement,
  layout: LocatorLayout,
  pointerY: number,
): number | null {
  const nodes = tickNodes(rail);
  const sigma = Math.max(
    MAGNIFY_SIGMA_MIN_PX,
    layout.pitch * MAGNIFY_SIGMA_RATIO,
  );
  const bandBottom = layout.bandTop + layout.bandHeight;
  let bandGrowth = 0;
  let nearest = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [index, tick] of layout.ticks.entries()) {
    const node = nodes[index];
    if (!node) {
      continue;
    }
    const distance = Math.abs(tick.y - pointerY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
    const weight = Math.exp(-(distance * distance) / (2 * sigma * sigma));
    const metrics = TICK_METRICS[tick.role];
    const width = metrics.base * (1 + weight * metrics.grow);
    node.style.width = `${width.toFixed(2)}px`;
    if (tick.y >= layout.bandTop && tick.y <= bandBottom) {
      bandGrowth = Math.max(bandGrowth, width - metrics.base);
    }
  }
  writeBandWidth(rail, bandGrowth);

  // Anywhere inside the group the nearest tick is at most half a pitch away,
  // so only overshooting the first or last tick misses.
  const hit = nearest >= 0 && nearestDistance <= layout.pitch / 2 + 6;
  for (const [index, node] of nodes.entries()) {
    if (hit && index === nearest) {
      node.dataset.locatorHot = "";
    } else {
      delete node.dataset.locatorHot;
    }
  }
  return hit ? nearest : null;
}

function createStore(): LocatorStore {
  return {
    rail$: state<HTMLElement | null>(null),
    previewElement$: state<HTMLElement | null>(null),
    measurement$: state<LocatorMeasurement>({
      renderedTurns: [],
      scrollTop: 0,
      clientHeight: 0,
      scrollHeight: 0,
      railHeight: 0,
    }),
    preview$: state<LocatorPreview | null>(null),
    landing$: state<LocatorLanding>({ eventId: null, revision: 0 }),
    engaged$: state(false),
    windowStart$: state(0),
    pagedByReader$: state(false),
  };
}

function createResolvedLayout(
  store: LocatorStore,
  visibleTurns$: Computed<readonly LocatorTurn[]>,
): Computed<ResolvedLocatorLayout> {
  return computed((get): ResolvedLocatorLayout => {
    const turns = get(visibleTurns$);
    const measurement = get(store.measurement$);
    const renderedTurnCount = measurement.renderedTurns.length;
    // A virtual window's scrollHeight covers only its DOM slice. Scale that
    // measured slice to the complete turn count before applying the physical
    // screen-length floor.
    const estimatedScrollHeight =
      renderedTurnCount === 0
        ? measurement.scrollHeight
        : Math.max(
            measurement.scrollHeight,
            (measurement.scrollHeight * turns.length) / renderedTurnCount,
          );
    const enoughScroll =
      measurement.clientHeight > 0 &&
      estimatedScrollHeight >= measurement.clientHeight * SHOW_MIN_SCREENS;
    if (turns.length < SHOW_MIN_TURNS || !enoughScroll) {
      return {
        layout: { ...emptyLayout(), turnCount: turns.length },
        windowStart: 0,
      };
    }

    const renderedTurns = indexedDomTurns(turns, measurement.renderedTurns);
    const current = currentTurnIndex(
      renderedTurns,
      measurement.scrollTop,
      measurement.clientHeight,
    );
    const geometry = windowGeometry(
      turns.length,
      measurement.railHeight,
      current,
      get(store.pagedByReader$) ? get(store.windowStart$) : null,
    );
    return {
      layout: {
        visible: true,
        ticks: buildTicks(turns, geometry, current),
        pitch: geometry.pitch,
        ...buildBand(
          renderedTurns,
          geometry,
          measurement.scrollTop,
          measurement.clientHeight,
        ),
        turnCount: turns.length,
      },
      windowStart: geometry.windowStart,
    };
  });
}

/**
 * Turn offsets only move when the content reflows, so scrolling reuses the
 * last measurement instead of walking every rendered group each frame.
 */
function createRecompute(
  store: LocatorStore,
  scrollContainer$: Computed<HTMLElement | null>,
) {
  return command(({ get, set }, remeasure: boolean) => {
    const container = get(scrollContainer$);
    const rail = get(store.rail$);
    if (!container || !rail) {
      return;
    }
    const previous = get(store.measurement$);
    const next: LocatorMeasurement = {
      renderedTurns: remeasure ? readTurns(container) : previous.renderedTurns,
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      railHeight: rail.clientHeight,
    };
    if (
      next.renderedTurns === previous.renderedTurns &&
      next.scrollTop === previous.scrollTop &&
      next.clientHeight === previous.clientHeight &&
      next.scrollHeight === previous.scrollHeight &&
      next.railHeight === previous.railHeight
    ) {
      return;
    }
    set(store.measurement$, next);
  });
}

function createLayout(
  resolvedLayout$: Computed<ResolvedLocatorLayout>,
): Computed<LocatorLayout> {
  return computed((get): LocatorLayout => {
    return get(resolvedLayout$).layout;
  });
}

function createPaint(
  store: LocatorStore,
  visibleTurns$: Computed<readonly LocatorTurn[]>,
  layout$: Computed<LocatorLayout>,
) {
  return command(({ get, set }, pointerY: number | null) => {
    const rail = get(store.rail$);
    const layout = get(layout$);
    if (!rail || !layout.visible) {
      return;
    }
    if (pointerY === null) {
      resetRailWidths(rail);
      set(store.preview$, null);
      return;
    }
    const nearest = applyMagnification(rail, layout, pointerY);
    const tick = nearest === null ? undefined : layout.ticks[nearest];
    const turn = tick ? get(visibleTurns$)[tick.turnIndex] : undefined;
    const shown = get(store.preview$);
    if (!tick || !turn) {
      if (shown) {
        set(store.preview$, null);
      }
      return;
    }
    if (
      shown?.turnIndex === tick.turnIndex &&
      shown.role === tick.role &&
      shown.text === turn.text &&
      shown.createdAt === turn.createdAt
    ) {
      return;
    }
    set(store.preview$, {
      turnIndex: tick.turnIndex,
      role: tick.role,
      text: turn.text,
      createdAt: turn.createdAt,
    });
  });
}

function createJump(
  store: LocatorStore,
  threadId: string,
  visibleTurns$: Computed<readonly LocatorTurn[]>,
  scrollContainer$: Computed<HTMLElement | null>,
  scrollToEvent$: Command<
    Promise<void>,
    [string, ScrollToEventOptions, AbortSignal]
  >,
) {
  const resetLandedSignal$ = resetSignal();

  return command(
    async (
      { get, set },
      turnIndex: number,
      parentSignal: AbortSignal,
    ): Promise<void> => {
      const turn = get(visibleTurns$)[turnIndex];
      if (!turn) {
        return;
      }
      const container = get(scrollContainer$);
      if (!container) {
        return;
      }
      const signal = set(resetLandedSignal$, parentSignal);
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
      const committedContainer = get(scrollContainer$);
      const landedElement = committedContainer
        ? readTurns(committedContainer).find((candidate) => {
            return candidate.eventId === turn.eventId;
          })?.element
        : undefined;
      if (!landedElement) {
        return;
      }
      set(store.landing$, (previous) => {
        return { eventId: turn.eventId, revision: previous.revision + 1 };
      });
      signal.addEventListener(
        "abort",
        () => {
          set(store.landing$, (previous) => {
            return { ...previous, eventId: null };
          });
        },
        { once: true },
      );
    },
  );
}

function createTurnOnRef(store: LocatorStore) {
  return onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener(
        "abort",
        () => {
          const landing = get(store.landing$);
          if (
            landing.eventId ===
            readTurnAnchor(element)?.dataset.chatScrollAnchorEventId
          ) {
            set(store.landing$, { ...landing, eventId: null });
          }
        },
        { once: true },
      );
    }),
  );
}

/**
 * The preview trails the cursor instead of tracking it exactly, which is what
 * makes it read as floating beside the pointer rather than pinned to it.
 */
function followPreview(
  preview: HTMLElement,
  rail: HTMLElement,
  runtime: RailRuntime,
): void {
  if (runtime.pointerX === null || runtime.pointerY === null) {
    return;
  }
  const targetX = runtime.pointerX + POINTER_OFFSET_X_PX;
  const targetY = runtime.pointerY + rail.getBoundingClientRect().top;
  runtime.followX += (targetX - runtime.followX) * POINTER_FOLLOW;
  runtime.followY += (targetY - runtime.followY) * POINTER_FOLLOW;

  const view = rail.ownerDocument.defaultView;
  const viewportWidth = view?.innerWidth ?? 0;
  const viewportHeight = view?.innerHeight ?? 0;
  const width = preview.offsetWidth;
  const height = preview.offsetHeight;
  // Flip to the other side of the cursor rather than let the card clip.
  const x =
    runtime.followX + width > viewportWidth - POINTER_EDGE_MARGIN_PX
      ? targetX - width - POINTER_OFFSET_X_PX * 2
      : runtime.followX;
  const y = clamp(
    runtime.followY - height / 2,
    POINTER_EDGE_MARGIN_PX,
    Math.max(
      POINTER_EDGE_MARGIN_PX,
      viewportHeight - height - POINTER_EDGE_MARGIN_PX,
    ),
  );
  preview.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
}

function createFollowStep(store: LocatorStore) {
  return command(({ get }, rail: HTMLElement, runtime: RailRuntime) => {
    const preview = get(store.previewElement$);
    if (preview && runtime.followStarted) {
      followPreview(preview, rail, runtime);
    }
  });
}

function createLeaveRail(
  store: LocatorStore,
  paint$: Command<void, [number | null]>,
) {
  return command(({ get, set }) => {
    set(store.engaged$, false);
    set(paint$, null);
    // A window the reader paged by hand is theirs only while they are on the
    // rail; leaving hands it back to the reading position.
    if (get(store.pagedByReader$)) {
      set(store.pagedByReader$, false);
    }
  });
}

function createClickJump(
  store: LocatorStore,
  jumpToTurn$: Command<Promise<void>, [number, AbortSignal]>,
) {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const preview = get(store.preview$);
    if (preview) {
      await set(jumpToTurn$, preview.turnIndex, signal);
    }
  });
}

/** Returns true when the rail took the wheel, so the caller can repaint. */
function createPageWindow(
  store: LocatorStore,
  resolvedLayout$: Computed<ResolvedLocatorLayout>,
) {
  return command(({ get, set }, steps: number) => {
    const { layout, windowStart } = get(resolvedLayout$);
    if (!layout.visible || layout.turnCount <= MAX_TICKS) {
      return false;
    }
    const next = clamp(windowStart + steps, 0, layout.turnCount - MAX_TICKS);
    if (next === windowStart) {
      return false;
    }
    set(store.pagedByReader$, true);
    set(store.windowStart$, next);
    return true;
  });
}

/** True when the rail can move in this wheel event's direction. */
function createCanPageWindow(resolvedLayout$: Computed<ResolvedLocatorLayout>) {
  return command(({ get }, deltaY: number) => {
    const { layout, windowStart } = get(resolvedLayout$);
    if (!layout.visible || layout.turnCount <= MAX_TICKS || deltaY === 0) {
      return false;
    }
    return deltaY < 0
      ? windowStart > 0
      : windowStart < layout.turnCount - MAX_TICKS;
  });
}

interface RailHandlers {
  readonly pointerEnter: () => void;
  readonly pointerMove: (event: PointerEvent) => void;
  readonly pointerLeave: () => void;
  readonly click: (event: MouseEvent) => void;
  readonly wheel: (event: WheelEvent) => void;
  readonly scroll: () => void;
  readonly contentResize: () => void;
}

function installRailListeners(
  rail: HTMLElement,
  container: HTMLElement,
  handlers: RailHandlers,
): () => void {
  rail.addEventListener("pointerenter", handlers.pointerEnter);
  rail.addEventListener("pointermove", handlers.pointerMove);
  rail.addEventListener("pointerleave", handlers.pointerLeave);
  rail.addEventListener("click", handlers.click);
  rail.addEventListener("wheel", handlers.wheel, { passive: false });
  container.addEventListener("scroll", handlers.scroll, { passive: true });

  const contentObserver = new ResizeObserver(handlers.contentResize);
  const content = container.querySelector<HTMLElement>(
    "[data-message-container]",
  );
  if (content) {
    contentObserver.observe(content);
  }
  contentObserver.observe(container);

  return () => {
    rail.removeEventListener("pointerenter", handlers.pointerEnter);
    rail.removeEventListener("pointermove", handlers.pointerMove);
    rail.removeEventListener("pointerleave", handlers.pointerLeave);
    rail.removeEventListener("click", handlers.click);
    rail.removeEventListener("wheel", handlers.wheel);
    container.removeEventListener("scroll", handlers.scroll);
    contentObserver.disconnect();
  };
}

function createRuntime(): RailRuntime {
  return {
    pointerX: null,
    pointerY: null,
    followX: 0,
    followY: 0,
    followStarted: false,
    followRunning: false,
    wheelTravel: 0,
    remeasurePending: false,
    recomputeQueued: false,
    magnifyQueued: false,
  };
}

/** Records a pointer sample; returns the rail-relative Y to magnify around. */
function trackPointer(
  rail: HTMLElement,
  runtime: RailRuntime,
  event: PointerEvent,
): void {
  runtime.pointerY = event.clientY - rail.getBoundingClientRect().top;
  runtime.pointerX = event.clientX;
  if (!runtime.followStarted) {
    runtime.followX = runtime.pointerX + POINTER_OFFSET_X_PX;
    runtime.followY = event.clientY;
    runtime.followStarted = true;
  }
}

/** Consumes wheel travel and reports how many whole ticks it is worth. */
function takeWheelSteps(runtime: RailRuntime, deltaY: number): number {
  runtime.wheelTravel += deltaY;
  const steps = Math.trunc(runtime.wheelTravel / WHEEL_STEP_PX);
  runtime.wheelTravel -= steps * WHEEL_STEP_PX;
  return steps;
}

interface RailCommands {
  readonly recompute$: Command<void, [boolean]>;
  readonly paint$: Command<void, [number | null]>;
  readonly followStep$: Command<void, [HTMLElement, RailRuntime]>;
  readonly leaveRail$: Command<void, []>;
  readonly clickJump$: Command<Promise<void>, [AbortSignal]>;
  readonly pageWindow$: Command<boolean, [number]>;
  readonly canPageWindow$: Command<boolean, [number]>;
}

function createRailOnRef(
  store: LocatorStore,
  threadId: string,
  scrollContainer$: Computed<HTMLElement | null>,
  commands: RailCommands,
) {
  return onRef(
    command(({ get, set }, rail: HTMLElement, signal: AbortSignal) => {
      set(store.rail$, rail);
      L.debug("rail bound", { threadId });
      const runtime = createRuntime();
      let detachListeners: (() => void) | null = null;

      const flushFrame = () => {
        runtime.recomputeQueued = false;
        const remeasure = runtime.remeasurePending;
        runtime.remeasurePending = false;
        set(commands.recompute$, remeasure);
        // React repaints ticks at their resting width whenever the layout
        // changes, so a pointer parked on the rail needs its magnification
        // written back.
        if (runtime.pointerY !== null) {
          set(commands.paint$, runtime.pointerY);
        }
      };
      const scheduleRecompute = (remeasure: boolean) => {
        runtime.remeasurePending ||= remeasure;
        if (runtime.recomputeQueued) {
          return;
        }
        runtime.recomputeQueued = true;
        animationFrame(flushFrame, { signal });
      };
      const scheduleMagnify = () => {
        if (runtime.magnifyQueued) {
          return;
        }
        runtime.magnifyQueued = true;
        animationFrame(
          () => {
            runtime.magnifyQueued = false;
            set(commands.paint$, runtime.pointerY);
          },
          { signal },
        );
      };
      const followFrame = () => {
        if (!runtime.followRunning) {
          return;
        }
        set(commands.followStep$, rail, runtime);
        animationFrame(followFrame, { signal });
      };

      const handlers: RailHandlers = {
        pointerEnter: () => {
          set(store.engaged$, true);
          if (!runtime.followRunning) {
            runtime.followRunning = true;
            animationFrame(followFrame, { signal });
          }
        },
        pointerMove: (event) => {
          trackPointer(rail, runtime, event);
          scheduleMagnify();
        },
        pointerLeave: () => {
          runtime.pointerX = null;
          runtime.pointerY = null;
          runtime.followStarted = false;
          runtime.followRunning = false;
          runtime.wheelTravel = 0;
          set(commands.leaveRail$);
        },
        click: onDomEventFn<MouseEvent>(async () => {
          await set(commands.clickJump$, signal);
        }),
        wheel: (event) => {
          if (!set(commands.canPageWindow$, event.deltaY)) {
            runtime.wheelTravel = 0;
            return;
          }
          event.preventDefault();
          const steps = takeWheelSteps(runtime, event.deltaY);
          if (steps !== 0 && set(commands.pageWindow$, steps)) {
            scheduleMagnify();
          }
        },
        scroll: () => {
          scheduleRecompute(false);
        },
        contentResize: () => {
          scheduleRecompute(true);
        },
      };

      // The scroll viewport binds in the same commit, but ref order is not a
      // contract worth relying on, so retry rather than give up.
      const attach = () => {
        if (signal.aborted || detachListeners) {
          return;
        }
        const container = get(scrollContainer$);
        if (!container) {
          animationFrame(attach, { signal });
          return;
        }
        detachListeners = installRailListeners(rail, container, handlers);
        set(commands.recompute$, true);
      };
      attach();

      signal.addEventListener(
        "abort",
        () => {
          runtime.followRunning = false;
          detachListeners?.();
          set(store.rail$, null);
          set(store.measurement$, {
            renderedTurns: [],
            scrollTop: 0,
            clientHeight: 0,
            scrollHeight: 0,
            railHeight: 0,
          });
          set(store.preview$, null);
          set(store.engaged$, false);
          L.debug("rail unbound", { threadId });
        },
        { once: true },
      );
    }),
  );
}

function createPreviewOnRef(store: LocatorStore) {
  return onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(store.previewElement$, element);
      signal.addEventListener(
        "abort",
        () => {
          set(store.previewElement$, null);
        },
        { once: true },
      );
    }),
  );
}

export function createChatConversationLocatorSignals({
  threadId,
  scrollContainer$,
  scrollToEvent$,
  allChatGroups$,
  threadScrollPosition$,
}: {
  threadId: string;
  scrollContainer$: Computed<HTMLElement | null>;
  scrollToEvent$: Command<
    Promise<void>,
    [string, ScrollToEventOptions, AbortSignal]
  >;
  allChatGroups$: Computed<readonly ChatEventGroup[]>;
  threadScrollPosition$: Computed<ThreadScrollPosition | null>;
}): ChatConversationLocatorSignals {
  const store = createStore();
  const visibleTurns$ = createVisibleTurns(
    allChatGroups$,
    threadScrollPosition$,
  );
  const resolvedLayout$ = createResolvedLayout(store, visibleTurns$);
  const layout$ = createLayout(resolvedLayout$);
  const recompute$ = createRecompute(store, scrollContainer$);
  const paint$ = createPaint(store, visibleTurns$, layout$);
  const jumpToTurn$ = createJump(
    store,
    threadId,
    visibleTurns$,
    scrollContainer$,
    scrollToEvent$,
  );
  const railOnRef$ = createRailOnRef(store, threadId, scrollContainer$, {
    recompute$,
    paint$,
    followStep$: createFollowStep(store),
    leaveRail$: createLeaveRail(store, paint$),
    clickJump$: createClickJump(store, jumpToTurn$),
    pageWindow$: createPageWindow(store, resolvedLayout$),
    canPageWindow$: createCanPageWindow(resolvedLayout$),
  });

  return {
    railOnRef$,
    previewOnRef$: createPreviewOnRef(store),
    layout$,
    preview$: computed((get) => {
      return get(store.preview$);
    }),
    landing$: computed((get) => {
      return get(store.landing$);
    }),
    turnOnRef$: createTurnOnRef(store),
    engaged$: computed((get) => {
      return get(store.engaged$);
    }),
    visibleTurns$,
    jumpToTurn$,
  };
}
