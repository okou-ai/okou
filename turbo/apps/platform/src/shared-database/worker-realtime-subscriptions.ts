import { command, computed, state } from "ccstate";

import { setAblyPayloadLoop$ } from "../signals/realtime.ts";
import { resetSignal } from "../signals/utils.ts";
import { rootSignal$ } from "../signals/root-signal.ts";
import {
  serializeSharedDatabaseError,
  sharedDatabaseRealtimeMessageSchema,
  type SharedDatabaseClientMessage,
  type SharedDatabaseRealtimeScope,
} from "./protocol.ts";
import {
  requireConnectionSignal$,
  sendSharedDatabaseWorkerMessageToConnection$,
  type ConnectionId,
} from "./worker-context.ts";

type RealtimeSubscribeMessage = Extract<
  SharedDatabaseClientMessage,
  { readonly type: "realtime-subscribe" }
>;

interface RealtimeSubscriber {
  readonly connectionId: ConnectionId;
  readonly onAbort: () => void;
  readonly signal: AbortSignal;
  readonly subscriptionId: string;
}

interface WorkerRealtimeSubscription {
  readonly graph: WorkerRealtimeSubscriptionGraph;
  readonly signal: AbortSignal;
  readonly ready: boolean;
  readonly subscribers: ReadonlyMap<string, RealtimeSubscriber>;
}

interface WorkerRealtimeSubscriptionIdentity {
  readonly key: string;
  readonly scope: SharedDatabaseRealtimeScope;
  readonly topic: string;
}

// The selected identity constructs a graph without capturing a lifetime.
// Each live subscription keeps that graph until its final subscriber leaves.
const startingSubscriptionIdentity$ =
  state<WorkerRealtimeSubscriptionIdentity | null>(null);
const startingSubscriptionGraph$ = computed((get) => {
  const identity = get(startingSubscriptionIdentity$);
  return identity ? createWorkerRealtimeSubscriptionGraph(identity) : null;
});
type WorkerRealtimeSubscriptionGraph = ReturnType<
  typeof createWorkerRealtimeSubscriptionGraph
>;

const workerRealtimeSubscriptionsState$ = state<
  ReadonlyMap<string, WorkerRealtimeSubscription>
>(new Map());

function workerRealtimeSubscriptionKey(
  scope: SharedDatabaseRealtimeScope,
  topic: string,
): string {
  return JSON.stringify([scope, topic]);
}

function realtimeSubscriberKey(
  connectionId: ConnectionId,
  subscriptionId: string,
): string {
  return JSON.stringify([connectionId, subscriptionId]);
}

function replaceWorkerRealtimeSubscription(
  current: ReadonlyMap<string, WorkerRealtimeSubscription>,
  key: string,
  subscription: WorkerRealtimeSubscription,
): ReadonlyMap<string, WorkerRealtimeSubscription> {
  return new Map(current).set(key, subscription);
}

function removeWorkerRealtimeSubscription(
  current: ReadonlyMap<string, WorkerRealtimeSubscription>,
  key: string,
): ReadonlyMap<string, WorkerRealtimeSubscription> {
  const next = new Map(current);
  next.delete(key);
  return next;
}

const sendRealtimeSubscribed$ = command(
  ({ set }, subscriber: RealtimeSubscriber): void => {
    set(sendSharedDatabaseWorkerMessageToConnection$, subscriber.connectionId, {
      type: "realtime-subscribed",
      subscriptionId: subscriber.subscriptionId,
    });
  },
);

const markWorkerRealtimeSubscriptionReady$ = command(
  ({ get, set }, key: string, signal: AbortSignal): void => {
    const subscription = get(workerRealtimeSubscriptionsState$).get(key);
    if (
      subscription?.signal !== signal ||
      signal.aborted ||
      subscription.ready
    ) {
      return;
    }
    const readySubscription: WorkerRealtimeSubscription = {
      ...subscription,
      ready: true,
    };
    set(workerRealtimeSubscriptionsState$, (current) => {
      return replaceWorkerRealtimeSubscription(current, key, readySubscription);
    });
    for (const subscriber of readySubscription.subscribers.values()) {
      set(sendRealtimeSubscribed$, subscriber);
    }
  },
);

/**
 * Tell every tab holding this subscription that Ably lost continuity. Only the
 * Worker owns the channel, so only it observes `resumed`; each tab then re-runs
 * the same baseline read it performed when the subscription first went live.
 */
const forwardWorkerRealtimeResync$ = command(
  ({ get, set }, key: string, signal: AbortSignal): void => {
    const subscription = get(workerRealtimeSubscriptionsState$).get(key);
    if (subscription?.signal !== signal || signal.aborted) {
      return;
    }
    for (const subscriber of subscription.subscribers.values()) {
      set(
        sendSharedDatabaseWorkerMessageToConnection$,
        subscriber.connectionId,
        {
          type: "realtime-resync",
          subscriptionId: subscriber.subscriptionId,
        },
      );
    }
  },
);

const forwardWorkerRealtimeSubscriptionMessage$ = command(
  (
    { get, set },
    key: string,
    payload: unknown,
    signal: AbortSignal,
  ): boolean => {
    signal.throwIfAborted();
    const subscription = get(workerRealtimeSubscriptionsState$).get(key);
    if (subscription?.signal !== signal || signal.aborted) {
      return false;
    }
    const message = sharedDatabaseRealtimeMessageSchema.parse(payload);
    for (const subscriber of subscription.subscribers.values()) {
      set(
        sendSharedDatabaseWorkerMessageToConnection$,
        subscriber.connectionId,
        {
          type: "realtime-event",
          subscriptionId: subscriber.subscriptionId,
          message,
        },
      );
    }
    return false;
  },
);

