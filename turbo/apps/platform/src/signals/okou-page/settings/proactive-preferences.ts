import { command } from "ccstate";
import type { ProactivePreference } from "@okouai/api-contracts/contracts/proactive";
import { forYouSources$, reloadForYouSources$ } from "../for-you-sources.ts";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/client/proactive-suggestions";
import { accept } from "../../../lib/accept.ts";
import { createProactivePreference } from "./proactive-preference-resource.ts";

type LinkedSuggestionsPreference = ProactivePreference & {
  readonly partial: "cardsOnly" | "hourlyOnly" | null;
};

const linkedSuggestions = createProactivePreference(
  forYouSources$,
  async (client, sources): Promise<LinkedSuggestionsPreference> => {
    const hourly = await accept(
      client(proactiveSuggestionsContract).get(),
      [200],
    );
    const { enabled } = hourly.body;
    return {
      ...hourly.body,
      partial:
        enabled === sources.suggestions
          ? null
          : enabled
            ? "hourlyOnly"
            : "cardsOnly",
    };
  },
  async (client, enabled, signal) => {
    const result = await accept(
      client(proactiveSuggestionsContract).updateWithFeed({
        body: { enabled },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    // The write commits both choices. Publish the pair together, even while
    // the feed sources and unread summary are still refreshing.
    return { saved: true, value: { ...result.body, partial: null } };
  },
);

export const myOkouSuggestionsSignals = {
  preference$: linkedSuggestions.preference$,
  update$: command(
    async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
      const value = await set(linkedSuggestions.update$, enabled, signal);
      signal.throwIfAborted();
      set(reloadForYouSources$);
      await get(linkedSuggestions.preference$);
      signal.throwIfAborted();
      return value;
    },
  ),
} as const;
