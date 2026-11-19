import { command, computed, state, type Computed, type Command } from "ccstate";
import { connectedConnectorsContract } from "@okouai/api-contracts/client/connected-connectors";
import { remotesContract } from "@okouai/api-contracts/client/remotes";
import { phoneUseContract } from "@okouai/api-contracts/client/phone-use";
import type { PhoneDevice } from "@okouai/api-contracts/contracts/phone-use";
import { phoneUseDevicesChangedEvent } from "@okouai/api-contracts/validators/phone-use";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept } from "../../lib/accept.ts";
import { sortRemoteHosts } from "../../lib/remote-resource-order.ts";
import { locale$ } from "../locale.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { setAblyLoop$, setAblyInvalidationLoop$ } from "../realtime.ts";
import { resetSignal } from "../utils.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";

function resourceRequests(signal?: AbortSignal) {
  return {
    phones: async (createClient: ApiClientFactory) => {
      const result = await accept(
        createClient(phoneUseContract).devices({ fetchOptions: { signal } }),
        [200],
        signal,
        { showErrorToast: false },
      );
      return result.body.devices;
    },
    phoneGrant: async (createClient: ApiClientFactory, threadId: string) => {
      const result = await accept(
        createClient(phoneUseContract).chatGrant({
          params: { threadId },
          fetchOptions: { signal },
        }),
        [200],
        signal,
        { showErrorToast: false },
      );
      return result.body.selection;
    },
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

function createPhoneUseSubscriptions(
  phoneUseDevices$: Computed<Promise<readonly PhoneDevice[]>>,
  reloadPhoneUseDevices$: Command<void, []>,
) {
  const resetPresence$ = resetSignal();
  const presenceKeys$ = state("");
  const refreshPhones$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      set(reloadPhoneUseDevices$);
      const devices = await get(phoneUseDevices$);
      signal.throwIfAborted();
      const keys = devices
        .map((device) => {
          return `${device.id}:${device.generation}`;
        })
        .sort();
      const identity = keys.join(",");
      if (get(presenceKeys$) !== identity) {
        set(presenceKeys$, identity);
        const presenceSignal = set(resetPresence$);
        for (const topic of keys) {
          set(
            setAblyLoop$,
            {
              scope: "phone-presence",
              topic,
              loopCommand$: refreshPhones$,
              options: { runOnSubscribe: true },
            },
            presenceSignal,
          );
        }
      }
      return false;
    },
  );
  return command(({ set }, signal: AbortSignal) => {
    // The resource owner explicitly retires dynamic presence subscriptions.
    signal.addEventListener(
      "abort",
      () => {
        set(resetPresence$);
      },
      { once: true },
    );
    set(presenceKeys$, "");
    set(
      setAblyLoop$,
      {
        scope: "credential",
        topic: phoneUseDevicesChangedEvent,
        loopCommand$: refreshPhones$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  });
}

/** Resource snapshots belong to their visible consumer, never to an Ably loop. */
export function createConnectorResourceSignals(threadId?: string) {
  const connectedVersion$ = state(0);
  const remotesVersion$ = state(0);
  const phonesVersion$ = state(0);
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
  const phoneUseDevices$ = computed(async (get) => {
    if (!(await get(featureSwitches$))[FeatureSwitchKey.PhoneUse]) {
      return [];
    }
    get(phonesVersion$);
    return await get(requests$).phones(get(apiClient$));
  });
  const reloadPhoneUseDevices$ = command(({ set }) => {
    set(phonesVersion$, (version) => {
      return version + 1;
    });
  });
  const phoneUseGrant$ = computed(async (get) => {
    if (
      !threadId ||
      !(await get(featureSwitches$))[FeatureSwitchKey.PhoneUse]
    ) {
      return null;
    }
    get(phonesVersion$);
    return await get(requests$).phoneGrant(get(apiClient$), threadId);
  });
  const openPhones$ = createPhoneUseSubscriptions(
    phoneUseDevices$,
    reloadPhoneUseDevices$,
  );
  const open$ = command(
    (
      { set },
      watchConnectors: boolean,
      watchPhone: boolean,
      signal: AbortSignal,
    ) => {
      const ownerSignal = set(resetRequests$, signal);
      set(requests$, resourceRequests(ownerSignal));
      if (watchPhone) {
        set(openPhones$, ownerSignal);
      }
      if (watchConnectors) {
        set(
          setAblyInvalidationLoop$,
          {
            topic: "connector:changed",
            invalidations: [reloadConnected$],
            options: { runOnSubscribe: true },
          },
          ownerSignal,
        );
      }
      set(openedVersion$, (version) => {
        return version + 1;
      });
    },
  );
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
    phoneUseDevices$,
    phoneUseGrant$,
    reloadPhoneUseDevices$,
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
