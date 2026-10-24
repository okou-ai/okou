import { command, computed, state } from "ccstate";
import {
  proactiveLearningContract,
  proactivePlanningContract,
} from "@okouai/api-contracts/contracts/proactive-nightly";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { searchParams$ } from "../../route.ts";
import { featureSwitch$ } from "../../external/feature-switch.ts";

function createNightlyPreferenceSignals(
  contract: typeof proactiveLearningContract | typeof proactivePlanningContract,
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
      return response.body;
    },
  );
  return { preference$, reload$, update$ };
}

export const proactiveLearningSignals = createNightlyPreferenceSignals(
  proactiveLearningContract,
);
export const proactivePlanningSignals = createNightlyPreferenceSignals(
  proactivePlanningContract,
);
