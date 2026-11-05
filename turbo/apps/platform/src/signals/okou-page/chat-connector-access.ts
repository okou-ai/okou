import {
  command,
  computed,
  state,
  type Computed,
  type State,
  type Command,
} from "ccstate";
import { chatConnectorAccessContract } from "@okouai/api-contracts/client/chat-connector-access";
import type {
  ChatConnectorAccess,
  ChatConnectorOverviewEntry,
} from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorAccountsContract } from "@okouai/api-contracts/client/connector-accounts";
import type {
  ConnectorAccountConnection,
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { accept } from "../../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { resetSignal } from "../utils.ts";
import {
  connectorAccountTargetKey,
  createConnectorAccountListSignals,
} from "./connector-accounts.ts";
import { createChatConnectorOverviewSignals } from "./chat-connector-overview.ts";
import { createChatConnectorMenuScrollSignals } from "./chat-connector-menu-scroll.ts";
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
  readonly current:
    | (ChatConnectorOverviewEntry["accounts"][number] & { readonly id: string })
    | null;
  readonly icon: ChatConnectorOverviewEntry["icon"];
}

function accountAccessRequests(signal: AbortSignal) {
  return {
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
  entries$,
  pending$,
  target$,
  threadId,
}: {
  readonly entries$: Computed<Promise<readonly ChatConnectorOverviewEntry[]>>;
  readonly pending$: State<PendingChatConnectorAccess>;
  readonly target$: State<ChatConnectorMenuTarget | null>;
  readonly threadId: string | undefined;
}) {
  const overview$ = computed(
    async (get): Promise<readonly ChatConnectorOverview[]> => {
      const pending = get(pending$);
      const entries = await get(entries$);
      return entries.map((entry) => {
        const key = connectorAccountTargetKey(entry.target);
        const accounts = entry.accounts.map((account) => {
          const overrideEnabled = threadId
            ? account.overrideEnabled
            : (pending.overrides.find((candidate) => {
                return (
                  candidate.connectionId === account.connectionId &&
                  connectorAccountTargetKey(candidate.target) === key
                );
              })?.enabled ?? null);
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
            return (
              account.connectionId ===
              (threadId ? entry.currentConnectionId : selection?.connectionId)
            );
          }) ??
          allowed.find((account) => {
            return account.isDefault;
          }) ??
          allowed[0];
        const access = {
          target: entry.target,
          accounts,
          currentConnectionId: current?.connectionId ?? null,
          available: allowed.length > 0,
        };
        return {
          ...entry,
          access,
          current: current ? { ...current, id: current.connectionId } : null,
        };
      });
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

/** Saves and cache reconciliation share the Chat page's lifetime. */
function createChatConnectorMutations({
  pending$,
  target$,
  active$,
  refreshTarget$,
  threadId,
}: {
  readonly pending$: State<PendingChatConnectorAccess>;
  readonly target$: State<ChatConnectorMenuTarget | null>;
  readonly active$: Computed<Promise<ChatConnectorOverview | null>>;
  readonly refreshTarget$: Command<
    Promise<void>,
    [ConnectorAccountTarget, AbortSignal]
  >;
  readonly threadId: string | undefined;
}) {
  const setOverride$ = command(
    async (
      { get, set },
      connectionId: string,
      enabled: boolean | null,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
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
        await set(refreshTarget$, entry.target, signal);
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
    async ({ get, set }, connectionId: string, signal: AbortSignal) => {
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
        await set(refreshTarget$, active.target, signal);
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
export function createChatConnectorAccessSignals(threadId?: string) {
  const pending$ = state<PendingChatConnectorAccess>({
    overrides: [],
    selections: [],
  });
  const requests$ = state<ReturnType<typeof accountAccessRequests> | null>(
    null,
  );
  const resetOwner$ = resetSignal();
  const target$ = state<ChatConnectorMenuTarget | null>(null);
  const menuTarget$ = computed((get) => {
    return get(target$);
  });
  const scroll = createChatConnectorMenuScrollSignals(menuTarget$);
  const permissions$ = state<ConnectorPermissionsTarget | null>(null);
  const permissionSignals$ = computed((get) => {
    const entry = get(permissions$);
    return entry ? createConnectorPermissionsSignals(entry) : null;
  });
  const list = createConnectorAccountListSignals();
  const cache = createChatConnectorOverviewSignals(threadId);
  const { overview$, active$ } = createChatConnectorReads({
    entries$: cache.entries$,
    pending$,
    target$,
    threadId,
  });
  const open$ = command(({ set }, parentSignal: AbortSignal) => {
    set(scroll.reset$);
    set(requests$, accountAccessRequests(set(resetOwner$, parentSignal)));
    set(cache.open$, parentSignal);
  });
  const closeTarget$ = command(({ set }) => {
    set(target$, null);
    set(list.clearTarget$);
  });
  const close$ = command(({ set }) => {
    set(scroll.reset$);
    set(resetOwner$);
    set(requests$, null);
    set(closeTarget$);
  });
  const openTarget$ = command(
    ({ set }, target: ChatConnectorMenuTarget, signal: AbortSignal) => {
      set(scroll.captureOverview$, target.target);
      set(target$, target);
      set(list.setTarget$, target.target, signal);
    },
  );
  const { setOverride$, select$ } = createChatConnectorMutations({
    pending$,
    target$,
    active$,
    refreshTarget$: cache.refreshTarget$,
    threadId,
  });
  const current$ = computed(
    async (get): Promise<ConnectorAccountConnection | null> => {
      const requests = get(requests$);
      const active = await get(active$);
      if (!requests || !active?.access.currentConnectionId) {
        return null;
      }
      const page = await get(list.accounts$);
      const found = page.connections.find((account) => {
        return account.id === active.access.currentConnectionId;
      });
      if (found) {
        return found;
      }
      const result = await requests.connection(
        get(apiClient$),
        active.target,
        active.access.currentConnectionId,
      );
      return result.status === 200 ? result.body : null;
    },
  );
  return {
    overview$,
    notifications$: cache.notifications$,
    active$,
    list,
    open$,
    close$,
    openTarget$,
    closeTarget$,
    setOverride$,
    select$,
    reload$: cache.reload$,
    retry$: cache.retry$,
    current$,
    scroll,
    target$: menuTarget$,
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
