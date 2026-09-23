import { command, computed, state } from "ccstate";
import { composerConnectorsContract } from "@okouai/api-contracts/contracts/composer-connectors";
import { userPreferenceChangedPayloadSchema } from "@okouai/api-contracts/contracts/realtime";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$, setAblyPayloadLoop$ } from "../realtime.ts";

const reloadVersion$ = state(0);
const reload$ = command(({ set }) => {
  set(reloadVersion$, (version) => {
    return version + 1;
  });
});
const reloadFromRealtime$ = command(({ set }): boolean => {
  set(reload$);
  return false;
});
const reloadAfterPreferenceChange$ = command(
  ({ set }, payload: unknown): boolean => {
    const parsed = userPreferenceChangedPayloadSchema.safeParse(payload);
    if (
      parsed.success &&
      parsed.data.kinds.includes("cloudBrowserEnabledByDefault")
    ) {
      set(reload$);
    }
    return false;
  },
);

export const composerConnectorOverview$ = computed(async (get) => {
  get(reloadVersion$);
  const result = await accept(
    get(apiClient$)(composerConnectorsContract).overview(),
    [200],
  );
  return result.body;
});

export const subscribeComposerConnectorOverview$ = command(
  ({ set }, signal: AbortSignal) => {
    for (const topic of [
      "connector:changed",
      "customConnectorListChanged",
      "computerUseHostsChanged",
    ]) {
      set(setAblyLoop$, { topic, loopCommand$: reloadFromRealtime$ }, signal);
    }
    set(
      setAblyPayloadLoop$,
      {
        topic: "userPreferenceChanged",
        loopCommand$: reloadAfterPreferenceChange$,
      },
      signal,
    );
  },
);
