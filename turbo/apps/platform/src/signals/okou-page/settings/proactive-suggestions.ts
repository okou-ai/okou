import { command, computed, state } from "ccstate";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/client/proactive-suggestions";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { searchParams$ } from "../../route.ts";
import { featureSwitch$ } from "../../external/feature-switch.ts";

const revision$ = state(0);
export const proactiveSuggestionsPreference$ = computed(async (get) => {
  get(revision$);
  get(searchParams$);
  get(featureSwitch$);
  const result = await accept(
    get(apiClient$)(proactiveSuggestionsContract).get(),
    [200],
  );
  return result.body;
});
export const reloadProactiveSuggestionsPreference$ = command(({ set }) => {
  set(revision$, (value) => {
    return value + 1;
  });
});
export const updateProactiveSuggestionsPreference$ = command(
  async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
    const result = await accept(
      get(apiClient$)(proactiveSuggestionsContract).update({
        body: { enabled },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadProactiveSuggestionsPreference$);
    await get(proactiveSuggestionsPreference$);
    signal.throwIfAborted();
    return result.body;
  },
);
