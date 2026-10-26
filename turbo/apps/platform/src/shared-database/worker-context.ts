import { command, computed, state } from "ccstate";

import { logger } from "../signals/log.ts";
import { rootSignal$ } from "../signals/root-signal.ts";
import {
  createDeferredPromise,
  isAbortError,
  onRejection,
  resetSignal,
  withCleanup,
} from "../signals/utils.ts";
import type {
  SharedDatabasePortLike,
  SharedDatabaseTokenProvider,
} from "./bridge.ts";
import type { ComputedKey } from "./computed-key.ts";
import type {
  SharedDatabaseWorkerUnavailableReason,
  SharedDatabaseWorkerMessage,
} from "./protocol.ts";

const L = logger("SharedWorkerBridge");

export type ConnectionId = string;

export type WorkerBroadcastMessage = Extract<
  SharedDatabaseWorkerMessage,
  {
    readonly type:
      | "chat-thread-read-cursor-updated"
      | "invalidate"
      | "reload-computed"
      | "status"
      | "worker-unavailable";
  }
>;

type WorkerConnectionMessage = Extract<
  SharedDatabaseWorkerMessage,
  {
    readonly type:
      | "realtime-event"
      | "realtime-resync"
      | "realtime-subscribed"
      | "realtime-subscription-error";
  }
>;

// A new port selects its identity before its graph is constructed. Active
// connections retain their own graph when another port is selected.
const openingConnectionId$ = state<ConnectionId | null>(null);
const openingConnectionGraph$ = computed((get) => {
  const connectionId = get(openingConnectionId$);
  return connectionId === null
    ? null
    : { connectionId, resetConnection$: resetSignal() };
});
interface ConnectionGraph {
  readonly connectionId: ConnectionId;
  readonly resetConnection$: ReturnType<typeof resetSignal>;
}
interface ConnectionLifetime {
  readonly graph: ConnectionGraph;
  readonly signal: AbortSignal;
}
const connectionLifetimesState$ = state<
  ReadonlyMap<ConnectionId, ConnectionLifetime>
>(new Map());

interface RegisteredConnection {
  readonly getToken: SharedDatabaseTokenProvider;
  readonly port: SharedDatabasePortLike;
  readonly visibility: DocumentVisibilityState;
  readonly signal: AbortSignal;
}

const connectionsState$ = state<
  ReadonlyMap<ConnectionId, RegisteredConnection>
>(new Map());
const visibleTabChangeState$ = state<ReturnType<
  typeof createDeferredPromise<void>
> | null>(null);

const notifyVisibleTabChange$ = command(({ get, set }): void => {
  const changed = get(visibleTabChangeState$);
  set(visibleTabChangeState$, null);
  if (changed && !changed.settled()) {
    changed.resolve();
  }
});

export const hasVisibleTab$ = computed((get): boolean => {
  return [...get(connectionsState$).values()].some((connection) => {
    return connection.visibility === "visible";
  });
});

export const recordTabVisibility$ = command(
  (
    { get, set },
    connectionId: ConnectionId,
    visibility: DocumentVisibilityState,
  ): void => {
    const connections = get(connectionsState$);
    const connection = connections.get(connectionId);
    if (!connection) {
      throw new Error("Shared database connection is not registered");
    }
    if (connection.visibility === visibility) {
      return;
    }
    set(
      connectionsState$,
      new Map(connections).set(connectionId, {
        ...connection,
        visibility,
      }),
    );
    set(notifyVisibleTabChange$);
  },
);

export const waitForVisibleTabChange$ = command(
  async (
    { get, set },
    visible: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (get(hasVisibleTab$) !== visible) {
      return;
    }
    const changed = createDeferredPromise<void>(signal);
    set(visibleTabChangeState$, changed);
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    await withCleanup(changed.promise, () => {
      if (get(visibleTabChangeState$) === changed) {
        set(visibleTabChangeState$, null);
      }
    });
  },
);

function deleteMapKey<TKey, TValue>(
  current: ReadonlyMap<TKey, TValue>,
  key: TKey,
): ReadonlyMap<TKey, TValue> {
  const next = new Map(current);
  next.delete(key);
  return next;
}

export const broadcastSharedDatabaseWorkerMessage$ = command(
  ({ get }, message: WorkerBroadcastMessage): void => {
    for (const [connectionId, connection] of get(connectionsState$)) {
      L.debug("send message to app", connectionId, message);
      connection.port.postMessage(message);
    }
  },
);

export const sendSharedDatabaseWorkerMessageToConnection$ = command(
  (
    { get },
    connectionId: ConnectionId,
    message: WorkerConnectionMessage,
  ): void => {
    const connection = get(connectionsState$).get(connectionId);
    if (!connection) {
      return;
    }
    L.debug("send message to app", connectionId, message);
    connection.port.postMessage(message);
  },
);

