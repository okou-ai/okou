import { command, state } from "ccstate";

import { now } from "../lib/time.ts";
import { logger } from "../signals/log.ts";
import { rootSignal$ } from "../signals/root-signal.ts";
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

const connectionControllersState$ = state<
  ReadonlyMap<ConnectionId, AbortController>
>(new Map());
interface ConnectionRegistration {
  readonly getToken: SharedDatabaseTokenProvider;
  readonly port: SharedDatabasePortLike;
}

interface RegisteredConnection extends ConnectionRegistration {
  readonly heartbeatOrder: number | null;
  readonly lastHeartbeatAt: number | null;
}

const connectionsState$ = state<
  ReadonlyMap<ConnectionId, RegisteredConnection>
>(new Map());
const lastHeartbeatOrderState$ = state(0);

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

const removeConnection$ = command(
  ({ get, set }, connectionId: ConnectionId): void => {
    set(
      connectionControllersState$,
      deleteMapKey(get(connectionControllersState$), connectionId),
    );
    set(connectionsState$, deleteMapKey(get(connectionsState$), connectionId));
  },
);

export const registerConnection$ = command(
  (
    { get, set },
    connectionId: ConnectionId,
    connectionController: AbortController,
    connection: ConnectionRegistration,
    connectionControllerSignal: AbortSignal,
  ): AbortSignal => {
    connectionControllerSignal.throwIfAborted();
    if (get(connectionControllersState$).has(connectionId)) {
      throw new Error("Shared database connection is already registered");
    }
    const signal = AbortSignal.any([
      get(rootSignal$),
      connectionControllerSignal,
    ]);
    set(
      connectionControllersState$,
      new Map(get(connectionControllersState$)).set(
        connectionId,
        connectionController,
      ),
    );
    set(
      connectionsState$,
      new Map(get(connectionsState$)).set(connectionId, {
        ...connection,
        heartbeatOrder: null,
        lastHeartbeatAt: null,
      }),
    );
    signal.addEventListener(
      "abort",
      () => {
        set(removeConnection$, connectionId);
      },
      { once: true },
    );
    return signal;
  },
);

export const recordConnectionHeartbeat$ = command(
  ({ get, set }, connectionId: ConnectionId): void => {
    const connection = get(connectionsState$).get(connectionId);
    if (!connection) {
      throw new Error("Shared database connection is not registered");
    }
    const heartbeatOrder = get(lastHeartbeatOrderState$) + 1;
    set(lastHeartbeatOrderState$, heartbeatOrder);
    set(
      connectionsState$,
      new Map(get(connectionsState$)).set(connectionId, {
        ...connection,
        heartbeatOrder,
        lastHeartbeatAt: now(),
      }),
    );
  },
);

export const requestTokenFromLatestConnection$ = command(
  ({ get }, signal?: AbortSignal): Promise<string | null> => {
    signal?.throwIfAborted();
    let connection: RegisteredConnection | undefined;
    let lastHeartbeatAt = Number.NEGATIVE_INFINITY;
    let lastHeartbeatOrder = Number.NEGATIVE_INFINITY;
    for (const candidate of get(connectionsState$).values()) {
      if (
        candidate.lastHeartbeatAt === null ||
        candidate.heartbeatOrder === null
      ) {
        continue;
      }
      if (
        candidate.lastHeartbeatAt > lastHeartbeatAt ||
        (candidate.lastHeartbeatAt === lastHeartbeatAt &&
          candidate.heartbeatOrder > lastHeartbeatOrder)
      ) {
        connection = candidate;
        lastHeartbeatAt = candidate.lastHeartbeatAt;
        lastHeartbeatOrder = candidate.heartbeatOrder;
      }
    }
    if (!connection) {
      throw new Error("Shared database token requires a tab heartbeat");
    }
    return connection.getToken(signal);
  },
);

export const requireConnectionSignal$ = command(
  ({ get }, connectionId: ConnectionId, signal: AbortSignal): void => {
    signal.throwIfAborted();
    if (!get(connectionControllersState$).has(connectionId)) {
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
