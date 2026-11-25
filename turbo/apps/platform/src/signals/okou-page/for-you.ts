import { command, computed, state, type Computed } from "ccstate";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import { onRef, waitForToken } from "../utils.ts";
import {
  agentSuggestionListItems$,
  forYouVisitEntries$,
  settledFeedOrder$,
  suggestionDirectionItemId$,
} from "./agent-suggestion-session.ts";

/** The URL identifies the reading position; browsing never consumes a card. */
export const forYouDeck$ = computed((get) => {
  const entries = get(forYouVisitEntries$);
  const suggestions = get(agentSuggestionListItems$);
  const events = entries.filter((entry) => {
    return "dismissed$" in entry;
  });
  const items = [
    ...events.map((entry) => {
      return {
        kind: "event" as const,
        entry,
        outcome: get(entry.dismissed$) ? { type: "dismissed" as const } : null,
      };
    }),
    ...suggestions.map((item) => {
      return { ...item, kind: "suggestion" as const };
    }),
  ];
  const selectedId =
    get(searchParams$).get("suggestion") ?? get(suggestionDirectionItemId$);
  const start = Math.max(
    0,
    entries.findIndex((entry) => {
      return entry.item.id === selectedId;
    }),
  );
  const waiting = new Map(
    items
      .filter(({ outcome }) => {
        return outcome === null;
      })
      .map((item) => {
        return [item.entry, item];
      }),
  );
  const cardFor = (entry: (typeof entries)[number]) => {
    const item = waiting.get(entry);
    return item ? [item] : [];
  };
  const cards = [...entries.slice(start), ...entries.slice(0, start)].flatMap(
    cardFor,
  );
  const settledOrder = get(settledFeedOrder$);
  return {
    cards,
    waiting,
    settled: items
      .filter(({ outcome }) => {
        return outcome !== null;
      })
      .sort((left, right) => {
        return (
          settledOrder.indexOf(left.entry.item.id) -
          settledOrder.indexOf(right.entry.item.id)
        );
      }),
  };
});

export type ForYouDeck =
  typeof forYouDeck$ extends Computed<infer Value> ? Value : never;
type ForYouCard = ForYouDeck["cards"][number];
type PageDirection = "previous" | "next";

interface Pagination {
  readonly from: ForYouCard;
  readonly to: string;
  readonly direction: PageDirection;
}

const paginationState$ = state<Pagination | null>(null);

export const forYouPagination$ = computed((get) => {
  return get(paginationState$);
});

export const setupForYouPagination$ = command(
  ({ set }, signal: AbortSignal) => {
    set(paginationState$, null);
    signal.addEventListener(
      "abort",
      () => {
        set(paginationState$, null);
      },
      { once: true },
    );
  },
);

export const browseForYou$ = command(
  ({ get, set }, id: string, direction: PageDirection, signal: AbortSignal) => {
    const { cards } = get(forYouDeck$);
    signal.throwIfAborted();
    const from = cards[0];
    if (!from || from.entry.item.id === id) {
      return;
    }
    set(
      paginationState$,
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? null
        : { from, to: id, direction },
    );
    // Preserve the visit snapshot and native modifier-key navigation.
    set(updateSearchParams$, new URLSearchParams({ suggestion: id }));
  },
);

/** The departing card owns its native animation, including cancellation. */
export const finishForYouPaginationOnRef$ = onRef(
  command(async ({ get, set }, card: HTMLElement, signal: AbortSignal) => {
    const pagination = get(forYouPagination$);
    const animations = card.getAnimations();
    await waitForToken(
      Promise.allSettled(
        animations.map((animation) => {
          return animation.finished;
        }),
      ),
      signal,
    );
    signal.throwIfAborted();
    // A rapid second click replaces this departure; its completion cannot
    // remove the newer outgoing card.
    if (get(forYouPagination$) === pagination) {
      set(paginationState$, null);
    }
  }),
);

/** How far a dragged card follows the pointer before it starts to resist. */
const DRAG_REACH = 160;

function dragOffset(dx: number) {
  const reach = Math.abs(dx);
  return (
    Math.sign(dx) *
    (reach <= DRAG_REACH ? reach : DRAG_REACH + (reach - DRAG_REACH) * 0.35)
  );
}

/**
 * Swipe is scoped to the card, which follows the pointer while it is dragged
 * sideways; native text inputs and links keep their gestures. A drag far
 * enough pages from where the card was let go, through the departure
 * animation's `--for-you-drag-x` start; a shorter one springs back.
 */
export const swipeForYouOnRef$ = onRef<HTMLElement>(
  command(({ get, set }, area: HTMLElement, signal: AbortSignal) => {
    const card =
      area.closest<HTMLElement>('[data-slot="suggestion-stack-card"]') ?? area;
    let origin: {
      x: number;
      y: number;
      id: number;
      dragging: boolean;
      offset: number;
    } | null = null;
    // The card returns from where it was let go; the animation covers the
    // jump as the offset clears in the same frame.
    const springBack = (offset: number) => {
      delete card.dataset.dragging;
      card.style.removeProperty("--for-you-drag-x");
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        card.animate(
          [
            { transform: `translateX(${String(offset)}px)` },
            { transform: "translateX(0)" },
          ],
          { duration: 320, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
        );
      }
    };
    card.addEventListener(
      "pointerdown",
      (event) => {
        if (
          event.button !== 0 ||
          !(event.target instanceof Element) ||
          event.target.closest(
            "button,a,input,textarea,select,[contenteditable],form",
          )
        ) {
          return;
        }
        origin = {
          x: event.clientX,
          y: event.clientY,
          id: event.pointerId,
          dragging: false,
          offset: 0,
        };
      },
      { signal },
    );
    card.addEventListener(
      "pointermove",
      (event) => {
        const start = origin;
        if (!start || start.id !== event.pointerId) {
          return;
        }
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!start.dragging) {
          if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            start.dragging = true;
            card.setPointerCapture(event.pointerId);
            card.dataset.dragging = "";
            window.getSelection()?.removeAllRanges();
          } else if (Math.abs(dy) > 10) {
            origin = null;
          }
          return;
        }
        start.offset = dragOffset(dx);
        card.style.setProperty("--for-you-drag-x", `${String(start.offset)}px`);
      },
      { signal },
    );
    card.addEventListener(
      "pointercancel",
      () => {
        const start = origin;
        origin = null;
        if (start?.dragging) {
          springBack(start.offset);
        }
      },
      { signal },
    );
    card.addEventListener(
      "pointerup",
      (event: PointerEvent) => {
        const start = origin;
        origin = null;
        if (!start || start.id !== event.pointerId) {
          return;
        }
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) {
          if (start.dragging) {
            springBack(start.offset);
          }
          return;
        }
        // The card keeps its drag offset: the departure starts from it, and the
        // card leaves the deck when the departure ends.
        const { cards } = get(forYouDeck$);
        signal.throwIfAborted();
        const direction = dx < 0 ? "next" : "previous";
        const target = direction === "next" ? cards[1] : cards.at(-1);
        if (target && target !== cards[0]) {
          set(browseForYou$, target.entry.item.id, direction, signal);
        } else {
          springBack(start.offset);
        }
      },
      { signal },
    );
  }),
);
