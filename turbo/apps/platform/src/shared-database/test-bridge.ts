import { sessionOutputChannelName } from "@okouai/api-contracts/contracts/realtime";
import { command, type Store } from "ccstate";

import {
  registerDirectRealtimeSubscription,
  subscribeChatDatabaseEvents,
  subscribeNamedRealtimeEvents,
  subscribeUserRealtimeEvents,
} from "../mocks/ably.ts";
import {
  resolveApiBaseForTarget,
  resolveOAuthApiBase,
} from "../signals/api-base.ts";
import {
  setSharedDatabaseBridgeHostForTest$,
  type SharedDatabaseBridgeHost,
} from "../signals/shared-database-browser.ts";
import { onDomEventFn, waitForOperation } from "../signals/utils.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
  SharedDatabasePortLike,
  SharedDatabaseTokenProvider,
} from "./bridge.ts";
import {
  parseComputedValue,
  type ComputedKey,
  type ComputedValue,
} from "./computed-key.ts";
import {
  parseSharedDatabaseQueryResult,
  type ChatThreadEventQueryResult,
  type SharedDatabaseDataKey,
  type SharedDatabaseIdentity,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
} from "./data-key.ts";
import type {
  SharedDatabaseRealtimeMessage,
  SharedDatabaseRealtimeScope,
  SharedDatabaseRealtimeTopic,
} from "./protocol.ts";
import {
  MessagePortSharedDatabaseBridge,
  type SharedDatabaseHeartbeatLoop,
} from "./message-port-client.ts";
import { SharedDatabaseMessagePortServer } from "./message-port-server.ts";
import {
  forwardChatThreadReadCursorUpdated$,
  openConnection$,
  recordConnectionHeartbeat$,
  registerConnection$,
  reportWorkerUnavailableForConnections$,
  requestTokenFromLatestConnection$,
  type WorkerBroadcastMessage,
} from "./worker-context.ts";
import {
  getComputedStoreMessage$,
  handleSharedDatabaseRealtimeMessage$,
  initializeSharedDatabaseWorker$,
  querySharedDatabaseWorker$,
  refreshWorkerComputed$,
  startSharedDatabaseWorkerDaemons$,
} from "./worker-signals.ts";

/**
 * Ordinary page stories keep the production worker signals and computed
 * values but use an in-process transport. SharedWorker transport stories opt
 * into the complete MessagePort host explicitly.
 */
export type SharedWorkerTestTransport = "direct" | "message-port" | "browser";

interface SetupSharedWorkerTestBootstrap {
  readonly afterRegistration?: () => Promise<void>;
  readonly appVersion: string;
  /**
   * A cache-only chat-thread projection for page-level UI tests. IndexedDB
   * persistence belongs to worker-runtime tests; this fixture keeps page
   * stories at the bridge/UI boundary.
   */
  readonly cachedChatThreadEvents?: ChatThreadEventQueryResult;
  readonly identity: SharedDatabaseIdentity | null;
  readonly transport: SharedWorkerTestTransport;
  readonly workerStore: Store;
}

interface DirectRealtimeMessage {
  readonly data: unknown;
  readonly name: string;
}

interface DirectRealtimeSubscription {
  readonly listener: (message: SharedDatabaseRealtimeMessage) => void;
  readonly release: () => void;
  readonly scope: SharedDatabaseRealtimeScope;
  readonly topic: string;
}

interface DirectSharedDatabaseBridgeOptions {
  readonly cachedChatThreadEvents?: ChatThreadEventQueryResult;
  readonly identity: SharedDatabaseIdentity;
}

const holdHeartbeatLoop: SharedDatabaseHeartbeatLoop = (
  heartbeat,
  signal,
): void => {
  signal.throwIfAborted();
  heartbeat();
};

function directRealtimeChannelName(
  identity: SharedDatabaseIdentity,
  scope: SharedDatabaseRealtimeScope,
  topic: string,
): string {
  switch (scope) {
    case "run-output": {
      return sessionOutputChannelName(identity.userId, identity.orgId, topic);
    }
    case "credential": {
      return `user-org:${identity.userId}:${identity.orgId}`;
    }
    case "org": {
      return `org:${identity.orgId}`;
    }
    case "user": {
      return `user:${identity.userId}`;
    }
  }
}

