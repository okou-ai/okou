import { command, computed, state } from "ccstate";
import { proactiveLearningContract } from "@okouai/api-contracts/client/proactive-nightly";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { searchParams$ } from "../../route.ts";
import { featureSwitch$ } from "../../external/feature-switch.ts";

function createNightlyPreferenceSignals(
  contract: typeof proactiveLearningContract,
) {
  const revision$ = state(0);
  const preference$ = computed(async (get) => {
    get(revision$);
    get(searchParams$);
    get(featureSwitch$);
    return (await accept(get(apiClient$)(contract).get(), [200])).body;
  });
  const reload$ = command(({ set }) => {
    set(revision$, (revision) => {
      return revision + 1;
    });
  });
  const update$ = command(
    async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
      const response = await accept(
        get(apiClient$)(contract).update({
          body: { enabled },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(reload$);
      await get(preference$);
      signal.throwIfAborted();
      return response.body;
    },
  );
  return { preference$, update$ };
}

export const proactiveLearningSignals = createNightlyPreferenceSignals(
  proactiveLearningContract,
);
