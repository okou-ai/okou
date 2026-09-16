import {
  parseSharedDatabaseQueryResult,
  type SharedDatabaseDataKey,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
} from "./data-key.ts";
import {
  parseComputedValue,
  type ComputedKey,
  type ComputedValue,
} from "./computed-key.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseBridgeEvents,
  SharedDatabasePortLike,
  SharedDatabaseTokenProvider,
} from "./bridge.ts";
import {
  deserializeSharedDatabaseError,
  redactSharedDatabaseClientMessageForLog,
  serializeSharedDatabaseError,
  sharedDatabaseWorkerMessageSchema,
  type SharedDatabaseClientMessage,
  type SharedDatabaseRealtimeMessage,
  type SharedDatabaseRealtimeScope,
  type SharedDatabaseRealtimeTopic,
  type SharedDatabaseWorkerMessage,
} from "./protocol.ts";
import { logger } from "../signals/log.ts";
import {
  createDeferredPromise,
  onDomEventFn,
  setLoop,
  settle,
} from "../signals/utils.ts";

const L = logger("SharedWorkerBridge");
const TAB_HEARTBEAT_INTERVAL_MS = 30_000;

export type SharedDatabaseHeartbeatLoop = (
  heartbeat: () => void,
  signal: AbortSignal,
) => void;

const runSharedDatabaseHeartbeatLoop: SharedDatabaseHeartbeatLoop = (
  heartbeat,
  signal,
): void => {
  setLoop(
    () => {
      heartbeat();
      return false;
    },
    TAB_HEARTBEAT_INTERVAL_MS,
    signal,
    { retryTransientErrors: false, testIntervalMs: 100 },
  );
};

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

interface PendingRealtimeSubscription {
  readonly deferred: ReturnType<typeof createDeferredPromise<void>>;
  readonly listener: (message: SharedDatabaseRealtimeMessage) => void;
  readonly onResync: () => void;
}

export class MessagePortSharedDatabaseBridge implements SharedDatabaseBridge {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly pendingRealtimeSubscriptions = new Map<
    string,
    PendingRealtimeSubscription
  >();
  private readonly handleMessage: (event: MessageEvent<unknown>) => void;
  private readonly handleBridgeAbort: () => void;
  private registration: Promise<void> | null = null;
  private registered = false;
  private closed = false;
  private closeReason: unknown = new Error("Shared database bridge is closed");