function directWorkerPort(
  emit: (message: WorkerBroadcastMessage) => void,
): SharedDatabasePortLike {
  return {
    postMessage: (value) => {
      emit(value as WorkerBroadcastMessage);
    },
    start: () => {},
    close: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

class DirectSharedDatabaseBridge implements SharedDatabaseBridge {
  private readonly connectionId = crypto.randomUUID();
  private readonly realtimeSubscriptions = new Map<
    string,
    DirectRealtimeSubscription
  >();
  private connectionSignal: AbortSignal | null = null;

  constructor(
    private readonly workerStore: Store,
    private readonly events: SharedDatabaseBridgeEvents,
    private readonly workerSignal: AbortSignal,
    private readonly getToken: SharedDatabaseTokenProvider,
    private readonly options: DirectSharedDatabaseBridgeOptions,
  ) {}

  private readonly emit = onDomEventFn(
    async (event: WorkerBroadcastMessage): Promise<void> => {
      if (event.type === "invalidate") {
        await this.events.databaseInvalidated(event.dataKey);
        return;
      }
      if (event.type === "reload-computed") {
        this.events.computedReloaded(event.computedKey);
        return;
      }
      if (event.type === "chat-thread-read-cursor-updated") {
        this.events.chatThreadReadCursorUpdated(event.payload);
        return;
      }
      if (event.type === "worker-unavailable") {
        this.events.workerUnavailable(event.reason);
        return;
      }
    },
  );

  handleNamedRealtimeMessage(
    channelName: string,
    message: DirectRealtimeMessage,
  ): void {
    const scope = (["credential", "org", "user", "run-output"] as const).find(
      (candidate) => {
        return (
          directRealtimeChannelName(
            this.options.identity,
            candidate,
            message.name,
          ) === channelName
        );
      },
    );
    if (scope) {
      this.handleRealtimeMessage(scope, message);
    }
  }

  handleRealtimeMessage(
    scope: SharedDatabaseRealtimeScope,
    message: DirectRealtimeMessage,
  ): void {
    this.workerStore.set(
      handleSharedDatabaseRealtimeMessage$,
      message,
      this.workerSignal,
    );
    for (const subscription of this.realtimeSubscriptions.values()) {
      if (subscription.scope === scope && subscription.topic === message.name) {
        subscription.listener(message);
      }
    }
    const computedKey: ComputedKey | null =
      message.name === "threadListChanged" ||
      message.name === "chatThreadReadCursorUpdated"
        ? "chat-thread-indicators"
        : message.name === "computerUseHostsChanged"
          ? "computer-use-hosts"
          : message.name === "billing:changed"
            ? "queue-data"
            : null;
    if (!computedKey) {
      return;
    }
    if (message.name === "chatThreadReadCursorUpdated") {
      this.workerStore.set(forwardChatThreadReadCursorUpdated$, message.data);
    }
    this.workerStore.set(refreshWorkerComputed$, computedKey);
  }

  registerTab(signal: AbortSignal): Promise<void> {
    if (this.connectionSignal) {
      throw new Error("Shared database tab is already registered");
    }
    signal.throwIfAborted();
    const connectionSignal = this.workerStore.set(
      openConnection$,
      this.connectionId,
      AbortSignal.any([this.workerSignal, signal]),
    );
    this.connectionSignal = this.workerStore.set(
      registerConnection$,
      this.connectionId,
      { getToken: this.getToken, port: directWorkerPort(this.emit) },
      connectionSignal,
    );
    this.workerStore.set(recordConnectionHeartbeat$, this.connectionId);
    this.connectionSignal.addEventListener(
      "abort",
      () => {
        for (const subscription of this.realtimeSubscriptions.values()) {
          subscription.release();
        }
        this.realtimeSubscriptions.clear();
      },
      { once: true },
    );
    this.workerStore.set(startSharedDatabaseWorkerDaemons$);
    return Promise.resolve();
  }

  subscribeRealtime<TScope extends SharedDatabaseRealtimeScope>(
    subscriptionId: string,
    scope: TScope,
    topic: SharedDatabaseRealtimeTopic<NoInfer<TScope>>,
    listener: (message: SharedDatabaseRealtimeMessage) => void,
    _onResync: () => void,
  ): Promise<void> {
    if (this.realtimeSubscriptions.has(subscriptionId)) {
      throw new Error("Shared database realtime subscription already exists");
    }
    const release = registerDirectRealtimeSubscription(
      directRealtimeChannelName(this.options.identity, scope, topic),
      topic,
    );
    this.realtimeSubscriptions.set(subscriptionId, {
      listener,
      release,
      scope,
      topic,
    });
    return Promise.resolve();
  }

  unsubscribeRealtime(subscriptionId: string): void {
    const subscription = this.realtimeSubscriptions.get(subscriptionId);
    subscription?.release();
    this.realtimeSubscriptions.delete(subscriptionId);
  }

  async getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    const signal = this.requireConnectionSignal();
    signal.throwIfAborted();
    const value = await waitForOperation(
      this.workerStore.set(
        getComputedStoreMessage$,
        this.connectionId,
        {
          type: "get-computed",
          requestId: "direct-test-bridge",
          computedKey,
        },
        signal,
      ),
      signal,
    );
    const cloned: unknown = structuredClone(value);
    return parseComputedValue(computedKey, cloned);
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    signal.throwIfAborted();
    if (
      query.dataKey.kind === "chat-thread-event" &&
      query.consistency === "cache-only" &&
      this.options.cachedChatThreadEvents
    ) {
      return parseSharedDatabaseQueryResult(
        query.dataKey,
        structuredClone(this.options.cachedChatThreadEvents),
      );
    }
    const operation = this.workerStore.set(
      querySharedDatabaseWorker$,
      this.connectionId,
      query,
      this.requireConnectionSignal(),
    );
    const result = await waitForOperation(operation, signal);
    const cloned: unknown = structuredClone(result);
    return parseSharedDatabaseQueryResult(query.dataKey, cloned);
  }

  private requireConnectionSignal(): AbortSignal {
    if (!this.connectionSignal) {
      throw new Error("Shared database tab registration is required first");
    }
    return this.connectionSignal;
  }
}

class TestSharedDatabaseBridge implements SharedDatabaseBridge {
  constructor(
    private readonly bridge: SharedDatabaseBridge,
    private readonly afterRegistration?: () => Promise<void>,
  ) {}

  async registerTab(signal: AbortSignal): Promise<void> {
    await this.bridge.registerTab(signal);
    await this.afterRegistration?.();
  }

  subscribeRealtime<TScope extends SharedDatabaseRealtimeScope>(
    subscriptionId: string,
    scope: TScope,
    topic: SharedDatabaseRealtimeTopic<NoInfer<TScope>>,
    listener: (message: SharedDatabaseRealtimeMessage) => void,
    onResync: () => void,
  ): Promise<void> {
    return this.bridge.subscribeRealtime(
      subscriptionId,
      scope,
      topic,
      listener,
      onResync,
    );
  }

  unsubscribeRealtime(subscriptionId: string): void {
    this.bridge.unsubscribeRealtime(subscriptionId);
  }

  getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    return this.bridge.getComputed(computedKey);
  }

  query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    return this.bridge.query(query, signal);
  }
}

