import { command, state, type Command } from "ccstate";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import type {
  ChannelOptions,
  ChannelStateChange,
  ConnectionStateChange,
  InboundMessage,
  RealtimeChannel,
} from "ably";
import { delay } from "signal-timers";
import type { SharedDatabaseBridge } from "../shared-database/bridge.ts";
import type { SharedDatabaseRealtimeScope } from "../shared-database/protocol.ts";
import { IN_VITEST } from "../env.ts";
import { createAblyRealtime, type AblyRealtime } from "../lib/ably-realtime.ts";
import { now } from "../lib/time.ts";
import { apiClient$ } from "./api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "./auth-context.ts";
import { createAblyAuthCallback } from "../lib/ably-auth.ts";
import {
  connectionDiagnosticError,
  createConnectionDiagnosticSpanId,
  publishConnectionDiagnostic,
  type ConnectionDiagnosticDetails,
} from "./connection-diagnostics.ts";
import {
  createDeferredPromise,
  onRejection,
  settle,
  setLoop,
  throwIfAbort,
  withCleanup,
} from "./utils.ts";
import { logger } from "./log.ts";

const L = logger("Realtime");
const REALTIME_TRANSIENT_RETRY_DELAYS_MS = [
  1000, 2000, 5000, 10_000, 30_000,
] as const;
const MAX_TRANSIENT_RETRIES = 3;

/**
 * Register listeners without Ably's default implicit attach.
 *
 * With the default, `channel.subscribe()` attaches as a side effect, and that
 * attach rejects outright while the connection is suspended, closing, closed
 * or failed. This module then dropped the listener it had just registered, and
 * a channel without listeners never recovers: `Channels.onTransportActive()`
 * reattaches the channel, but it cannot restore a listener we removed.
 *
 * Subscribing therefore only registers the listener. Attaching happens once,
 * while the connection is known to be usable, and Ably owns it from there.
 */
function realtimeChannelOptions(): ChannelOptions {
  return { attachOnSubscribe: false };
}

function connectionStateDetails(
  stateChange: ConnectionStateChange,
): ConnectionDiagnosticDetails {
  const errorDetails = connectionDiagnosticError(stateChange.reason);
  return {
    ...errorDetails,
    connectionState: stateChange.current,
    previousConnectionState: stateChange.previous,
    retryInMs:
      typeof stateChange.retryIn === "number"
        ? stateChange.retryIn
        : errorDetails.retryInMs,
  };
}

function channelStateDetails(
  stateChange: ChannelStateChange,
): ConnectionDiagnosticDetails {
  return {
    ...connectionDiagnosticError(stateChange.reason),
    channelState: stateChange.current,
    previousChannelState: stateChange.previous,
  };
}

const realtimeDegradedToastShown$ = state(false);
const realtimeDegradedNotifier$ = state<(() => void) | null>(null);

export const setRealtimeDegradedNotifier$ = command(
  ({ set }, notify: () => void): void => {
    set(realtimeDegradedNotifier$, () => {
      return notify;
    });
  },
);

const notifyRealtimeDegraded$ = command(({ get, set }) => {
  if (get(realtimeDegradedToastShown$)) {
    return;
  }
  set(realtimeDegradedToastShown$, true);
  get(realtimeDegradedNotifier$)?.();
});

interface RealtimeMessage {
  readonly data: unknown;
  readonly name: string | null;
}

type ChannelCallback = (message: RealtimeMessage) => void;

/**
 * Called when Ably reports that message continuity on the channel was lost, so
 * the subscription has to re-read whatever baseline it established when it
 * first went live. Ably replays everything it can by itself; this only fires
 * for the gap it cannot replay.
 */
type ChannelResyncCallback = () => void;

interface RealtimeSubscriptionChannel {
  readonly subscribe: (
    topic: string | null,
    callback: ChannelCallback,
    onResync: ChannelResyncCallback,
  ) => Promise<unknown>;
  readonly unsubscribe: (
    topic: string | null,
    callback: ChannelCallback,
  ) => void;
}

interface RealtimeSession {
  readonly ably: AblyRealtime;
  readonly channels: RealtimeSessionChannels;
}

type RealtimeChannelScope = SharedDatabaseRealtimeScope;

interface RealtimeSessionChannels {
  readonly credential: RealtimeSubscriptionChannel;
  readonly user: RealtimeSubscriptionChannel;
  readonly org: RealtimeSubscriptionChannel;
}

