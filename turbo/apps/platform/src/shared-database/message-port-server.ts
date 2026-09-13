import type { Store } from "ccstate";

import { captureSentryLogError } from "../lib/sentry-config.ts";
import { logger } from "../signals/log.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  detach,
  onDomEventFn,
  Reason,
  settle,
} from "../signals/utils.ts";
import type {
  SharedDatabasePortLike,
  SharedDatabaseTokenProvider,
} from "./bridge.ts";
import {
  deserializeSharedDatabaseError,
  redactSharedDatabaseClientMessageForLog,
  serializeSharedDatabaseError,
  sharedDatabaseClientMessageSchema,
  type SharedDatabaseClientMessage,
  type SharedDatabaseWorkerMessage,
} from "./protocol.ts";
import {
  recordConnectionHeartbeat$,
  registerConnection$,
} from "./worker-context.ts";
import {
  getComputedStoreMessage$,
  queryStoreMessage$,
  startSharedDatabaseWorkerDaemons$,
} from "./worker-signals.ts";
import {
  startWorkerRealtimeSubscription$,
  stopWorkerRealtimeSubscription$,
} from "./worker-realtime-subscriptions.ts";

type RequestMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "get-computed" | "query" }
>;
type TokenResponseMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "token-error" | "token-result" }
>;
type RealtimeSubscribeMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "realtime-subscribe" }
>;
type RealtimeUnsubscribeMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "realtime-unsubscribe" }
>;

interface PendingTokenRequest {
  readonly reject: (reason: unknown) => void;
  readonly resolve: (token: string | null) => void;
}

const L = logger("SharedDatabaseWorker");
const BridgeL = logger("SharedWorkerBridge");

export class SharedDatabaseMessagePortServer {
  private readonly connectionId = crypto.randomUUID();
  private readonly connectionController: AbortController;
  private readonly connectionSignal: AbortSignal;
  private readonly pendingTokenRequests = new Map<
    string,
    PendingTokenRequest
  >();
  private registeredSignal: AbortSignal | null = null;
  private disconnected = false;

  constructor(
    private readonly store: Store,
    private readonly port: SharedDatabasePortLike,
    workerSignal: AbortSignal,
  ) {
    workerSignal.throwIfAborted();
    // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
    this.connectionController = createChildAbortController(workerSignal);
    this.connectionSignal = this.connectionController.signal;
    L.debug("connection.connect", { connectionId: this.connectionId });
    port.addEventListener("message", this.handleMessage);
    port.start();
    this.connectionSignal.addEventListener(
      "abort",
      this.handleConnectionAbort,
      { once: true },
    );
  }

  private readonly handleConnectionAbort = (): void => {
    this.disconnect("connection-abort");
  };

  private readonly handleRegisteredConnectionAbort = (): void => {
    this.disconnect("worker-abort");
  };

  private emit(message: SharedDatabaseWorkerMessage): void {
    if (!this.disconnected) {
      BridgeL.debug("send message to app", this.connectionId, message);
      this.port.postMessage(message);
    }
  }

  private async startRequest(
    message: RequestMessage,
    signal: AbortSignal,
    operation: () => Promise<unknown> | unknown,
  ): Promise<void> {
    L.debug("request.start", {
      connectionId: this.connectionId,
      requestId: message.requestId,
      type: message.type,
    });
    const result = await settle(
      (async (): Promise<unknown> => {
        return await operation();
      })(),
    );
    if (this.disconnected || signal.aborted) {
      return;
    }
    if (result.ok) {
      L.debug("request.finish", {
        connectionId: this.connectionId,
        requestId: message.requestId,
        type: message.type,
      });
      this.emit({
        type: "result",
        requestId: message.requestId,
        value: result.value,
      });
      return;
    }
    const error = serializeSharedDatabaseError(result.error);
    L.debug("request.error", {
      connectionId: this.connectionId,
      error,
      requestId: message.requestId,
      type: message.type,
    });
    this.emit({
      type: "error",
      requestId: message.requestId,
      error,
    });
  }

  private routeStoreMessage(
    message: RequestMessage,
    signal: AbortSignal,
  ): Promise<unknown> | unknown {
    if (this.registeredSignal !== signal) {
      throw new Error(
        "Shared database tab registration is required before query",
      );
    }
    switch (message.type) {
      case "query": {
        return this.store.set(
          queryStoreMessage$,
          this.connectionId,
          message,
          signal,
        );
      }
      case "get-computed": {
        return this.store.set(
          getComputedStoreMessage$,
          this.connectionId,
          message,
          signal,
        );
      }
    }
  }

  private registerTab(): void {
    if (this.registeredSignal) {
      throw new Error("Shared database tab is already registered");
    }
    const signal = this.store.set(
      registerConnection$,
      this.connectionId,
      this.connectionController,
      { getToken: this.requestToken, port: this.port },
      this.connectionSignal,
    );
    this.registeredSignal = signal;
    signal.addEventListener("abort", this.handleRegisteredConnectionAbort, {
      once: true,
    });
  }

