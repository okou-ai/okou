import { command, computed, state } from "ccstate";
import { connectedConnectorsContract } from "@okouai/api-contracts/client/connected-connectors";
import { remotesContract } from "@okouai/api-contracts/client/remotes";

import { accept } from "../../lib/accept.ts";
import { sortRemoteHosts } from "../../lib/remote-resource-order.ts";
import { locale$ } from "../locale.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { resetSignal } from "../utils.ts";

function resourceRequests(signal?: AbortSignal) {
  return {
    connected: async (createClient: ApiClientFactory) => {
      const result = await accept(
        createClient(connectedConnectorsContract).list({
          fetchOptions: { signal },
        }),
        [200],
        signal,
        { showErrorToast: false },
      );
      return result.body;
    },
    remotes: async (createClient: ApiClientFactory) => {
      const result = await accept(
        createClient(remotesContract).overview({ fetchOptions: { signal } }),
        [200],
        signal,
        { showErrorToast: false },
      );
      return result.body;
    },
  };
}

/** Resource snapshots belong to their visible consumer, never to an Ably loop. */
export function createConnectorResourceSignals() {
  const connectedVersion$ = state(0);
  const remotesVersion$ = state(0);
  const requests$ = state(resourceRequests());
  const openedVersion$ = state(0);
  const resetRequests$ = resetSignal();
  const connected$ = computed(async (get) => {
    get(connectedVersion$);
    return await get(requests$).connected(get(apiClient$));
  });
  const remotes$ = computed(async (get) => {
    get(remotesVersion$);
    return await get(requests$).remotes(get(apiClient$));
  });
  const open$ = command(({ set }, signal: AbortSignal) => {
    const ownerSignal = set(resetRequests$, signal);
    set(requests$, resourceRequests(ownerSignal));
    set(
      setAblyInvalidationLoop$,
      {
        topic: "connector:changed",
        invalidations: [reloadConnected$],
        options: { runOnSubscribe: true },
      },
      ownerSignal,
    );
    set(openedVersion$, (version) => {
      return version + 1;
    });
  });
  const close$ = command(({ set }) => {
    set(resetRequests$);
  });
  const remoteHostDefaults$ = computed(async (get) => {
    const locale = get(locale$);
    const remotes = await get(remotes$);
    return {
      ssh: sortRemoteHosts(remotes.sshHosts, locale),
      vnc: sortRemoteHosts(remotes.vncHosts, locale),
    };
  });
  const reloadConnected$ = command(({ set }) => {
    set(connectedVersion$, (version) => {
      return version + 1;
    });
  });
  const reloadRemotes$ = command(({ set }) => {
    set(remotesVersion$, (version) => {
      return version + 1;
    });
  });
  return {
    connected$,
    remotes$,
    open$,
    close$,
    openedVersion$: computed((get) => {
      return get(openedVersion$);
    }),
    remoteHostDefaults$,
    reloadConnected$,
    reloadRemotes$,
  };
}

const directory = createConnectorResourceSignals();
export const userConnectedConnectors$ = directory.connected$;
export const reloadUserConnectedConnectors$ = directory.reloadConnected$;