class SharedWorkerRealtimeChannel implements RealtimeSubscriptionChannel {
  private readonly subscriptions = new Map<ChannelCallback, string>();

  constructor(
    private readonly bridge: SharedDatabaseBridge,
    private readonly scope: RealtimeChannelScope,
  ) {}

  subscribe(
    topic: string | null,
    callback: ChannelCallback,
    onResync: ChannelResyncCallback,
  ): Promise<unknown> {
    if (topic === null) {
      throw new Error("Shared Worker realtime subscriptions require a topic");
    }
    if (this.subscriptions.has(callback)) {
      throw new Error("Shared Worker realtime callback already exists");
    }
    const subscriptionId = crypto.randomUUID();
    this.subscriptions.set(callback, subscriptionId);
    return this.bridge.subscribeRealtime(
      subscriptionId,
      this.scope,
      topic,
      callback,
      onResync,
    );
  }

  unsubscribe(_topic: string | null, callback: ChannelCallback): void {
    const subscriptionId = this.subscriptions.get(callback);
    if (!subscriptionId) {
      return;
    }
    this.subscriptions.delete(callback);
    this.bridge.unsubscribeRealtime(subscriptionId);
  }
}

const sharedWorkerRealtimeBridgeState$ = state<SharedDatabaseBridge | null>(
  null,
);

export const setSharedWorkerRealtimeBridge$ = command(
  ({ set }, bridge: SharedDatabaseBridge): void => {
    set(sharedWorkerRealtimeBridgeState$, bridge);
  },
);

const internalRealtimeSession$ = state<RealtimeSession | null>(null);
interface PendingAblySubscription {
  readonly scope: RealtimeChannelScope;
  topic: string | null;
  signal: AbortSignal;
  channelDeferred: ReturnType<
    typeof createDeferredPromise<RealtimeSubscriptionChannel>
  >;
}

const pendingAblySubscriptions$ = state<readonly PendingAblySubscription[]>([]);

interface RealtimeSubscribeOptions {
  readonly onSubscribed?: () => void;
  /** Observe a continuity gap in addition to the loop's own recovery. */
  readonly onResync?: () => void;
  readonly runOnSubscribe?: boolean;
}

export type RealtimeInvalidationCommands = readonly [
  Command<void, []>,
  ...Command<void, []>[],
];

type RealtimeLoopAction =
  | {
      readonly kind: "command";
      readonly command$: Command<Promise<boolean> | boolean, [AbortSignal]>;
    }
  | {
      readonly kind: "invalidate";
      readonly invalidations: RealtimeInvalidationCommands;
    };

interface RealtimeLoopArgs {
  readonly channel: RealtimeSubscriptionChannel;
  readonly topic: string;
  readonly action: RealtimeLoopAction;
  readonly options?: RealtimeSubscribeOptions;
}

interface RealtimePayloadLoopArgs {
  readonly channel: RealtimeSubscriptionChannel;
  readonly topic: string | null;
  readonly loopCommand$: Command<
    Promise<boolean> | boolean,
    [unknown, AbortSignal]
  >;
  readonly includeMessage?: boolean;
  readonly initializeCommand$?: Command<
    Promise<boolean> | boolean,
    [AbortSignal]
  >;
  readonly options?: RealtimeSubscribeOptions;
}

interface SetAblyLoopArgs {
  readonly scope?: RealtimeChannelScope;
  readonly topic: string;
  readonly loopCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>;
  readonly options?: RealtimeSubscribeOptions;
}

interface SetAblyInvalidationLoopArgs {
  readonly scope?: RealtimeChannelScope;
  readonly topic: string;
  readonly invalidations: RealtimeInvalidationCommands;
  readonly options?: RealtimeSubscribeOptions;
}

interface SetAblyPayloadLoopArgs {
  readonly scope?: RealtimeChannelScope;
  readonly topic: string | null;
  readonly loopCommand$: Command<
    Promise<boolean> | boolean,
    [unknown, AbortSignal]
  >;
  readonly includeMessage?: boolean;
  readonly initializeCommand$?: Command<
    Promise<boolean> | boolean,
    [AbortSignal]
  >;
  readonly options?: RealtimeSubscribeOptions;
}

