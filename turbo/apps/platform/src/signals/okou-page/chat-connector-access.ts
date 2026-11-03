import {
  command,
  computed,
  state,
  type Computed,
  type State,
  type Command,
} from "ccstate";
import { chatConnectorAccessContract } from "@okouai/api-contracts/client/chat-connector-access";
import type { ChatConnectorAccess } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorAccountsContract } from "@okouai/api-contracts/client/connector-accounts";
import type {
  ConnectorAccountConnection,
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectedConnectors } from "@okouai/api-contracts/contracts/connected-connectors";
import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { resetSignal } from "../utils.ts";
import {
  connectorAccountTargetKey,
  createConnectorAccountListSignals,
} from "./connector-accounts.ts";
import {
  builtinConnectorAccountProjectionVersion$,
  customConnectorAccountProjectionVersion$,
} from "./connector-account-projection.ts";
import {
  createConnectorPermissionsSignals,
  type ConnectorPermissionsTarget,
} from "./settings/connector-permissions.ts";
import { pageSignal$ } from "../page-signal.ts";

interface PendingChatConnectorOverride {
  readonly target: ConnectorAccountTarget;
  readonly connectionId: string;
  readonly enabled: boolean;
}

export interface PendingChatConnectorAccess {
  readonly overrides: readonly PendingChatConnectorOverride[];
  readonly selections: readonly ConnectorAccountSelection[];
}

export interface ChatConnectorMenuTarget {
  readonly target: ConnectorAccountTarget;
  readonly label: string;
  readonly hasPermissions: boolean;
}

export interface ChatConnectorOverview extends ChatConnectorMenuTarget {
  readonly access: ChatConnectorAccess;
  readonly current: ConnectorAccountConnection | null;
}