const failWorkerRealtimeSubscription$ = command(
  ({ get, set }, key: string, error: unknown, signal: AbortSignal): void => {
    const subscription = get(workerRealtimeSubscriptionsState$).get(key);
    if (subscription?.signal !== signal || signal.aborted) {
      return;
    }
    const serialized = serializeSharedDatabaseError(error);
    for (const subscriber of subscription.subscribers.values()) {
      subscriber.signal.removeEventListener("abort", subscriber.onAbort);
      set(
        sendSharedDatabaseWorkerMessageToConnection$,
        subscriber.connectionId,
        {
          type: "realtime-subscription-error",
          subscriptionId: subscriber.subscriptionId,
          error: serialized,
        },
      );
    }
    set(workerRealtimeSubscriptionsState$, (current) => {
      return removeWorkerRealtimeSubscription(current, key);
    });
    set(subscription.graph.resetSubscription$);
  },
);

function createWorkerRealtimeSubscriptionGraph({
  key,
  scope,
  topic,
}: WorkerRealtimeSubscriptionIdentity) {
  const resetSubscription$ = resetSignal();
  const forward$ = command(({ set }, payload: unknown, signal: AbortSignal) => {
    return set(forwardWorkerRealtimeSubscriptionMessage$, key, payload, signal);
  });
  const run$ = command(({ set }, signal: AbortSignal): void => {
    set(
      setAblyPayloadLoop$,
      {
        scope,
        topic,
        loopCommand$: forward$,
        includeMessage: true,
        options: {
          onSubscribed: () => {
            set(markWorkerRealtimeSubscriptionReady$, key, signal);
          },
          onResync: () => {
            set(forwardWorkerRealtimeResync$, key, signal);
          },
          onError: (error) => {
            set(failWorkerRealtimeSubscription$, key, error, signal);
          },
        },
      },
      signal,
    );
  });
  return { resetSubscription$, run$ };
}

export const stopWorkerRealtimeSubscription$ = command(
  ({ get, set }, connectionId: ConnectionId, subscriptionId: string): void => {
    const subscriberKey = realtimeSubscriberKey(connectionId, subscriptionId);
    for (const [key, subscription] of get(workerRealtimeSubscriptionsState$)) {
      if (!subscription.subscribers.has(subscriberKey)) {
        continue;
      }
      const subscriber = subscription.subscribers.get(subscriberKey);
      if (!subscriber) {
        return;
      }
      subscriber.signal.removeEventListener("abort", subscriber.onAbort);
      const subscribers = new Map(subscription.subscribers);
      subscribers.delete(subscriberKey);
      if (subscribers.size === 0) {
        set(workerRealtimeSubscriptionsState$, (current) => {
          return removeWorkerRealtimeSubscription(current, key);
        });
        set(subscription.graph.resetSubscription$);
        return;
      }
      set(workerRealtimeSubscriptionsState$, (current) => {
        return replaceWorkerRealtimeSubscription(current, key, {
          ...subscription,
          subscribers,
        });
      });
      return;
    }
  },
);

export const startWorkerRealtimeSubscription$ = command(
  (
    { get, set },
    connectionId: ConnectionId,
    message: RealtimeSubscribeMessage,
    signal: AbortSignal,
  ): void => {
    set(requireConnectionSignal$, connectionId, signal);
    const key = workerRealtimeSubscriptionKey(message.scope, message.topic);
    const subscriberKey = realtimeSubscriberKey(
      connectionId,
      message.subscriptionId,
    );
    const onAbort = () => {
      set(
        stopWorkerRealtimeSubscription$,
        connectionId,
        message.subscriptionId,
      );
    };
    const subscriber: RealtimeSubscriber = {
      connectionId,
      onAbort,
      signal,
      subscriptionId: message.subscriptionId,
    };
    const current = get(workerRealtimeSubscriptionsState$);
    const existing = current.get(key);
    if (existing) {
      if (existing.subscribers.has(subscriberKey)) {
        throw new Error("Shared database realtime subscription already exists");
      }
      const subscribers = new Map(existing.subscribers);
      subscribers.set(subscriberKey, subscriber);
      const updated: WorkerRealtimeSubscription = {
        ...existing,
        subscribers,
      };
      set(workerRealtimeSubscriptionsState$, (state) => {
        return replaceWorkerRealtimeSubscription(state, key, updated);
      });
      signal.addEventListener("abort", subscriber.onAbort, { once: true });
      if (updated.ready) {
        set(sendRealtimeSubscribed$, subscriber);
      }
      return;
    }

    const parentSignal = get(rootSignal$);
    parentSignal.throwIfAborted();
    set(startingSubscriptionIdentity$, {
      key,
      scope: message.scope,
      topic: message.topic,
    });
    const graph = get(startingSubscriptionGraph$);
    if (!graph) {
      throw new Error(
        "Shared database realtime subscription graph is unavailable",
      );
    }
    const subscriptionSignal = set(graph.resetSubscription$, parentSignal);
    const subscription: WorkerRealtimeSubscription = {
      graph,
      signal: subscriptionSignal,
      ready: false,
      subscribers: new Map([[subscriberKey, subscriber]]),
    };
    set(workerRealtimeSubscriptionsState$, (state) => {
      return replaceWorkerRealtimeSubscription(state, key, subscription);
    });
    signal.addEventListener("abort", subscriber.onAbort, { once: true });
    set(graph.run$, subscriptionSignal);
  },
);