interface RealtimePayloadLoopState {
  deferred: ReturnType<typeof createDeferredPromise<boolean>>;
  poked: boolean;
  /**
   * A continuity gap is waiting to be handled on the next iteration. It only
   * produces work for a subscription that has an `initializeCommand$`: a purely
   * event-driven payload subscription has no baseline to re-read, so its data
   * stays as stale as the events it missed.
   */
  resyncPending: boolean;
  transientRetryCount: number;
  readonly pendingPayloads: unknown[];
}

interface RealtimePayloadLoopIterationArgs {
  readonly state: RealtimePayloadLoopState;
  readonly loopCommand$: Command<
    Promise<boolean> | boolean,
    [unknown, AbortSignal]
  >;
  readonly initializeCommand$?: Command<
    Promise<boolean> | boolean,
    [AbortSignal]
  >;
  readonly pokeLoop: () => void;
}

async function waitForTransientRetry(
  signal: AbortSignal,
  retryCount: number,
): Promise<void> {
  const delayMs = IN_VITEST
    ? 0
    : (REALTIME_TRANSIENT_RETRY_DELAYS_MS[
        Math.min(retryCount, REALTIME_TRANSIENT_RETRY_DELAYS_MS.length - 1)
      ] ?? 30_000);
  await delay(delayMs, { signal });
  signal.throwIfAborted();
}

interface SubscribeChannelArgs {
  readonly channel: RealtimeSubscriptionChannel;
  readonly topic: string | null;
  readonly callback: ChannelCallback;
  readonly onResync: ChannelResyncCallback;
  readonly run: () => Promise<void>;
}

async function subscribeChannel(
  { channel, topic, callback, onResync, run }: SubscribeChannelArgs,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();

  const unsubscribeChannel = () => {
    signal.removeEventListener("abort", unsubscribeChannel);
    channel.unsubscribe(topic, callback);
  };
  signal.addEventListener("abort", unsubscribeChannel, { once: true });

  // The attach that brings this subscription up also reports a continuity gap,
  // because it replayed nothing. That is not a gap for a subscription that had
  // no baseline yet, so resyncs only count once the subscription is live.
  let live = false;
  const handleResync = () => {
    if (live) {
      onResync();
    }
  };

  await onRejection(
    channel.subscribe(topic, callback, handleResync),
    unsubscribeChannel,
  );
  signal.throwIfAborted();
  live = true;
  await withCleanup(run(), unsubscribeChannel);
  signal.throwIfAborted();
}

const runWithChannel$ = command(
  async (
    { set },
    { channel, topic, action, options }: RealtimeLoopArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    // No implicit prime on subscribe by default. Callers whose loop body sets
    // up baseline state must run the body themselves before calling this, then
    // opt in to runOnSubscribe if they also need to catch events that occurred
    // between the baseline and subscription.
    signal.throwIfAborted();
    let deferred = createDeferredPromise(signal);
    let poked = false;
    let transientRetryCount = 0;

    const pokeLoop = () => {
      if (signal.aborted || poked || deferred.settled()) {
        return;
      }
      poked = true;
      deferred.resolve(true);
    };
    const callback = (message: RealtimeMessage) => {
      if (signal.aborted) {
        return;
      }
      L.debug("got message from topic", topic, message);
      pokeLoop();
    };
    await subscribeChannel(
      {
        channel,
        topic,
        callback,
        // A continuity gap is indistinguishable from an unseen event on this
        // topic: both mean the loop body has to read current state again.
        onResync: () => {
          if (signal.aborted) {
            return;
          }
          L.debug("resyncing topic after a continuity gap", topic);
          options?.onResync?.();
          pokeLoop();
        },
        run: async () => {
          options?.onSubscribed?.();
          if (options?.runOnSubscribe) {
            pokeLoop();
          }
          L.debug("subscribed to topic: " + topic);

          await setLoop(
            async (loopSignal) => {
              await deferred.promise;
              loopSignal.throwIfAborted();
              deferred = createDeferredPromise(loopSignal);
              poked = false;
              // eslint-disable-next-line no-restricted-syntax -- polling loop requires try/catch for transient error retry with backoff
              try {
                let done = false;
                if (action.kind === "command") {
                  done = await set(action.command$, loopSignal);
                } else {
                  for (const invalidation$ of action.invalidations) {
                    set(invalidation$);
                  }
                }
                loopSignal.throwIfAborted();
                transientRetryCount = 0;
                if (done) {
                  return true;
                }
              } catch (error) {
                throwIfAbort(error);
                loopSignal.throwIfAborted();
                if (transientRetryCount >= MAX_TRANSIENT_RETRIES) {
                  L.warn(
                    `giving up on ably notification after repeated handler failures`,
                    error,
                  );
                  transientRetryCount = 0;
                  set(notifyRealtimeDegraded$);
                  return false;
                }
                L.warn(`transient error in ably notification`, error);
                await waitForTransientRetry(loopSignal, transientRetryCount);
                loopSignal.throwIfAborted();
                transientRetryCount++;
                pokeLoop();
              }
              return false;
            },
            0,
            signal,
          );
        },
      },
      signal,
    );
  },
);