function accountAccessRequests(signal: AbortSignal) {
  return {
    thread: (
      client: ApiClientFactory,
      threadId: string,
      target: ConnectorAccountTarget,
    ) => {
      return accept(
        client(chatConnectorAccessContract).getThread({
          params: { threadId },
          query: target,
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
    },
    defaults: (client: ApiClientFactory, target: ConnectorAccountTarget) => {
      return accept(
        client(chatConnectorAccessContract).accountDefaults({
          query: target,
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
    },
    connection: (
      client: ApiClientFactory,
      target: ConnectorAccountTarget,
      connectionId: string,
    ) => {
      return accept(
        client(connectorAccountsContract).connection({
          params: { connectionId },
          query: target,
          fetchOptions: { signal },
        }),
        [200, 404],
        signal,
      );
    },
  };
}

function createChatConnectorReads({
  connected$,
  pending$,
  requests$,
  version$,
  target$,
  threadId,
}: {
  readonly connected$: Computed<Promise<ConnectedConnectors>>;
  readonly pending$: State<PendingChatConnectorAccess>;
  readonly requests$: State<ReturnType<typeof accountAccessRequests> | null>;
  readonly version$: State<number>;
  readonly target$: State<ChatConnectorMenuTarget | null>;
  readonly threadId: string | undefined;
}) {
  const overview$ = computed(
    async (get): Promise<readonly ChatConnectorOverview[]> => {
      const requests = get(requests$);
      if (!requests) {
        return [];
      }
      get(version$);
      get(builtinConnectorAccountProjectionVersion$);
      get(customConnectorAccountProjectionVersion$);
      const pending = get(pending$);
      const connected = await get(connected$);
      const client = get(apiClient$);
      const targets: ChatConnectorMenuTarget[] = [
        ...connected.builtinConnectors.map((connector) => {
          return {
            target: { kind: "builtin" as const, connectorSlug: connector.slug },
            label: connector.label,
            hasPermissions: connector.hasPermissions,
          };
        }),
        ...connected.customConnectors.map((connector) => {
          return {
            target: {
              kind: "custom" as const,
              customConnectorId: connector.id,
            },
            label: connector.displayName,
            hasPermissions: false,
          };
        }),
      ];
      return await Promise.all(
        targets.map(async (entry) => {
          let access: ChatConnectorAccess;
          if (threadId) {
            const result = await requests.thread(
              client,
              threadId,
              entry.target,
            );
            access = result.body;
          } else {
            const result = await requests.defaults(client, entry.target);
            const key = connectorAccountTargetKey(entry.target);
            const accounts = result.body.map((account) => {
              const overrideEnabled =
                pending.overrides.find((candidate) => {
                  return (
                    candidate.connectionId === account.connectionId &&
                    connectorAccountTargetKey(candidate.target) === key
                  );
                })?.enabled ?? null;
              return {
                ...account,
                overrideEnabled,
                enabled: overrideEnabled ?? account.defaultEnabled,
              };
            });
            const allowed = accounts.filter((account) => {
              return account.enabled;
            });
            const selection = pending.selections.find((candidate) => {
              return connectorAccountTargetKey(candidate.target) === key;
            });
            const current =
              allowed.find((account) => {
                return account.connectionId === selection?.connectionId;
              }) ??
              allowed.find((account) => {
                return account.isDefault;
              }) ??
              allowed[0];
            access = {
              target: entry.target,
              accounts,
              currentConnectionId: current?.connectionId ?? null,
              available: allowed.length > 0,
            };
          }
          const result = access.currentConnectionId
            ? await requests.connection(
                client,
                entry.target,
                access.currentConnectionId,
              )
            : null;
          return {
            ...entry,
            access,
            current: result?.status === 200 ? result.body : null,
          };
        }),
      );
    },
  );
  const active$ = computed(async (get) => {
    const target = get(target$);
    if (!target) {
      return null;
    }
    return (
      (await get(overview$)).find((entry) => {
        return (
          connectorAccountTargetKey(entry.target) ===
          connectorAccountTargetKey(target.target)
        );
      }) ?? null
    );
  });
  return { overview$, active$ };
}

function pendingConnectorOverride(
  pending: PendingChatConnectorAccess,
  access: ChatConnectorAccess,
  connectionId: string,
  enabled: boolean | null,
): PendingChatConnectorAccess {
  const allowed = access.accounts
    .map((account) => {
      return account.connectionId === connectionId
        ? { ...account, enabled: enabled ?? account.defaultEnabled }
        : account;
    })
    .filter((account) => {
      return account.enabled;
    });
  const current =
    allowed.find((account) => {
      return account.connectionId === access.currentConnectionId;
    }) ??
    allowed.find((account) => {
      return account.isDefault;
    }) ??
    allowed[0];
  const overrides = pending.overrides.filter((override) => {
    return override.connectionId !== connectionId;
  });
  const selections = pending.selections.filter((selection) => {
    return (
      connectorAccountTargetKey(selection.target) !==
      connectorAccountTargetKey(access.target)
    );
  });
  return {
    overrides:
      enabled === null
        ? overrides
        : [...overrides, { target: access.target, connectionId, enabled }],
    // Capture the displayed current account even when enabling several accounts
    // in a new Chat; sequential server initialization must choose the same one.
    selections: current
      ? [
          ...selections,
          { target: access.target, connectionId: current.connectionId },
        ]
      : selections,
  };
}

function createChatConnectorMutations({
  pending$,
  target$,
  active$,
  resetSave$,
  reload$,
  threadId,
}: {
  readonly pending$: State<PendingChatConnectorAccess>;
  readonly target$: State<ChatConnectorMenuTarget | null>;
  readonly active$: Computed<Promise<ChatConnectorOverview | null>>;
  readonly resetSave$: ReturnType<typeof resetSignal>;
  readonly reload$: Command<void, []>;
  readonly threadId: string | undefined;
}) {
  const setOverride$ = command(
    async (
      { get, set },
      connectionId: string,
      enabled: boolean | null,
      parentSignal: AbortSignal,
    ) => {
      const signal = set(resetSave$, parentSignal);
      const entry = get(target$);
      if (!entry) {
        return;
      }
      if (threadId) {
        await accept(
          get(apiClient$)(chatConnectorAccessContract).setThreadOverride({
            params: { threadId, connectionId },
            body: { target: entry.target, enabled },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        set(reload$);
      } else {
        const active = await get(active$);
        signal.throwIfAborted();
        if (active) {
          set(
            pending$,
            pendingConnectorOverride(
              get(pending$),
              active.access,
              connectionId,
              enabled,
            ),
          );
        }
        return;
      }
      await get(active$);
      signal.throwIfAborted();
    },
  );
  const select$ = command(
    async ({ get, set }, connectionId: string, parentSignal: AbortSignal) => {
      const signal = set(resetSave$, parentSignal);
      const active = await get(active$);
      signal.throwIfAborted();
      if (
        !active?.access.accounts.some((account) => {
          return account.connectionId === connectionId && account.enabled;
        })
      ) {
        return;
      }
      if (threadId) {
        await accept(
          get(apiClient$)(chatConnectorAccessContract).setThreadCurrent({
            params: { threadId },
            body: { target: active.target, connectionId },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        set(reload$);
        await get(active$);
        signal.throwIfAborted();
      } else {
        set(pending$, (pending) => {
          return {
            ...pending,
            selections: [
              ...pending.selections.filter((selection) => {
                return (
                  connectorAccountTargetKey(selection.target) !==
                  connectorAccountTargetKey(active.target)
                );
              }),
              { target: active.target, connectionId },
            ],
          };
        });
      }
    },
  );
  return { setOverride$, select$ };
}

/** One composer's Chat preferences; opening the menu owns its account reads. */
export function createChatConnectorAccessSignals(
  connected$: Computed<Promise<ConnectedConnectors>>,
  threadId?: string,
) {
  const pending$ = state<PendingChatConnectorAccess>({
    overrides: [],
    selections: [],
  });
  const requests$ = state<ReturnType<typeof accountAccessRequests> | null>(
    null,
  );
  const resetOwner$ = resetSignal();
  const resetSave$ = resetSignal();
  const version$ = state(0);
  const target$ = state<ChatConnectorMenuTarget | null>(null);
  const permissions$ = state<ConnectorPermissionsTarget | null>(null);
  const permissionSignals$ = computed((get) => {
    const entry = get(permissions$);
    return entry ? createConnectorPermissionsSignals(entry) : null;
  });
  const list = createConnectorAccountListSignals();
  const reload$ = command(({ set }) => {
    set(version$, (value) => {
      return value + 1;
    });
  });
  const { overview$, active$ } = createChatConnectorReads({
    connected$,
    pending$,
    requests$,
    version$,
    target$,
    threadId,
  });
  const open$ = command(({ set }, parentSignal: AbortSignal) => {
    set(requests$, accountAccessRequests(set(resetOwner$, parentSignal)));
    set(reload$);
  });
  const closeTarget$ = command(({ set }) => {
    set(resetSave$);
    set(target$, null);
    set(list.clearTarget$);
  });
  const close$ = command(({ set }) => {
    set(resetOwner$);
    set(requests$, null);
    set(closeTarget$);
  });
  const openTarget$ = command(
    ({ set }, target: ChatConnectorMenuTarget, signal: AbortSignal) => {
      set(resetSave$);
      set(target$, target);
      set(list.setTarget$, target.target, signal);
    },
  );
  const { setOverride$, select$ } = createChatConnectorMutations({
    pending$,
    target$,
    active$,
    resetSave$,
    reload$,
    threadId,
  });
  return {
    overview$,
    active$,
    list,
    open$,
    close$,
    openTarget$,
    closeTarget$,
    setOverride$,
    select$,
    reload$,
    target$: computed((get) => {
      return get(target$);
    }),
    permissions$: computed((get) => {
      return get(permissions$);
    }),
    permissionSignals$,
    setPermissions$: command(
      ({ get, set }, target: ConnectorPermissionsTarget | null) => {
        const current = get(permissionSignals$);
        if (current) {
          set(current.close$);
        }
        set(permissions$, target);
        const next = get(permissionSignals$);
        if (next) {
          set(next.open$, get(pageSignal$));
        }
      },
    ),
    pending$: computed((get) => {
      return get(pending$);
    }),
    resetPending$: command(({ set }) => {
      set(pending$, { overrides: [], selections: [] });
    }),
  };
}