export const setupSharedWorkerTestBootstrap$ = command(
  (
    { set },
    options: SetupSharedWorkerTestBootstrap,
    signal: AbortSignal,
  ): void => {
    if (options.identity) {
      options.workerStore.set(
        initializeSharedDatabaseWorker$,
        {
          appVersion: options.appVersion,
          identity: options.identity,
          apiBaseUrl: resolveApiBaseForTarget("api"),
          getToken: (requestSignal) => {
            return options.workerStore.set(
              requestTokenFromLatestConnection$,
              requestSignal,
            );
          },
          oauthApiBaseUrl: resolveOAuthApiBase(),
          onForceUpgrade: () => {
            options.workerStore.set(
              reportWorkerUnavailableForConnections$,
              "force-upgrade-required",
            );
          },
        },
        signal,
      );
    }

    // Browser failure stories keep the production host and mock SharedWorker
    // itself, so native error events reach the real page boundary.
    if (options.transport === "browser") {
      return;
    }

    let directBridge: DirectSharedDatabaseBridge | null = null;
    let directRealtimeForwardingInstalled = false;
    const host: SharedDatabaseBridgeHost = {
      createBridge: (identity, getToken, events, connectionSignal) => {
        let bridge: SharedDatabaseBridge;
        if (options.transport === "message-port") {
          const channel = new MessageChannel();
          new SharedDatabaseMessagePortServer(
            options.workerStore,
            channel.port1,
            signal,
          );
          bridge = new MessagePortSharedDatabaseBridge(
            channel.port2,
            events,
            connectionSignal,
            getToken,
            holdHeartbeatLoop,
          );
        } else {
          if (!directRealtimeForwardingInstalled) {
            subscribeChatDatabaseEvents((message) => {
              directBridge?.handleRealtimeMessage("credential", message);
            }, signal);
            subscribeUserRealtimeEvents((message) => {
              directBridge?.handleRealtimeMessage("user", message);
            }, signal);
            subscribeNamedRealtimeEvents((channelName, message) => {
              directBridge?.handleNamedRealtimeMessage(channelName, message);
            }, signal);
            directRealtimeForwardingInstalled = true;
          }
          directBridge = new DirectSharedDatabaseBridge(
            options.workerStore,
            events,
            signal,
            getToken,
            {
              identity,
              cachedChatThreadEvents: options.cachedChatThreadEvents,
            },
          );
          bridge = directBridge;
        }
        return new TestSharedDatabaseBridge(bridge, options.afterRegistration);
      },
    };
    set(setSharedDatabaseBridgeHostForTest$, host);
  },
);