/**
 * Read the subscription's baseline state. Runs once when the subscription goes
 * live, and again after every continuity gap Ably could not replay. Resolves
 * true when the subscription is finished and its loop should stop.
 */
const runSubscriptionBaseline$ = command(
  async (
    { set },
    initializeCommand$: Command<Promise<boolean> | boolean, [AbortSignal]>,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const initialized = await settle(
      (async () => {
        return await set(initializeCommand$, signal);
      })(),
      signal,
    );
    signal.throwIfAborted();
    if (!initialized.ok) {
      L.warn("realtime subscription initialization failed", initialized.error);
      set(notifyRealtimeDegraded$);
      return false;
    }
    return initialized.value;
  },
);

const runPayloadLoopIteration$ = command(
  async (
    { set },
    {
      state,
      loopCommand$,
      initializeCommand$,
      pokeLoop,
    }: RealtimePayloadLoopIterationArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    await state.deferred.promise;
    signal.throwIfAborted();
    state.deferred = createDeferredPromise(signal);
    state.poked = false;

    if (state.resyncPending) {
      state.resyncPending = false;
      if (
        initializeCommand$ &&
        (await set(runSubscriptionBaseline$, initializeCommand$, signal))
      ) {
        return true;
      }
      signal.throwIfAborted();
    }

    if (state.pendingPayloads.length === 0) {
      return false;
    }

    const payload = state.pendingPayloads[0];
    let done = false;
    // eslint-disable-next-line no-restricted-syntax -- payload notifications retry transient handler failures before dropping a poisoned queue item
    try {
      done = await set(loopCommand$, payload, signal);
      signal.throwIfAborted();
    } catch (error) {
      throwIfAbort(error);
      signal.throwIfAborted();
      if (state.transientRetryCount >= MAX_TRANSIENT_RETRIES) {
        L.warn(`dropping ably payload after repeated handler failures`, error);
        state.pendingPayloads.shift();
        state.transientRetryCount = 0;
        set(notifyRealtimeDegraded$);
        if (state.pendingPayloads.length > 0) {
          pokeLoop();
        }
        return false;
      }
      L.warn(`transient error in ably payload notification`, error);
      await waitForTransientRetry(signal, state.transientRetryCount);
      signal.throwIfAborted();
      state.transientRetryCount++;
      pokeLoop();
      return false;
    }
    state.pendingPayloads.shift();
    state.transientRetryCount = 0;
    if (done) {
      return true;
    }
    if (state.pendingPayloads.length > 0) {
      pokeLoop();
    }
    return false;
  },
);

const runWithChannelPayload$ = command(
  async (
    { set },
    args: RealtimePayloadLoopArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const {
      channel,
      topic,
      loopCommand$,
      includeMessage,
      initializeCommand$,
      options,
    } = args;
    signal.throwIfAborted();
    const subscriptionLabel = topic ?? "channel";
    const state: RealtimePayloadLoopState = {
      deferred: createDeferredPromise(signal),
      poked: false,
      resyncPending: false,
      transientRetryCount: 0,
      pendingPayloads: [],
    };

    const pokeLoop = () => {
      if (signal.aborted || state.poked || state.deferred.settled()) {
        return;
      }
      state.poked = true;
      state.deferred.resolve(true);
    };

    const callback = (message: RealtimeMessage) => {
      if (signal.aborted) {
        return;
      }
      L.debug("got queued message from topic", subscriptionLabel, message);
      state.pendingPayloads.push(includeMessage ? message : message.data);
      pokeLoop();
    };
    await subscribeChannel(
      {
        channel,
        topic,
        callback,
        // Ably replays what it can; this only fires for the gap it cannot, so
        // the subscription re-reads its baseline on the next loop iteration.
        onResync: () => {
          if (signal.aborted) {
            return;
          }
          L.debug("resyncing payload topic after a gap", subscriptionLabel);
          state.resyncPending = true;
          options?.onResync?.();
          pokeLoop();
        },
        run: async () => {
          options?.onSubscribed?.();
          if (
            initializeCommand$ &&
            (await set(runSubscriptionBaseline$, initializeCommand$, signal))
          ) {
            return;
          }
          signal.throwIfAborted();
          L.debug("subscribed to payload topic: " + subscriptionLabel);

          await setLoop(
            async (loopSignal) => {
              return await set(
                runPayloadLoopIteration$,
                {
                  state,
                  loopCommand$,
                  ...(initializeCommand$ ? { initializeCommand$ } : {}),
                  pokeLoop,
                },
                loopSignal,
              );
            },
            0,
            signal,
          );
        },
      },
      signal,
    );
  },
);