  private readonly requestToken: SharedDatabaseTokenProvider = (
    callerSignal,
  ) => {
    const registeredSignal = this.registeredSignal;
    if (!registeredSignal) {
      throw new Error(
        "Shared database tab registration is required before query",
      );
    }
    const signal = AbortSignal.any([callerSignal, registeredSignal]);
    signal.throwIfAborted();
    const deferred = createDeferredPromise<string | null>(signal);
    const requestId = crypto.randomUUID();
    const abort = () => {
      this.pendingTokenRequests.delete(requestId);
    };
    const finish = <T>(callback: (value: T) => void) => {
      return (value: T) => {
        signal.removeEventListener("abort", abort);
        if (!deferred.settled()) {
          callback(value);
        }
      };
    };
    this.pendingTokenRequests.set(requestId, {
      reject: finish(deferred.reject),
      resolve: finish(deferred.resolve),
    });
    signal.addEventListener("abort", abort, { once: true });
    this.emit({ type: "get-token", requestId });
    return deferred.promise;
  };

  private finishTokenRequest(message: TokenResponseMessage): void {
    const pending = this.pendingTokenRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pendingTokenRequests.delete(message.requestId);
    if (message.type === "token-error") {
      pending.reject(deserializeSharedDatabaseError(message.error));
      return;
    }
    pending.resolve(message.token);
  }

  private startRealtimeSubscription(
    message: RealtimeSubscribeMessage,
    signal: AbortSignal,
  ): void {
    const daemon = this.store.set(
      startWorkerRealtimeSubscription$,
      this.connectionId,
      message,
      signal,
    );
    if (daemon) {
      detach(daemon, Reason.Daemon, "shared database realtime subscription");
    }
  }

  private stopRealtimeSubscription(message: RealtimeUnsubscribeMessage): void {
    this.store.set(
      stopWorkerRealtimeSubscription$,
      this.connectionId,
      message.subscriptionId,
    );
  }

  private disconnect(reason: string): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    L.debug("connection.disconnect", {
      connectionId: this.connectionId,
      reason,
    });
    this.port.removeEventListener("message", this.handleMessage);
    this.connectionSignal.removeEventListener(
      "abort",
      this.handleConnectionAbort,
    );
    this.registeredSignal?.removeEventListener(
      "abort",
      this.handleRegisteredConnectionAbort,
    );
    this.connectionController.abort(
      new DOMException(
        "Shared database MessagePort disconnected",
        "AbortError",
      ),
    );
    this.registeredSignal = null;
    this.port.close();
  }

  private readonly handleMessage = onDomEventFn(
    async (event: MessageEvent<unknown>): Promise<void> => {
      const parsed = sharedDatabaseClientMessageSchema.safeParse(event.data);
      if (!parsed.success) {
        this.disconnect("invalid-message");
        const error = new Error("Invalid shared database client message");
        const details = {
          connectionId: this.connectionId,
          issueCount: parsed.error.issues.length,
        };
        L.debug("protocol.error", { ...details, error });
        captureSentryLogError("SharedDatabaseWorker", [error, details]);
        return;
      }
      const message = parsed.data;
      BridgeL.debug(
        "got message from app",
        this.connectionId,
        redactSharedDatabaseClientMessageForLog(message),
      );
      if (message.type === "token-error" || message.type === "token-result") {
        this.finishTokenRequest(message);
        return;
      }
      if (message.type === "disconnect") {
        this.disconnect("client-request");
        return;
      }
      if (message.type === "register-tab") {
        this.registerTab();
        return;
      }
      const registeredSignal = this.registeredSignal;
      if (!registeredSignal) {
        if ("requestId" in message) {
          await this.startRequest(message, this.connectionSignal, () => {
            throw new Error(
              "Shared database tab registration is required before query",
            );
          });
        }
        return;
      }
      if (message.type === "heartbeat") {
        this.store.set(recordConnectionHeartbeat$, this.connectionId);
        // Token routing only considers tabs that have sent a heartbeat, so the
        // first heartbeat must be visible before realtime setup requests one.
        const daemon = this.store.set(startSharedDatabaseWorkerDaemons$);
        if (daemon) {
          detach(daemon, Reason.Daemon, "shared database Worker daemons");
        }
        return;
      }
      if (message.type === "realtime-subscribe") {
        this.startRealtimeSubscription(message, registeredSignal);
        return;
      }
      if (message.type === "realtime-unsubscribe") {
        this.stopRealtimeSubscription(message);
        return;
      }
      await this.startRequest(message, registeredSignal, () => {
        return this.routeStoreMessage(message, registeredSignal);
      });
    },
  );
}
