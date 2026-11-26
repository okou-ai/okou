import { command, computed, state, type Computed } from "ccstate";
import { searchParams$, updateSearchParams$ } from "../route.ts";
import { onRef, waitForToken } from "../utils.ts";
import {
  agentSuggestionListItems$,
  forYouVisitSnapshot$,
  settledFeedOrder$,
  suggestionDirectionItemId$,
} from "./agent-suggestion-session.ts";

/** The URL identifies the reading position; browsing never consumes a card. */
export const forYouDeck$ = computed((get) => {
  const snapshot = get(forYouVisitSnapshot$);
  const entries = snapshot?.entries ?? [];
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
    remainingIds:
      snapshot?.source === "list"
        ? entries
            .filter((entry) => {
              return waiting.has(entry);
            })
            .map((entry) => {
              return entry.item.id;
            })
        : undefined,
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
      (event: PointerEvent) => {
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
        const { cards } = get(forYouDeck$);
        signal.throwIfAborted();
        const direction = dx < 0 ? "next" : "previous";
        const target = direction === "next" ? cards[1] : cards.at(-1);
        if (target && target !== cards[0]) {
          set(browseForYou$, target.entry.item.id, direction, signal);
        }
      },
      { signal },
    );
  }),
);

// Arrow keys already mean something inside these: moving the caret, choosing a
// cover or a menu item, scrolling a list.
const ARROW_KEY_OWNERS = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="radiogroup"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="tablist"]',
  '[role="tab"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="grid"]',
  '[role="tree"]',
  '[role="dialog"]',
].join(",");

function pagingKey(event: KeyboardEvent): PageDirection | null {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return null;
  }
  return event.key === "ArrowLeft"
    ? "previous"
    : event.key === "ArrowRight"
      ? "next"
      : null;
}

/** Keys pressed in a field, a control that uses the arrows, or elsewhere. */
function keyBelongsElsewhere(event: KeyboardEvent, page: HTMLElement) {
  const target = event.target;
  return (
    target instanceof Element &&
    target !== page.ownerDocument.body &&
    (!page.contains(target) || target.closest(ARROW_KEY_OWNERS) !== null)
  );
}

/** The card the arrows lead to, wrapping round at either end. */
function pageTarget(deck: ForYouDeck, direction: PageDirection) {
  const { cards, remainingIds } = deck;
  const current = cards[0]?.entry.item.id;
  if (!remainingIds || remainingIds.length < 2 || current === undefined) {
    return undefined;
  }
  const position = remainingIds.indexOf(current);
  if (position === -1) {
    return undefined;
  }
  const step = direction === "next" ? 1 : remainingIds.length - 1;
  return remainingIds[(position + step) % remainingIds.length];
}

/**
 * ← and → page the deck the way its arrows do, while focus rests on the page
 * rather than in a field or a control that uses the arrows itself. A
 * direction being written keeps its card, since paging would discard it.
 */
export const pageForYouWithKeysOnRef$ = onRef<HTMLElement>(
  command(({ get, set }, page: HTMLElement, signal: AbortSignal) => {
    page.ownerDocument.addEventListener(
      "keydown",
      (event) => {
        const direction = pagingKey(event);
        if (
          direction === null ||
          keyBelongsElsewhere(event, page) ||
          get(suggestionDirectionItemId$) !== null
        ) {
          return;
        }
        const id = pageTarget(get(forYouDeck$), direction);
        if (id === undefined) {
          return;
        }
        // The key pages the deck instead of also scrolling whatever has
        // focus sideways.
        event.preventDefault();
        set(browseForYou$, id, direction, signal);
      },
      { signal },
    );
  }),
);