interface ActiveChannelSubscription {
  readonly topic: string | null;
  readonly ablyCallback: (message: InboundMessage) => void;
  readonly onResync: ChannelResyncCallback;
}

function subscribeToRealtimeChannel(
  channel: RealtimeChannel,
  subscription: ActiveChannelSubscription,
): Promise<unknown> {
  if (subscription.topic === null) {
    return channel.subscribe(subscription.ablyCallback);
  }
  return channel.subscribe(subscription.topic, subscription.ablyCallback);
}

function unsubscribeFromRealtimeChannel(
  channel: RealtimeChannel,
  subscription: ActiveChannelSubscription,
): void {
  if (subscription.topic === null) {
    channel.unsubscribe(subscription.ablyCallback);
    return;
  }
  channel.unsubscribe(subscription.topic, subscription.ablyCallback);
}

async function trackRealtimeSubscription(
  operation: () => Promise<unknown>,
  subscription: ActiveChannelSubscription,
  subscriberCount: number,
): Promise<void> {
  const spanId = createConnectionDiagnosticSpanId();
  const startedAtMs = now();
  publishConnectionDiagnostic({
    details: {
      subscriberCount,
      subscriptionKind: subscription.topic === null ? "channel" : "topic",
    },
    event: "realtime.subscription",
    phase: "start",
    spanId,
  });
  const result = await settle(operation());
  if (!result.ok) {
    publishConnectionDiagnostic({
      details: {
        ...connectionDiagnosticError(result.error),
        subscriberCount,
        subscriptionKind: subscription.topic === null ? "channel" : "topic",
      },
      durationMs: now() - startedAtMs,
      event: "realtime.subscription",
      phase: "error",
      spanId,
    });
    throw result.error;
  }
  publishConnectionDiagnostic({
    details: {
      subscriberCount,
      subscriptionKind: subscription.topic === null ? "channel" : "topic",
    },
    durationMs: now() - startedAtMs,
    event: "realtime.subscription",
    phase: "finish",
    spanId,
  });
}

function createRealtimeSubscriptionChannel(
  channel: RealtimeChannel,
  signal: AbortSignal,
): RealtimeSubscriptionChannel {
  const subscriptions = new Map<ChannelCallback, ActiveChannelSubscription>();
  // `resumed` is Ably's own continuity signal: false means the reattach could
  // not replay everything, so each subscriber has to re-read its baseline.
  // A preserved reattach reports true and must not trigger extra reads.
  const handleChannelStateChange = (stateChange: ChannelStateChange): void => {
    if (stateChange.current !== "attached" || stateChange.resumed) {
      return;
    }
    for (const subscription of subscriptions.values()) {
      subscription.onResync();
    }
  };
  channel.on(handleChannelStateChange);
  signal.addEventListener(
    "abort",
    () => {
      channel.off(handleChannelStateChange);
    },
    { once: true },
  );
  return {
    subscribe: async (topic, callback, onResync) => {
      const subscription: ActiveChannelSubscription = {
        topic,
        ablyCallback: (message) => {
          callback({ data: message.data, name: message.name ?? null });
        },
        onResync,
      };
      subscriptions.set(callback, subscription);
      await trackRealtimeSubscription(
        () => {
          return onRejection(
            // Registering the listener cannot fail on a transport condition;
            // waiting for `attached` is what makes the subscription live.
            async () => {
              await subscribeToRealtimeChannel(channel, subscription);
              await whenChannelAttached(channel, signal);
            },
            () => {
              subscriptions.delete(callback);
              unsubscribeFromRealtimeChannel(channel, subscription);
            },
          );
        },
        subscription,
        subscriptions.size,
      );
      if (subscriptions.get(callback) !== subscription) {
        unsubscribeFromRealtimeChannel(channel, subscription);
      }
    },
    unsubscribe: (_topic, callback) => {
      const subscription = subscriptions.get(callback);
      if (subscription) {
        subscriptions.delete(callback);
        unsubscribeFromRealtimeChannel(channel, subscription);
      }
    },
  };
}

