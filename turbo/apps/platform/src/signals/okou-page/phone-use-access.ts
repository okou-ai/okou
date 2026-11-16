import { command, computed, state } from "ccstate";
import { phoneUseContract } from "@okouai/api-contracts/client/phone-use";
import type { PhoneUseSelection } from "@okouai/api-contracts/contracts/phone-use";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import type { createConnectorResourceSignals } from "./connector-overview.ts";

export function createPhoneUseAccessSignals(
  resources: ReturnType<typeof createConnectorResourceSignals>,
  threadId?: string,
) {
  const pending$ = state<PhoneUseSelection | null>(null);
  const internalSave$ = state<Promise<void>>(Promise.resolve());
  const selection$ = computed(async (get) => {
    return threadId ? await get(resources.phoneUseGrant$) : get(pending$);
  });
  const save$ = command(
    async (
      { get, set },
      device: PhoneUseSelection,
      allow: boolean,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      if (!threadId) {
        set(pending$, allow ? device : null);
        return;
      }
      await accept(
        get(apiClient$)(phoneUseContract).grant({
          body: { ...device, threadId, allow },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      signal.throwIfAborted();
      set(resources.reloadPhoneUseDevices$);
      await get(selection$);
      signal.throwIfAborted();
    },
  );
  const setDevice$ = command(
    (
      { set },
      device: PhoneUseSelection,
      allow: boolean,
      signal: AbortSignal,
    ) => {
      const saving = set(save$, device, allow, signal);
      set(internalSave$, saving);
      return saving;
    },
  );
  return {
    pending$: computed((get) => {
      return get(pending$);
    }),
    selection$,
    saving$: computed((get) => {
      return get(internalSave$);
    }),
    setDevice$,
    resetPending$: command(({ set }) => {
      set(pending$, null);
    }),
  };
}