  constructor(
    private readonly port: SharedDatabasePortLike,
    private readonly events: SharedDatabaseBridgeEvents,
    private readonly bridgeSignal: AbortSignal,
    private readonly getToken: SharedDatabaseTokenProvider,
    private readonly heartbeatLoop: SharedDatabaseHeartbeatLoop = runSharedDatabaseHeartbeatLoop,
  ) {
    bridgeSignal.throwIfAborted();
    this.handleBridgeAbort = () => {
      this.close(bridgeSignal.reason);
    };
    this.handleMessage = onDomEventFn(async (event) => {
      const message = sharedDatabaseWorkerMessageSchema.parse(event.data);
      L.debug("got message from worker", message);
      if (message.type === "get-token") {
        await this.respondToTokenRequest(message);
        return;
      }
      if (message.type === "invalidate") {
        await this.events.databaseInvalidated(message.dataKey);
        return;
      }
      if (message.type === "worker-unavailable") {
        this.events.workerUnavailable(message.reason);
        return;
      }
      if (message.type === "reload-computed") {
        this.events.computedReloaded(message.computedKey);
        return;
      }
      if (message.type === "chat-thread-read-cursor-updated") {
        this.events.chatThreadReadCursorUpdated(message.payload);
        return;
      }
      if (message.type === "realtime-subscribed") {
        const subscription = this.pendingRealtimeSubscriptions.get(
          message.subscriptionId,
        );
        if (subscription && !subscription.deferred.settled()) {
          subscription.deferred.resolve();
        }
        return;
      }
      if (message.type === "realtime-resync") {
        this.pendingRealtimeSubscriptions
          .get(message.subscriptionId)
          ?.onResync();
        return;
      }
      if (message.type === "realtime-event") {
        this.pendingRealtimeSubscriptions
          .get(message.subscriptionId)
          ?.listener(message.message);
        return;
      }
      if (message.type === "realtime-subscription-error") {
        const subscription = this.pendingRealtimeSubscriptions.get(
          message.subscriptionId,
        );
        if (subscription) {
          this.pendingRealtimeSubscriptions.delete(message.subscriptionId);
          if (!subscription.deferred.settled()) {
            subscription.deferred.reject(
              deserializeSharedDatabaseError(message.error),
            );
          }
        }
        return;
      }
      const pending = this.pendingRequests.get(message.requestId);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.requestId);
      if (message.type === "error") {
        pending.reject(deserializeSharedDatabaseError(message.error));
        return;
      }
      pending.resolve(message.value);
    });
    this.port.addEventListener("message", this.handleMessage);
    this.port.start();
    bridgeSignal.addEventListener("abort", this.handleBridgeAbort, {
      once: true,
    });
  }

  registerTab(signal: AbortSignal): Promise<void> {
    AbortSignal.any([signal, this.bridgeSignal]).throwIfAborted();
    if (this.closed) {
      throw this.closeReason;
    }
    if (!this.registration) {
      this.registration = Promise.resolve();
      this.registered = true;
      this.emit({ type: "register-tab" });
      this.heartbeatLoop(() => {
        this.emit({ type: "heartbeat" });
      }, this.bridgeSignal);
    }
    return this.registration;
  }

  fail(reason: unknown): void {
    this.close(reason);
  }

  subscribeRealtime<TScope extends SharedDatabaseRealtimeScope>(
    subscriptionId: string,
    scope: TScope,
    topic: SharedDatabaseRealtimeTopic<NoInfer<TScope>>,
    listener: (message: SharedDatabaseRealtimeMessage) => void,
    onResync: () => void,
  ): Promise<void> {
    this.requireRegistration();
    if (this.closed) {
      throw this.closeReason;
    }
    if (this.pendingRealtimeSubscriptions.has(subscriptionId)) {
      throw new Error("Shared database realtime subscription already exists");
    }
    const deferred = createDeferredPromise<void>(this.bridgeSignal);
    this.pendingRealtimeSubscriptions.set(subscriptionId, {
      deferred,
      listener,
      onResync,
    });
    this.emit({ type: "realtime-subscribe", subscriptionId, scope, topic });
    return deferred.promise;
  }

  unsubscribeRealtime(subscriptionId: string): void {
    const subscription = this.pendingRealtimeSubscriptions.get(subscriptionId);
    if (!subscription) {
      return;
    }
    this.pendingRealtimeSubscriptions.delete(subscriptionId);
    if (!this.closed) {
      this.emit({ type: "realtime-unsubscribe", subscriptionId });
    }
    if (!subscription.deferred.settled()) {
      subscription.deferred.reject(
        new DOMException("Realtime subscription closed", "AbortError"),
      );
    }
  }

  async getComputed<TKey extends ComputedKey>(
    computedKey: TKey,
  ): Promise<ComputedValue<TKey>> {
    this.requireRegistration();
    const value = await this.request({
      type: "get-computed",
      requestId: crypto.randomUUID(),
      computedKey,
    });
    return parseComputedValue(computedKey, value);
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    const value = await this.request(
      {
        type: "query",
        requestId: crypto.randomUUID(),
        query,
      },
      signal,
    );
    return parseSharedDatabaseQueryResult(query.dataKey, value);
  }

  private request(
    message: Extract<
      SharedDatabaseClientMessage,
      {
        readonly type: "query" | "get-computed";
      }
    >,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.bridgeSignal])
      : this.bridgeSignal;
    signal.throwIfAborted();
    if (this.closed) {
      throw this.closeReason;
    }
    const deferred = createDeferredPromise<unknown>(signal);
    const requestId = message.requestId;
    const abort = () => {
      this.pendingRequests.delete(requestId);
    };
    const finish = (callback: (value: unknown) => void) => {
      return (value: unknown) => {
        signal.removeEventListener("abort", abort);
        if (!deferred.settled()) {
          callback(value);
        }
      };
    };
    this.pendingRequests.set(requestId, {
      resolve: finish(deferred.resolve),
      reject: finish(deferred.reject),
    });
    signal.addEventListener("abort", abort, { once: true });
    this.emit(message);
    return deferred.promise;
  }

  private requireRegistration(): void {
    if (!this.registered) {
      throw new Error("Shared database tab registration is required first");
    }
  }

  private async respondToTokenRequest(
    message: Extract<
      SharedDatabaseWorkerMessage,
      { readonly type: "get-token" }
    >,
  ): Promise<void> {
    const result = await settle(
      this.getToken(this.bridgeSignal),
      this.bridgeSignal,
    );
    if (this.closed) {
      return;
    }
    if (result.ok) {
      this.emit({
        type: "token-result",
        requestId: message.requestId,
        token: result.value,
      });
      return;
    }
    this.emit({
      type: "token-error",
      requestId: message.requestId,
      error: serializeSharedDatabaseError(result.error),
    });
  }

  private emit(message: SharedDatabaseClientMessage): void {
    L.debug(
      "send message to worker",
      redactSharedDatabaseClientMessageForLog(message),
    );
    this.port.postMessage(message);
  }

  private close(reason: unknown): void {
    if (this.closed) {
      return;
    }
    this.port.postMessage({
      type: "disconnect",
    } satisfies SharedDatabaseClientMessage);
    this.closed = true;
    this.closeReason = reason;
    this.bridgeSignal.removeEventListener("abort", this.handleBridgeAbort);
    this.port.removeEventListener("message", this.handleMessage);
    this.port.close();
    for (const pending of this.pendingRequests.values()) {
      pending.reject(reason);
    }
    this.pendingRequests.clear();
    for (const subscription of this.pendingRealtimeSubscriptions.values()) {
      if (!subscription.deferred.settled()) {
        subscription.deferred.reject(reason);
      }
    }
    this.pendingRealtimeSubscriptions.clear();
  }
}