interface ConnectedRealtimeChannels {
  readonly credential: RealtimeChannel;
  readonly user: RealtimeChannel;
  readonly org: RealtimeChannel;
}

function connectedRealtimeChannels(
  ably: AblyRealtime,
  userId: string,
  orgId: string,
): ConnectedRealtimeChannels {
  return {
    credential: ably.channels.get(
      `user-org:${userId}:${orgId}`,
      realtimeChannelOptions(),
    ),
    user: ably.channels.get(`user:${userId}`, realtimeChannelOptions()),
    org: ably.channels.get(`org:${orgId}`, realtimeChannelOptions()),
  };
}

function realtimeChannelList(
  channels: ConnectedRealtimeChannels,
): readonly RealtimeChannel[] {
  return [channels.credential, channels.user, channels.org];
}

/**
 * Hand every channel to Ably's own reattachment, once.
 *
 * The caller runs this while the connection is `connected`, which is the one
 * moment an attach is guaranteed to be accepted. Reaching `attaching` is all
 * that is required: from there `Channels.onTransportActive()` reattaches the
 * channel after every later drop, and a channel that drops is `suspended`
 * rather than `initialized`, so it never falls out of that set again.
 *
 * A rejected attach is reported, not propagated. It is not a subscription
 * failure, and callers wait on channel state rather than on this call.
 */
async function attachRealtimeChannels(
  channels: ConnectedRealtimeChannels,
): Promise<void> {
  await Promise.all(
    realtimeChannelList(channels).map(async (channel) => {
      const result = await settle(channel.attach());
      if (result.ok) {
        return;
      }
      L.warn("realtime channel attach failed", {
        channelState: channel.state,
        error: result.error,
      });
      publishConnectionDiagnostic({
        details: {
          ...connectionDiagnosticError(result.error),
          channelState: channel.state,
        },
        event: "realtime.channel",
        phase: "error",
      });
    }),
  );
}

/**
 * Resolve once the channel carries messages. Callers rely on this ordering:
 * subscription initialization and catch-up must not run against a channel that
 * is not attached yet, or they would leave a gap for the events in between.
 */
function whenChannelAttached(
  channel: RealtimeChannel,
  signal: AbortSignal,
): Promise<void> {
  if (channel.state === "attached") {
    return Promise.resolve();
  }
  const deferred = createDeferredPromise<void>(signal);
  const handleStateChange = (stateChange: ChannelStateChange): void => {
    if (deferred.settled()) {
      return;
    }
    if (stateChange.current === "attached") {
      deferred.resolve(undefined);
      return;
    }
    if (stateChange.current === "failed") {
      deferred.reject(
        stateChange.reason ?? new Error("Realtime channel attach failed"),
      );
    }
  };
  channel.on(handleStateChange);
  return withCleanup(deferred.promise, () => {
    channel.off(handleStateChange);
  });
}

function observeRealtimeChannels(
  channels: ConnectedRealtimeChannels,
): () => void {
  const handleStateChange = (stateChange: ChannelStateChange): void => {
    publishConnectionDiagnostic({
      details: channelStateDetails(stateChange),
      event: "realtime.channel",
      phase: "instant",
    });
  };
  channels.credential.on(handleStateChange);
  channels.user.on(handleStateChange);
  channels.org.on(handleStateChange);
  return () => {
    channels.credential.off(handleStateChange);
    channels.user.off(handleStateChange);
    channels.org.off(handleStateChange);
  };
}

interface ConnectedRealtimeClient {
  readonly ably: AblyRealtime;
  readonly channels: ConnectedRealtimeChannels;
}

