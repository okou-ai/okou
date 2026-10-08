import { command, computed, state } from "ccstate";
import { connectorOverviewContract } from "@okouai/api-contracts/contracts/connector-overview";
import { userPreferenceChangedPayloadSchema } from "@okouai/api-contracts/contracts/realtime";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$, setAblyPayloadLoop$ } from "../realtime.ts";

const reloadVersion$ = state(0);
export const invalidateConnectorOverview$ = command(({ set }) => {
  set(reloadVersion$, (version) => {
    return version + 1;
  });
});
const reloadFromRealtime$ = command(({ set }): boolean => {
  set(invalidateConnectorOverview$);
  return false;
});
const reloadAfterPreferenceChange$ = command(
  ({ set }, payload: unknown): boolean => {
    const parsed = userPreferenceChangedPayloadSchema.safeParse(payload);
    if (
      parsed.success &&
      parsed.data.kinds.includes("cloudBrowserEnabledByDefault")
    ) {
      set(invalidateConnectorOverview$);
    }
    return false;
  },
);

export const connectorOverview$ = computed(async (get) => {
  get(reloadVersion$);
  const createClient = get(apiClient$);
  const result = await accept(
    createClient(connectorOverviewContract).overview(),
    [200],
  );
  return result.body;
});

export const subscribeConnectorOverview$ = command(
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
