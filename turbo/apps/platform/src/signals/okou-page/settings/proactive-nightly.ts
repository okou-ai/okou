import { command, computed, state } from "ccstate";
import { proactiveLearningContract } from "@okouai/api-contracts/client/proactive-nightly";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { searchParams$ } from "../../route.ts";
import { featureSwitch$ } from "../../external/feature-switch.ts";

const revision$ = state(0);
const preference$ = computed(async (get) => {
  get(revision$);
  get(searchParams$);
  get(featureSwitch$);
  return (await accept(get(apiClient$)(proactiveLearningContract).get(), [200]))
    .body;
});
const reload$ = command(({ set }) => {
  set(revision$, (revision) => {
    return revision + 1;
  });
});
const update$ = command(
  async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
    const response = await accept(
      get(apiClient$)(proactiveLearningContract).update({
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

export const proactiveLearningSignals = { preference$, update$ } as const;