const connectRealtimeClient$ = command(
  async ({ get }, signal: AbortSignal): Promise<ConnectedRealtimeClient> => {
    const identity = await get(runtimeAuthenticatedIdentity$);
    signal.throwIfAborted();
    const createClient = get(apiClient$);
    const client = createClient(platformRealtimeTokenContract);
    const ably = createAblyRealtime({
      // Ably TokenRequest is single-use — see lib/ably-auth.ts for why
      // every invocation must fetch a freshly-signed request.
      authCallback: createAblyAuthCallback(client, signal),
      autoConnect: true,
      disconnectedRetryTimeout: 5000,
      suspendedRetryTimeout: 15_000,
    });
    publishConnectionDiagnostic({
      details: { connectionState: ably.connection.state },
      event: "realtime.client",
      phase: "instant",
    });
    const handleConnectionStateChange = (
      stateChange: ConnectionStateChange,
    ): void => {
      publishConnectionDiagnostic({
        details: connectionStateDetails(stateChange),
        event: "realtime.connection",
        phase: "instant",
      });
    };
    ably.connection.on(handleConnectionStateChange);

    let closed = false;
    const closeConnection = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      signal.removeEventListener("abort", closeConnection);
      ably.close();
      ably.connection.off(handleConnectionStateChange);
    };
    signal.addEventListener("abort", closeConnection, { once: true });

    const deferred = createDeferredPromise(signal);
    ably.connection.once("connected", () => {
      if (!deferred.settled()) {
        deferred.resolve(true);
      }
    });
    ably.connection.once("failed", (stateChange) => {
      if (!deferred.settled()) {
        deferred.reject(
          new Error(
            `Ably connection failed: ${stateChange?.reason?.message ?? "unknown"}`,
          ),
        );
      }
    });

    const initialConnectionSpanId = createConnectionDiagnosticSpanId();
    const initialConnectionStartedAtMs = now();
    publishConnectionDiagnostic({
      details: { connectionState: ably.connection.state },
      event: "realtime.initial-connection",
      phase: "start",
      spanId: initialConnectionSpanId,
    });
    const initialConnectionResult = await settle(deferred.promise, signal);
    if (!initialConnectionResult.ok) {
      publishConnectionDiagnostic({
        details: {
          ...connectionDiagnosticError(initialConnectionResult.error),
          connectionState: ably.connection.state,
        },
        durationMs: now() - initialConnectionStartedAtMs,
        event: "realtime.initial-connection",
        phase: "error",
        spanId: initialConnectionSpanId,
      });
      closeConnection();
      throw initialConnectionResult.error;
    }
    publishConnectionDiagnostic({
      details: { connectionState: ably.connection.state },
      durationMs: now() - initialConnectionStartedAtMs,
      event: "realtime.initial-connection",
      phase: "finish",
      spanId: initialConnectionSpanId,
    });

    const channels = connectedRealtimeChannels(
      ably,
      identity.userId,
      identity.orgId,
    );
    const stopObservingChannels = observeRealtimeChannels(channels);
    const close = (): void => {
      signal.removeEventListener("abort", close);
      closeConnection();
      stopObservingChannels();
    };
    // Own the observer before the first suspension point: cancelling during the
    // attach below must still detach these listeners.
    signal.removeEventListener("abort", closeConnection);
    signal.addEventListener("abort", close, { once: true });

    await attachRealtimeChannels(channels);
    signal.throwIfAborted();
    publishConnectionDiagnostic({
      details: { channelState: channels.user.state },
      event: "realtime.channel",
      phase: "instant",
    });
    return { ably, channels };
  },
);

/**
 * Initialize the Ably realtime client and its user and active-org channels.
 * Call once during app bootstrap, after Clerk auth is ready.
 */
