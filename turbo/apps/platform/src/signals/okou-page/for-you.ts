import { computed } from "ccstate";
import { searchParams$ } from "../route.ts";
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
  return {
    cards,
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
