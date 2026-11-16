import { computed } from "ccstate";
import { searchParams$ } from "../route.ts";
import {
  agentSuggestionEntries$,
  agentSuggestionListItems$,
} from "./agent-suggestion-session.ts";

/** The URL identifies the reading position; browsing never consumes a card. */
export const forYouDeck$ = computed(async (get) => {
  const [entries, items] = await Promise.all([
    get(agentSuggestionEntries$),
    get(agentSuggestionListItems$),
  ]);
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
  return {
    cards,
    settled: items.filter(({ outcome }) => {
      return outcome !== null;
    }),
  };
});
