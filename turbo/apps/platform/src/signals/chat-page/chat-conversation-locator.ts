/**
 * Conversation locator
 *
 * A tick rail beside a long chat thread. The rail samples the thread's user
 * turns at an even interval, so a thread of any length reads as one scale
 * rather than as a list that runs off the end. Hovering magnifies neighbouring
 * ticks and names the sampled turn under the cursor; clicking jumps to it.
 *
 * Everything the rail draws is derived from the sampled turns and the pointer.
 * The DOM contributes only the mounted scroll container when a jump needs its
 * viewport height. A turn's ref clears its CSS landing hint when it detaches.
 */

import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { logger } from "../log.ts";
import { messageDocumentToDisplayText } from "../okou-page/user-message-document-codec.ts";
import { onRef, resetSignal } from "../utils.ts";
import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import type { ScrollToEventOptions } from "./chat-thread-scroll.ts";
import { buildRunWorkFolding } from "./run-work-folding.ts";

const L = logger("ConversationLocator");

/** Rail padding above and below the tick group, in CSS pixels. */
export const RAIL_PADDING_PX = 24;
/** Ticks drawn at once. Longer threads are sampled down to this many. */
const MAX_TICKS = 24;
/** Fewer ticks read as stray dashes, not as a scale. */
const SHOW_MIN_TURNS = 8;
/** Where a jump parks its target inside the viewport. */
const JUMP_VIEWPORT_RATIO = 0.28;
/** Falloff radius, as a multiple of the tick interval, so density feels equal. */
const MAGNIFY_SIGMA_RATIO = 2.6;
/** A tick this close to the cursor is the one being named. */
const HIT_INTERVAL_RATIO = 1.1;
/** Resting length and magnification of a tick. */
const TICK_BASE_WIDTH_PX = 7;
const TICK_GROW_RATIO = 3.1;

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
}

export interface LocatorLayout {
  /** False until the thread is long enough to be worth an instrument. */
  readonly visible: boolean;
  readonly ticks: readonly LocatorTick[];
}

export interface LocatorPreview {
  readonly turnIndex: number;
  readonly text: string;
  /** ISO timestamp of the turn, or undefined when it carries none. */
  readonly createdAt: string | undefined;
  /** The magnified tick the preview is anchored to. */
  readonly tick: LocatorTick;
}

interface LocatorLanding {
  readonly eventId: string | null;
  readonly revision: number;
}

