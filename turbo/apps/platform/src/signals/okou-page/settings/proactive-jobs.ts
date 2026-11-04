import { command, computed, state } from "ccstate";
import { proactiveJobsContract } from "@okouai/api-contracts/client/proactive-jobs";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { reloadProactiveSuggestionsPreference$ } from "./proactive-suggestions.ts";
import { settingsActiveSection$, settingsVisit$ } from "./settings-dialog.ts";

const revision$ = state(0);
export const proactiveJobsPreference$ = computed(async (get) => {
  get(revision$);
  get(settingsVisit$);
  get(settingsActiveSection$);
  get(featureSwitch$);
  const result = await accept(
    get(apiClient$)(proactiveJobsContract).get(),
    [200],
  );
  return result.body;
});
const reloadProactiveJobsPreference$ = command(({ set }) => {
  set(revision$, (value) => {
    return value + 1;
  });
});
export const updateProactiveJobsPreference$ = command(
  async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
    const result = await accept(
      get(apiClient$)(proactiveJobsContract).update({
        body: { enabled },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadProactiveJobsPreference$);
    set(reloadProactiveSuggestionsPreference$);
    await get(proactiveJobsPreference$);
    signal.throwIfAborted();
    return result.body;
  },
);
