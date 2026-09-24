import {
  chatRemoteAccessContract,
  type RemoteAccessProtocol,
  type RemoteHostDefault,
  type ThreadRemoteHostAccess,
  type InitialRemoteAccessOverride,
} from "@okouai/api-contracts/contracts/chat-remote-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed, state } from "ccstate";

import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { clerk$ } from "./auth.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { sshIdentity$, invalidateSsh$ } from "./ssh.ts";
import { invalidateVnc$ } from "./vnc.ts";
import { remoteAccessReload$ } from "./remote-access-refresh.ts";

const client$ = computed(async (get) => {
  const [identity, clerk] = await Promise.all([get(sshIdentity$), get(clerk$)]);
  const createClient = get(apiClient$);
  const getSession = () => {
    const session = clerk.session;
    if (
      !identity ||
      !session ||
      identity !== `${clerk.organization?.id}:${clerk.user?.id}` ||
      !get(featureSwitch$)[FeatureSwitchKey.ThreadRemoteAccess]
    ) {
      throw new DOMException("Remote access owner changed", "AbortError");
    }
    return session;
  };
  const getTokenGuard = () => {
    const session = getSession();
    return () => {
      if (getSession().id !== session.id) {
        throw new DOMException("Remote access owner changed", "AbortError");
      }
    };
  };
  return {
    identity,
    api: createClient(chatRemoteAccessContract, { getTokenGuard }),
  };
});

export const remoteHostDefaults$ = computed(async (get) => {
  get(remoteAccessReload$);
  if (!get(featureSwitch$)[FeatureSwitchKey.ThreadRemoteAccess]) {
    return null;
  }
  const client = await get(client$);
  if (!client.identity) {
    return null;
  }
  const result = await accept(client.api.listHostDefaults(), [200], undefined, {
    showErrorToast: false,
  });
  return result.body;
});

/** Draft choices belong to one new-chat composer until its thread is created. */
export function createPendingRemoteAccessSignals() {
  const overrides$ = state<readonly InitialRemoteAccessOverride[]>([]);
  const setOverride$ = command(
    (
      { get, set },
      protocol: RemoteAccessProtocol,
      connectionId: string,
      enabled: boolean | null,
    ) => {
      const others = get(overrides$).filter((item) => {
        return item.protocol !== protocol || item.connectionId !== connectionId;
      });
      set(
        overrides$,
        enabled === null
          ? others
          : [...others, { protocol, connectionId, enabled }],
      );
    },
  );
  const reset$ = command(({ set }) => {
    set(overrides$, []);
  });
  return { overrides$, setOverride$, reset$ };
}

export function threadRemoteAccess$(threadId: string) {
  return computed(async (get) => {
    get(remoteAccessReload$);
    if (
      !threadId ||
      !get(featureSwitch$)[FeatureSwitchKey.ThreadRemoteAccess]
    ) {
      return null;
    }
    const client = await get(client$);
    if (!client.identity) {
      return null;
    }
    const result = await accept(
      client.api.listThreadAccess({ params: { threadId } }),
      [200, 404],
      undefined,
      { showErrorToast: false },
    );
    return result.status === 200 ? result.body : null;
  });
}

export const setRemoteHostDefault$ = command(
  async (
    { get, set },
    protocol: RemoteAccessProtocol,
    connectionId: string,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<RemoteHostDefault> => {
    const client = await get(client$);
    signal.throwIfAborted();
    const result = await accept(
      client.api.updateHostDefault({
        params: { protocol, connectionId },
        body: { enabled },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    if (client.identity === (await get(sshIdentity$))) {
      set(invalidateSsh$);
      set(invalidateVnc$);
    }
    return result.body;
  },
);

export const setThreadRemoteAccess$ = command(
  async (
    { get, set },
    input: {
      threadId: string;
      protocol: RemoteAccessProtocol;
      connectionId: string;
      enabled: boolean | null;
    },
    signal: AbortSignal,
  ): Promise<ThreadRemoteHostAccess> => {
    const client = await get(client$);
    signal.throwIfAborted();
    const { enabled, ...params } = input;
    const result = await accept(
      enabled === null
        ? client.api.clearThreadOverride({ params, fetchOptions: { signal } })
        : client.api.setThreadOverride({
            params,
            body: { enabled },
            fetchOptions: { signal },
          }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    if (client.identity === (await get(sshIdentity$))) {
      set(invalidateSsh$);
      set(invalidateVnc$);
    }
    return result.body;
  },
);
