import { command, computed, state } from "ccstate";
import { proactiveActionContract } from "@okouai/api-contracts/contracts/proactive-action";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { searchParams$ } from "../../route.ts";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { reloadProactiveSuggestionsPreference$ } from "./proactive-suggestions.ts";

const revision$ = state(0);
export const proactiveActionPreference$ = computed(async (get) => {
  get(revision$);
  get(searchParams$);
  get(featureSwitch$);
  const result = await accept(
    get(apiClient$)(proactiveActionContract).get(),
    [200],
  );
  return result.body;
});

export const reloadProactiveActionPreference$ = command(({ set }) => {
  set(revision$, (value) => {
    return value + 1;
  });
});

export const updateProactiveActionPreference$ = command(
  async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
    const result = await accept(
      get(apiClient$)(proactiveActionContract).update({
        body: { enabled },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadProactiveActionPreference$);
    set(reloadProactiveSuggestionsPreference$);
    return result.body;
  },
);
