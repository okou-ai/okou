import { command } from "ccstate";
import type { ProactivePreference } from "@okouai/api-contracts/contracts/proactive";
import { forYouSources$, reloadForYouSources$ } from "../for-you-sources.ts";
import { proactiveLearningContract } from "@okouai/api-contracts/client/proactive-nightly";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/client/proactive-suggestions";
import { accept } from "../../../lib/accept.ts";
import { featureSwitches$ } from "../../external/feature-switch.ts";
import { createProactivePreference } from "./proactive-preference-resource.ts";

function createWorkflowPreference(
  contract:
    typeof proactiveLearningContract | typeof proactiveSuggestionsContract,
) {
  return createProactivePreference(
    featureSwitches$,
    async (client) => {
      return (await accept(client(contract).get(), [200])).body;
    },
    async (client, enabled, signal) => {
      const request = { body: { enabled }, fetchOptions: { signal } };
      const result = await accept(client(contract).update(request), [200]);
      return { saved: true, value: result.body };
    },
  );
}

export const proactiveLearningSignals = createWorkflowPreference(
  proactiveLearningContract,
);
export const proactiveSuggestionsSignals = createWorkflowPreference(
  proactiveSuggestionsContract,
);

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