export interface ChatConversationLocatorSignals {
  readonly layout$: Computed<LocatorLayout>;
  readonly preview$: Computed<LocatorPreview | null>;
  readonly landing$: Computed<LocatorLanding>;
  readonly turnOnRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
  /** True while the pointer is over the rail. */
  readonly engaged$: Computed<boolean>;
  /** The sampled turn sequence the ticks are drawn from. */
  readonly sampledTurns$: Computed<readonly LocatorTurn[]>;
  /** Track the pointer's position along the tick scale. */
  readonly trackPointer$: Command<void, [number]>;
  readonly leaveRail$: Command<void, []>;
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
 * Every visible user turn in the thread, in order. Assistant turns are
 * deliberately absent: a run is located by the request that started it, and
 * one mark per exchange keeps the scale even.
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
    const activeGroups = get(allChatGroups$).flatMap((group) => {
      const events = group.events.filter((event) => {
        return !event.isQueued;
      });
      return events.length === 0 ? [] : [{ ...group, events }];
    });
    // Match the transcript's visible projection so every tick has a rendered
    // anchor.
    return sampleTurns(
      userTurns(buildRunWorkFolding(activeGroups).visibleGroups),
    );
  });
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
  pointerFraction$: State<number | null>,
): Computed<LocatorLayout> {
  return computed((get): LocatorLayout => {
    const turns = get(sampledTurns$);
    if (turns.length < SHOW_MIN_TURNS) {
      return { visible: false, ticks: [] };
    }
    const pointer = get(pointerFraction$);
    const interval = tickFraction(1, turns.length);
    const sigma = Math.max(interval * MAGNIFY_SIGMA_RATIO, Number.EPSILON);
    return {
      visible: true,
      ticks: turns.map((turn, index): LocatorTick => {
        const fraction = tickFraction(index, turns.length);
        return {
          turnIndex: turn.turnIndex,
          eventId: turn.eventId,
          fraction,
          width:
            pointer === null
              ? TICK_BASE_WIDTH_PX
              : magnifiedWidth(Math.abs(fraction - pointer), sigma),
        };
      }),
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

function createTurnOnRef(landing$: State<LocatorLanding>) {
  return onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      // Only user turns are jump targets. Assistant group refs have no direct
      // event anchor and therefore own no locator landing to clear.
      const eventId = element.dataset.chatScrollAnchorEventId;
      if (!eventId) {
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          const landing = get(landing$);
          if (landing.eventId === eventId) {
            set(landing$, { ...landing, eventId: null });
          }
        },
        { once: true },
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChatConversationLocatorSignals({
  threadId,
  scrollContainer$,
  allChatGroups$,
  scrollToEvent$,
}: {
  threadId: string;
  scrollContainer$: Computed<HTMLElement | null>;
  allChatGroups$: Computed<readonly ChatEventGroup[]>;
  scrollToEvent$: Command<
    Promise<void>,
    [string, ScrollToEventOptions, AbortSignal]
  >;
}): ChatConversationLocatorSignals {
  const pointerFraction$ = state<number | null>(null);
  const engaged$ = state(false);
  const internalLanding$ = state<LocatorLanding>({
    eventId: null,
    revision: 0,
  });
  const resetLandedSignal$ = resetSignal();

  const sampledTurns$ = createSampledTurns(allChatGroups$);
  const layout$ = createLayout(sampledTurns$, pointerFraction$);
  const hitIndex$ = createHitIndex(layout$, pointerFraction$);

  const preview$ = computed((get): LocatorPreview | null => {
    const hit = get(hitIndex$);
    if (hit === null) {
      return null;
    }
    const turn = get(sampledTurns$)[hit];
    const tick = get(layout$).ticks[hit];
    if (tick === undefined) {
      throw new Error("Locator hit has no matching layout tick");
    }
    return turn === undefined
      ? null
      : {
          turnIndex: turn.turnIndex,
          text: turn.text,
          createdAt: turn.createdAt,
          tick,
        };
  });

  const trackPointer$ = command(({ set }, fraction: number): void => {
    set(engaged$, true);
    // Keep coordinates outside the centered tick group so its surrounding
    // whitespace does not become a shortcut to the first or last turn.
    set(pointerFraction$, fraction);
  });

  const leaveRail$ = command(({ set }): void => {
    set(engaged$, false);
    set(pointerFraction$, null);
  });

  const turnOnRef$ = createTurnOnRef(internalLanding$);

  const jumpToTurn$ = command(
    async (
      { get, set },
      turnIndex: number,
      parentSignal: AbortSignal,
    ): Promise<void> => {
      const turn = get(sampledTurns$).find((candidate) => {
        return candidate.turnIndex === turnIndex;
      });
      const container = get(scrollContainer$);
      if (!turn || !container) {
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
      // The target may join the DOM in the pending React commit. Publishing
      // its identity lets that committed turn own the CSS highlight as well.
      set(internalLanding$, (previous) => {
        return { eventId: turn.eventId, revision: previous.revision + 1 };
      });
      signal.addEventListener(
        "abort",
        () => {
          set(internalLanding$, (previous) => {
            return { ...previous, eventId: null };
          });
        },
        { once: true },
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
    landing$: computed((get) => {
      return get(internalLanding$);
    }),
    turnOnRef$,
    engaged$: computed((get) => {
      return get(engaged$);
    }),
    sampledTurns$,
    trackPointer$,
    leaveRail$,
    jumpToPointer$,
    jumpToTurn$,
  };
}