export const setupRealtime$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (get(sharedWorkerRealtimeBridgeState$)) {
      return;
    }
    const rejectPendingSubscriptions = (reason?: unknown) => {
      const pendingSubscriptions = get(pendingAblySubscriptions$);
      if (pendingSubscriptions.length === 0) {
        return;
      }
      for (const pendingSubscription of pendingSubscriptions) {
        if (!pendingSubscription.channelDeferred.settled()) {
          pendingSubscription.channelDeferred.reject(reason);
        }
      }
      set(pendingAblySubscriptions$, []);
    };

    signal.addEventListener(
      "abort",
      () => {
        set(internalRealtimeSession$, null);
        rejectPendingSubscriptions(signal.reason);
      },
      { once: true },
    );

    const connected = await onRejection(
      set(connectRealtimeClient$, signal),
      rejectPendingSubscriptions,
    );
    signal.throwIfAborted();
    const channels: RealtimeSessionChannels = {
      credential: createRealtimeSubscriptionChannel(
        connected.channels.credential,
        signal,
      ),
      user: createRealtimeSubscriptionChannel(connected.channels.user, signal),
      org: createRealtimeSubscriptionChannel(connected.channels.org, signal),
    };
    set(internalRealtimeSession$, {
      ably: connected.ably,
      channels,
    });

    const pendingSubscriptions = get(pendingAblySubscriptions$);
    if (pendingSubscriptions.length > 0) {
      publishConnectionDiagnostic({
        details: { pendingSubscriberCount: pendingSubscriptions.length },
        event: "realtime.pending-subscribers",
        phase: "start",
      });
      L.debug(
        `Realtime connected, starting ${pendingSubscriptions.length} pending subscriber(s)`,
      );
      for (const pendingSubscription of pendingSubscriptions) {
        if (pendingSubscription.signal.aborted) {
          if (!pendingSubscription.channelDeferred.settled()) {
            pendingSubscription.channelDeferred.reject(
              pendingSubscription.signal.reason,
            );
          }
          continue;
        }
        if (!pendingSubscription.channelDeferred.settled()) {
          pendingSubscription.channelDeferred.resolve(
            channels[pendingSubscription.scope],
          );
        }
      }
      set(pendingAblySubscriptions$, []);
      publishConnectionDiagnostic({
        details: { pendingSubscriberCount: 0 },
        event: "realtime.pending-subscribers",
        phase: "finish",
      });
    }

    L.debug(`Realtime connected for user:${connected.ably.auth.clientId}`);
  },
);

const realtimeChannel$ = command(
  async (
    { get, set },
    scope: RealtimeChannelScope,
    topic: string | null,
    signal: AbortSignal,
  ): Promise<RealtimeSubscriptionChannel> => {
    signal.throwIfAborted();

    const sharedWorkerBridge = get(sharedWorkerRealtimeBridgeState$);
    if (sharedWorkerBridge) {
      return new SharedWorkerRealtimeChannel(sharedWorkerBridge, scope);
    }

    const session = get(internalRealtimeSession$);
    if (session) {
      return session.channels[scope];
    }

    const channelDeferred =
      createDeferredPromise<RealtimeSubscriptionChannel>(signal);
    const pendingSubscription: PendingAblySubscription = {
      scope,
      topic,
      signal,
      channelDeferred,
    };
    publishConnectionDiagnostic({
      details: {
        pendingSubscriberCount: get(pendingAblySubscriptions$).length + 1,
      },
      event: "realtime.pending-subscribers",
      phase: "instant",
    });
    set(pendingAblySubscriptions$, (prev) => {
      return [...prev, pendingSubscription];
    });

    const connectedChannel = await channelDeferred.promise;
    signal.throwIfAborted();
    return connectedChannel;
  },
);

export const setAblyLoop$ = command(
  async (
    { set },
    { scope = "user", topic, loopCommand$, options }: SetAblyLoopArgs,
    signal: AbortSignal,
  ) => {
    const channel = await set(realtimeChannel$, scope, topic, signal);
    signal.throwIfAborted();
    await set(
      runWithChannel$,
      {
        channel,
        topic,
        action: { kind: "command", command$: loopCommand$ },
        options,
      },
      signal,
    );
    signal.throwIfAborted();
  },
);

/** Run existing synchronous invalidation commands for every notification. */
export const setAblyInvalidationLoop$ = command(
  async (
    { set },
    {
      scope = "user",
      topic,
      invalidations,
      options,
    }: SetAblyInvalidationLoopArgs,
    signal: AbortSignal,
  ) => {
    const channel = await set(realtimeChannel$, scope, topic, signal);
    signal.throwIfAborted();
    await set(
      runWithChannel$,
      {
        channel,
        topic,
        action: { kind: "invalidate", invalidations },
        options,
      },
      signal,
    );
    signal.throwIfAborted();
  },
);

export const setAblyPayloadLoop$ = command(
  async (
    { set },
    {
      scope = "user",
      topic,
      loopCommand$,
      includeMessage,
      initializeCommand$,
      options,
    }: SetAblyPayloadLoopArgs,
    signal: AbortSignal,
  ) => {
    const channel = await set(realtimeChannel$, scope, topic, signal);
    signal.throwIfAborted();
    await set(
      runWithChannelPayload$,
      {
        channel,
        topic,
        loopCommand$,
        includeMessage,
        initializeCommand$,
        options,
      },
      signal,
    );
    signal.throwIfAborted();
  },
);