export const closeConnection$ = command(
  ({ get, set }, connectionId: ConnectionId): void => {
    const lifetime = get(connectionLifetimesState$).get(connectionId);
    if (!lifetime) {
      return;
    }
    set(
      connectionLifetimesState$,
      deleteMapKey(get(connectionLifetimesState$), connectionId),
    );
    set(connectionsState$, deleteMapKey(get(connectionsState$), connectionId));
    set(notifyVisibleTabChange$);
    set(lifetime.graph.resetConnection$);
  },
);

export const openConnection$ = command(
  (
    { get, set },
    connectionId: ConnectionId,
    signal: AbortSignal,
  ): AbortSignal => {
    signal.throwIfAborted();
    if (get(connectionLifetimesState$).has(connectionId)) {
      throw new Error("Shared database connection is already open");
    }
    set(openingConnectionId$, connectionId);
    const graph = get(openingConnectionGraph$);
    if (!graph) {
      throw new Error("Shared database connection graph is unavailable");
    }
    const connectionSignal = set(graph.resetConnection$, signal);
    set(
      connectionLifetimesState$,
      new Map(get(connectionLifetimesState$)).set(connectionId, {
        graph,
        signal: connectionSignal,
      }),
    );
    connectionSignal.addEventListener(
      "abort",
      () => {
        if (
          get(connectionLifetimesState$).get(connectionId)?.signal ===
          connectionSignal
        ) {
          set(closeConnection$, connectionId);
        }
      },
      { once: true },
    );
    return connectionSignal;
  },
);

export const registerConnection$ = command(
  (
    { get, set },
    connectionId: ConnectionId,
    port: SharedDatabasePortLike,
    getToken: SharedDatabaseTokenProvider,
    connectionSignal: AbortSignal,
  ): AbortSignal => {
    connectionSignal.throwIfAborted();
    const lifetime = get(connectionLifetimesState$).get(connectionId);
    if (!lifetime) {
      throw new Error("Shared database connection is not open");
    }
    if (get(connectionsState$).has(connectionId)) {
      throw new Error("Shared database connection is already registered");
    }
    const signal = AbortSignal.any([
      get(rootSignal$),
      lifetime.signal,
      connectionSignal,
    ]);
    signal.throwIfAborted();
    set(
      connectionsState$,
      new Map(get(connectionsState$)).set(connectionId, {
        port,
        getToken,
        visibility: "hidden",
        signal,
      }),
    );
    signal.addEventListener(
      "abort",
      () => {
        if (get(connectionsState$).get(connectionId)?.signal === signal) {
          set(closeConnection$, connectionId);
        }
      },
      { once: true },
    );
    return signal;
  },
);

function requestConnectionToken(
  getToken: SharedDatabaseTokenProvider,
  connectionSignal: AbortSignal,
  signal: AbortSignal,
): Promise<string | null> {
  const providerSignal = AbortSignal.any([signal, connectionSignal]);
  // eslint-disable-next-line ccstate/no-on-rejection -- 存量 2026/10/21: another tab's cancellation is a provider failure for the live caller.
  return onRejection(
    () => {
      providerSignal.throwIfAborted();
      return getToken(providerSignal);
    },
    (error) => {
      signal.throwIfAborted();
      // A different tab's cancellation is a provider failure, not cancellation
      // of the still-live caller waiting for the Worker response.
      if (isAbortError(error)) {
        throw new Error("Shared database token provider aborted", {
          cause: error,
        });
      }
    },
  );
}

export const requestTokenFromTabs$ = command(
  async ({ get }, callerSignal?: AbortSignal): Promise<string | null> => {
    const signal = callerSignal
      ? AbortSignal.any([get(rootSignal$), callerSignal])
      : get(rootSignal$);
    signal.throwIfAborted();
    const connections = get(connectionsState$);
    if (connections.size === 0) {
      throw new Error("Shared database token requires a registered tab");
    }
    // Each request broadcasts once and accepts the first response, including null.
    const attempts = [];
    for (const connection of connections.values()) {
      attempts.push(
        requestConnectionToken(connection.getToken, connection.signal, signal),
      );
    }
    const response = await Promise.race(attempts);
    signal.throwIfAborted();
    return response;
  },
);

export const requireConnectionSignal$ = command(
  ({ get }, connectionId: ConnectionId, signal: AbortSignal): void => {
    signal.throwIfAborted();
    if (!get(connectionsState$).has(connectionId)) {
      throw new Error("Shared database connection is not registered");
    }
  },
);

export const reloadComputedForConnections$ = command(
  ({ set }, computedKey: ComputedKey): void => {
    set(broadcastSharedDatabaseWorkerMessage$, {
      type: "reload-computed",
      computedKey,
    });
  },
);

export const forwardChatThreadReadCursorUpdated$ = command(
  ({ set }, payload: unknown): void => {
    set(broadcastSharedDatabaseWorkerMessage$, {
      type: "chat-thread-read-cursor-updated",
      payload,
    });
  },
);

export const reportWorkerUnavailableForConnections$ = command(
  ({ set }, reason: SharedDatabaseWorkerUnavailableReason): void => {
    set(broadcastSharedDatabaseWorkerMessage$, {
      type: "worker-unavailable",
      reason,
    });
  },
);
