import { command, computed, state, type Computed } from "ccstate";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import { onDomEventFn, onRef, waitForToken } from "../utils.ts";
import {
  agentSuggestionEntries$,
  agentSuggestionListItems$,
  platformEventEntries$,
  settledFeedOrder$,
} from "./agent-suggestion-session.ts";

/** The URL identifies the reading position; browsing never consumes a card. */
export const forYouDeck$ = computed(async (get) => {
  const [suggestionEntries, suggestions, events] = await Promise.all([
    get(agentSuggestionEntries$),
    get(agentSuggestionListItems$),
    get(platformEventEntries$),
  ]);
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
  const entries = [...events, ...suggestionEntries].sort((left, right) => {
    return (
      right.item.priority - left.item.priority ||
      left.item.createdAt.localeCompare(right.item.createdAt) ||
      left.item.id.localeCompare(right.item.id)
    );
  });
  const selectedId = get(searchParams$).get("suggestion");
  const start = Math.max(
    0,
    entries.findIndex((entry) => {
      return entry.item.id === selectedId;
    }),
  );
  const waiting = items.filter(({ outcome }) => {
    return outcome === null;
  });
  const ordered = [...entries.slice(start), ...entries.slice(0, start)];
  const cards = ordered.flatMap((entry) => {
    const item = waiting.find((candidate) => {
      return candidate.entry === entry;
    });
    return item ? [item] : [];
  });
  const settledOrder = get(settledFeedOrder$);
  const progressCards = entries.flatMap((entry) => {
    const card = waiting.find((candidate) => {
      return candidate.entry === entry;
    });
    return card ? [card] : [];
  });
  return {
    cards,
    progressCards,
    illustrationIds: entries.map((entry) => {
      return entry.item.id;
    }),
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

type ForYouDeck =
  typeof forYouDeck$ extends Computed<infer Value> ? Awaited<Value> : never;
type ForYouCard = ForYouDeck["cards"][number];
type PageDirection = "previous" | "next";

interface Pagination {
  readonly from: ForYouCard;
  readonly to: string;
  readonly direction: PageDirection;
}

const paginationState$ = state<Pagination | null>(null);
const cardMinHeightState$ = state(0);

export const forYouPagination$ = computed((get) => {
  return get(paginationState$);
});

export const forYouCardMinHeight$ = computed((get) => {
  return get(cardMinHeightState$);
});

/** Keep shorter cards from shrinking the stack after a departure unmounts. */
export const measureForYouCardOnRef$ = onRef<HTMLElement>(
  command(({ get, set }, card: HTMLElement) => {
    const height = card.offsetHeight;
    if (height > get(cardMinHeightState$)) {
      set(cardMinHeightState$, height);
    }
  }),
);

export const setupForYouPagination$ = command(
  ({ set }, signal: AbortSignal) => {
    set(paginationState$, null);
    set(cardMinHeightState$, 0);
    window.addEventListener(
      "resize",
      () => {
        set(cardMinHeightState$, 0);
      },
      { signal },
    );
    signal.addEventListener(
      "abort",
      () => {
        set(paginationState$, null);
        set(cardMinHeightState$, 0);
      },
      { once: true },
    );
  },
);

export const browseForYou$ = command(
  async (
    { get, set },
    id: string,
    direction: PageDirection,
    signal: AbortSignal,
  ) => {
    const { cards } = await get(forYouDeck$);
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

/** Swipe is scoped to the card; native text inputs and links keep their gestures. */
export const swipeForYouOnRef$ = onRef<HTMLElement>(
  command(({ get, set }, card: HTMLElement, signal: AbortSignal) => {
    let origin: { x: number; y: number; id: number } | null = null;
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
        origin = { x: event.clientX, y: event.clientY, id: event.pointerId };
      },
      { signal },
    );
    card.addEventListener(
      "pointercancel",
      () => {
        origin = null;
      },
      { signal },
    );
    card.addEventListener(
      "pointerup",
      onDomEventFn(async (event: PointerEvent) => {
        const start = origin;
        origin = null;
        if (!start || start.id !== event.pointerId) {
          return;
        }
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) {
          return;
        }
        const { cards } = await get(forYouDeck$);
        signal.throwIfAborted();
        const direction = dx < 0 ? "next" : "previous";
        const target = direction === "next" ? cards[1] : cards.at(-1);
        if (target) {
          await set(browseForYou$, target.entry.item.id, direction, signal);
        }
      }),
      { signal },
    );
  }),
);
