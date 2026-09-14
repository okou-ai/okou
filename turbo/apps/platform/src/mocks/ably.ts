// The current file still contains .cache and .zyn only because it is currently used for testing purposes,
// and there hasn't been time to adjust the paradigms within this file yet.
// In the long term, this file should also stop using .cache and .zyn.
// oxlint-disable promise/prefer-await-to-then
import { createDeferredPromise } from "../signals/utils.ts";

/**
 * Mock Ably module for tests.
 *
 * Each Realtime instance owns its connection and channel subscriptions so
 * tests can exercise replacement of a terminal client without the old client
 * clearing the new client's subscriptions when it closes.
 */

type Callback = (message: { name: string; data: unknown }) => void;
type ChatDatabaseEventListener = (message: {
  readonly name: string;
  readonly data: unknown;
}) => void;
type UserRealtimeEventListener = ChatDatabaseEventListener;
type NamedRealtimeEventListener = (
  channelName: string,
  message: { readonly name: string; readonly data: unknown },
) => void;

type AuthCallbackError = string | { message?: string } | null;
type AuthCallbackToken = unknown;
type AuthCallback = (
  params: unknown,
  cb: (error: AuthCallbackError, token: AuthCallbackToken) => void,
) => void;

interface MockErrorInfo {
  readonly code?: number;
  readonly message?: string;
  readonly statusCode?: number;
}

export type MockConnectionState =
  | "closed"
  | "closing"
  | "connected"
  | "connecting"
  | "disconnected"
  | "failed"
  | "initialized"
  | "suspended";

interface MockConnectionStateChange {
  readonly current: MockConnectionState;
  readonly previous: MockConnectionState;
  readonly reason?: MockErrorInfo;
  readonly retryIn?: number;
}

type ConnectionEventListener = (stateChange: MockConnectionStateChange) => void;
type ConnectionOn = {
  (callback: ConnectionEventListener): void;
  (event: string, callback: ConnectionEventListener): void;
};
type ConnectionOff = {
  (callback: ConnectionEventListener): void;
  (event: string, callback: ConnectionEventListener): void;
};
type MockChannelState =
  | "attached"
  | "attaching"
  | "detached"
  | "detaching"
  | "failed"
  | "initialized"
  | "suspended";
interface MockChannelStateChange {
  readonly current: MockChannelState;
  readonly previous: MockChannelState;
  readonly reason?: MockErrorInfo;
  /** Ably's continuity signal: false means the reattach could not replay. */
  readonly resumed: boolean;
}
type ChannelStateListener = (stateChange: MockChannelStateChange) => void;

/**
 * Ably rejects `channel.attach()` outright in these connection states rather
 * than queueing it, and the rejection leaves the channel where it was. Mirrors
 * `ConnectionManager.activeState()` and Ably's `INACTIVE_CONNECTION_STATES`.
 */
const INACTIVE_MOCK_CONNECTION_STATES: ReadonlySet<MockConnectionState> =
  new Set(["suspended", "closing", "closed", "failed"]);

/** The error Ably surfaces from `ConnectionManager.getError()` on attach. */
const MOCK_UNREACHABLE_MESSAGE = "Unable to connect (network unreachable)";

let capturedAuthCallback: AuthCallback | null = null;
let tokenBodies: AuthCallbackToken[] = [];
let nextSubscribeError: Error | null = null;
interface SubscribeGate {
  readonly started: ReturnType<typeof createDeferredPromise<void>>;
  readonly release: ReturnType<typeof createDeferredPromise<void>>;
}
let nextSubscribeGate: SubscribeGate | null = null;
const channelSubscribeGates = new Map<string, SubscribeGate>();
const realtimeInstances = new Set<Realtime>();
const chatDatabaseEventListeners = new Set<ChatDatabaseEventListener>();
const userRealtimeEventListeners = new Set<UserRealtimeEventListener>();
const namedRealtimeEventListeners = new Set<NamedRealtimeEventListener>();
const directRealtimeSubscriptions = new Map<string, Map<string, number>>();
const subscribeErrors = new Map<
  string,
  {
    readonly error: Error;
    readonly observed: ReturnType<typeof createDeferredPromise<void>>;
  }
>();

function invokeAuthCallback(
  cb: AuthCallback,
  signal: AbortSignal = AbortSignal.any([]),
): Promise<AuthCallbackToken> {
  const deferred = createDeferredPromise<AuthCallbackToken>(signal);
  cb({}, (error, token) => {
    if (deferred.settled()) {
      return;
    }
    if (error) {
      const message =
        typeof error === "string" ? error : (error.message ?? "auth error");
      deferred.reject(new Error(message));
      return;
    }
    tokenBodies.push(token);
    deferred.resolve(token);
  });
  return deferred.promise;
}

class FakeChannel {
  readonly subscriptions = new Map<string, Set<Callback>>();
  readonly channelSubscriptions = new Set<Callback>();
  state: MockChannelState = "initialized";
  attachOnSubscribe = true;
  private readonly stateListeners = new Set<ChannelStateListener>();

  constructor(
    private readonly connectionState: () => MockConnectionState,
    private readonly name: string,
  ) {}

  trigger(topic: string, data?: unknown): void {
    const message = { name: topic, data };
    const callbacks = this.subscriptions.get(topic);
    if (callbacks) {
      for (const callback of callbacks) {
        callback(message);
      }
    }
    for (const callback of this.channelSubscriptions) {
      callback(message);
    }
  }

  hasSubscription(topic: string): boolean {
    return (this.subscriptions.get(topic)?.size ?? 0) > 0;
  }

  hasChannelSubscription(): boolean {
    return this.channelSubscriptions.size > 0;
  }

  clear(): void {
    this.subscriptions.clear();
    this.channelSubscriptions.clear();
    this.transition("detached");
  }

  detach(): Promise<void> {
    this.transition("detached");
    return Promise.resolve();
  }

  fail(reason: MockErrorInfo): void {
    this.subscriptions.clear();
    this.channelSubscriptions.clear();
    this.transition("failed", reason);
  }

  suspend(reason: MockErrorInfo): void {
    this.transition("suspended", reason);
  }

  /**
   * Reattach after a drop. Ably discards channel state on suspension, so this
   * reattach reports `resumed: false`; use `resume()` for a short interruption
   * that Ably was able to replay.
   */
  reconnect(): void {
    if (this.state !== "suspended") {
      return;
    }
    this.transition("attaching");
    this.transition("attached");
  }

  /** Reattach with continuity preserved, as after a brief disconnect. */
  resume(): void {
    if (this.state === "attached") {
      this.transition("attached", undefined, true);
      return;
    }
    this.transition("attaching");
    this.transition("attached", undefined, true);
  }

  on(callback: ChannelStateListener): void {
    this.stateListeners.add(callback);
  }

  off(callback: ChannelStateListener): void {
    this.stateListeners.delete(callback);
  }

  private transition(
    state: MockChannelState,
    reason?: MockErrorInfo,
    resumed = false,
  ): void {
    const previous = this.state;
    this.state = state;
    const stateChange = { current: state, previous, reason, resumed };
    for (const listener of this.stateListeners) {
      listener(stateChange);
    }
  }

  /**
   * Mirror real Ably: subscribe registers the callback synchronously, and only
   * attaches as a side effect when `attachOnSubscribe` is left at its default.
   */
  async subscribe(
    topicOrCallback: string | Callback,
    callback?: Callback,
  ): Promise<void> {
    if (this.state === "failed") {
      throw new Error(
        `Channel operation failed as channel state is ${this.state}`,
      );
    }
    if (typeof topicOrCallback === "function") {
      this.channelSubscriptions.add(topicOrCallback);
    } else if (callback) {
      let callbacks = this.subscriptions.get(topicOrCallback);
      if (!callbacks) {
        callbacks = new Set();
        this.subscriptions.set(topicOrCallback, callbacks);
      }
      callbacks.add(callback);
    }

    const gateKey = JSON.stringify([this.name, topicOrCallback]);
    const subscribeGate =
      channelSubscribeGates.get(gateKey) ?? nextSubscribeGate;
    if (channelSubscribeGates.has(gateKey)) {
      channelSubscribeGates.delete(gateKey);
    } else {
      nextSubscribeGate = null;
    }
    await Promise.resolve();
    if (subscribeGate) {
      subscribeGate.started.resolve(undefined);
      await subscribeGate.release.promise;
    }
    if (typeof topicOrCallback === "string") {
      const failure = subscribeErrors.get(topicOrCallback);
      if (failure) {
        subscribeErrors.delete(topicOrCallback);
        failure.observed.resolve();
        throw failure.error;
      }
    }
    if (nextSubscribeError) {
      const error = nextSubscribeError;
      nextSubscribeError = null;
      throw error;
    }
    if (this.attachOnSubscribe) {
      await this.attach();
    }
  }

  /**
   * Mirror `RealtimeChannel._attach()`: an inactive connection rejects the
   * attach before the channel ever reaches `attaching`, so a channel that has
   * never attached stays outside the set Ably reattaches on reconnect.
   */
  async attach(): Promise<void> {
    await Promise.resolve();
    if (this.state === "attached") {
      return;
    }
    if (INACTIVE_MOCK_CONNECTION_STATES.has(this.connectionState())) {
      throw new Error(MOCK_UNREACHABLE_MESSAGE);
    }
    this.transition("attaching");
    this.transition("attached");
  }

  unsubscribe(topicOrCallback: string | Callback, callback?: Callback): void {
    if (typeof topicOrCallback === "function") {
      this.channelSubscriptions.delete(topicOrCallback);
      return;
    }
    if (callback) {
      this.subscriptions.get(topicOrCallback)?.delete(callback);
    }
  }
}

export class Realtime {
  readonly auth = { clientId: "test-user-123" };
  readonly channel: FakeChannel;
  readonly connection: {
    state: MockConnectionState;
    once: (event: string, callback: ConnectionEventListener) => void;
    on: ConnectionOn;
    off: ConnectionOff;
  };
  readonly channels: {
    release: (name: string) => void;
    get: (
      _name: string,
      options?: { attachOnSubscribe?: boolean },
    ) => FakeChannel;
  };

  private readonly channelsByName = new Map<string, FakeChannel>();
  private readonly authController = new AbortController();

  private readonly connectedOnceListeners = new Set<ConnectionEventListener>();
  private readonly failedOnceListeners = new Set<ConnectionEventListener>();
  private readonly connectedListeners = new Set<ConnectionEventListener>();
  private readonly stateListeners = new Set<ConnectionEventListener>();

  constructor(config?: { authCallback?: AuthCallback }) {
    const on = (
      eventOrCallback: string | ConnectionEventListener,
      callback?: ConnectionEventListener,
    ): void => {
      if (typeof eventOrCallback === "function") {
        this.stateListeners.add(eventOrCallback);
        return;
      }
      if (eventOrCallback === "connected" && callback) {
        this.connectedListeners.add(callback);
      }
    };
    const off = (
      eventOrCallback: string | ConnectionEventListener,
      callback?: ConnectionEventListener,
    ): void => {
      if (typeof eventOrCallback === "function") {
        this.stateListeners.delete(eventOrCallback);
        return;
      }
      if (eventOrCallback === "connected" && callback) {
        this.connectedListeners.delete(callback);
      }
    };
    this.connection = {
      state: "connecting",
      once: (event, callback) => {
        if (event === "connected") {
          if (this.connection.state === "connected") {
            queueMicrotask(() => {
              callback({ current: "connected", previous: "connected" });
            });
          } else {
            this.connectedOnceListeners.add(callback);
          }
          return;
        }
        if (event === "failed") {
          if (this.connection.state === "failed") {
            queueMicrotask(() => {
              callback({
                current: "failed",
                previous: "failed",
                reason: { message: "connection failed" },
              });
            });
          } else {
            this.failedOnceListeners.add(callback);
          }
        }
      },
      on,
      off,
    };
    this.channel = this.getChannel("user:test-user-123");
    this.channels = {
      release: (name) => {
        this.channelsByName.delete(name);
      },
      get: (name, options) => {
        const channel = this.getChannel(name);
        if (options?.attachOnSubscribe !== undefined) {
          channel.attachOnSubscribe = options.attachOnSubscribe;
        }
        return channel;
      },
    };
    realtimeInstances.add(this);

    if (config?.authCallback) {
      capturedAuthCallback = config.authCallback;
      invokeAuthCallback(config.authCallback, this.authController.signal)
        .then(() => {
          this.connect();
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.fail(message);
        });
      return;
    }
    queueMicrotask(() => {
      this.connect();
    });
  }

  close(): void {
    if (this.connection.state === "closed") {
      return;
    }
    this.authController.abort(
      new DOMException("Ably client closed", "AbortError"),
    );
    this.transition("closing");
    for (const channel of this.channelsByName.values()) {
      channel.clear();
    }
    this.transition("closed");
    this.connectedOnceListeners.clear();
    this.failedOnceListeners.clear();
    this.connectedListeners.clear();
    this.stateListeners.clear();
    realtimeInstances.delete(this);
  }

  fail(message: string): void {
    if (this.connection.state === "closed") {
      return;
    }
    const reason = { message };
    for (const channel of this.channelsByName.values()) {
      channel.fail(reason);
    }
    this.transition("failed", reason);
  }

  reconnect(): void {
    if (this.connection.state === "closed") {
      return;
    }
    for (const channel of this.channelsByName.values()) {
      channel.reconnect();
    }
    this.transition("connected");
  }

  transitionTo(
    state: "connected" | "disconnected" | "suspended",
    reason: MockErrorInfo = {},
    retryIn?: number,
  ): void {
    if (this.connection.state === "closed") {
      return;
    }
    if (state === "suspended") {
      for (const channel of this.channelsByName.values()) {
        channel.suspend(reason);
      }
    } else if (state === "connected") {
      for (const channel of this.channelsByName.values()) {
        channel.reconnect();
      }
    }
    this.transition(state, reason, retryIn);
  }

  private connect(): void {
    if (this.connection.state === "closed") {
      return;
    }
    this.transition("connected");
  }

  getExistingChannel(name: string): FakeChannel | undefined {
    return this.channelsByName.get(name);
  }

  allChannels(): Iterable<FakeChannel> {
    return this.channelsByName.values();
  }

  namedChannels(): Iterable<readonly [string, FakeChannel]> {
    return this.channelsByName.entries();
  }

  private getChannel(name: string): FakeChannel {
    const existing = this.channelsByName.get(name);
    if (existing) {
      return existing;
    }
    const channel = new FakeChannel(() => {
      return this.connection.state;
    }, name);
    this.channelsByName.set(name, channel);
    return channel;
  }

  private transition(
    state: MockConnectionState,
    reason?: MockErrorInfo,
    retryIn?: number,
  ): void {
    const previous = this.connection.state;
    this.connection.state = state;
    const stateChange = { current: state, previous, reason, retryIn };
    for (const listener of this.stateListeners) {
      listener(stateChange);
    }
    if (state === "connected") {
      for (const listener of this.connectedOnceListeners) {
        listener(stateChange);
      }
      this.connectedOnceListeners.clear();
      for (const listener of this.connectedListeners) {
        listener(stateChange);
      }
    }
    if (state === "failed") {
      for (const listener of this.failedOnceListeners) {
        listener(stateChange);
      }
      this.failedOnceListeners.clear();
    }
  }
}

export { Realtime as BaseRealtime };
export const FetchRequest = Symbol("FetchRequest");
export const WebSocketTransport = Symbol("WebSocketTransport");
export const XHRPolling = Symbol("XHRPolling");

function isSharedDatabaseRealtimeTopic(topic: string): boolean {
  return (
    topic === "morningBriefChanged" ||
    topic === "chatThreadReadCursorUpdated" ||
    topic === "threadListChanged" ||
    topic.startsWith("chatThreadMessageCreated:")
  );
}

/** Fire a server-side publish using the production topic-to-channel routing. */
export function triggerAblyEvent(topic: string, data?: unknown): void {
  const message = { name: topic, data };
  for (const listener of userRealtimeEventListeners) {
    listener(message);
  }
  if (isSharedDatabaseRealtimeTopic(topic)) {
    triggerChatDatabaseEvent(topic, data);
    return;
  }
  for (const realtime of realtimeInstances) {
    if (realtime.connection.state === "connected") {
      for (const [channelName, channel] of realtime.namedChannels()) {
        if (channelName.startsWith("user:")) {
          channel.trigger(topic, data);
        }
      }
    }
  }
}

/** Fire a chat-database publish on every connected user-org channel. */
export function triggerChatDatabaseEvent(topic: string, data?: unknown): void {
  const message = { name: topic, data };
  for (const listener of chatDatabaseEventListeners) {
    listener(message);
  }
  for (const realtime of realtimeInstances) {
    if (realtime.connection.state === "connected") {
      for (const [channelName, channel] of realtime.namedChannels()) {
        if (channelName.startsWith("user-org:")) {
          channel.trigger(topic, data);
        }
      }
    }
  }
}

/** Forward mock chat-database publishes to a direct worker test host. */
export function subscribeChatDatabaseEvents(
  listener: ChatDatabaseEventListener,
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  chatDatabaseEventListeners.add(listener);
  signal.addEventListener(
    "abort",
    () => {
      chatDatabaseEventListeners.delete(listener);
    },
    { once: true },
  );
}

/** Forward mock user-channel publishes to a direct worker test host. */
export function subscribeUserRealtimeEvents(
  listener: UserRealtimeEventListener,
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  userRealtimeEventListeners.add(listener);
  signal.addEventListener(
    "abort",
    () => {
      userRealtimeEventListeners.delete(listener);
    },
    { once: true },
  );
}

/** Fire a server-side publish on one named channel. */
export function triggerAblyChannelEvent(
  channelName: string,
  topic: string,
  data?: unknown,
): void {
  const message = { name: topic, data };
  for (const listener of namedRealtimeEventListeners) {
    listener(channelName, message);
  }
  for (const realtime of realtimeInstances) {
    if (realtime.connection.state === "connected") {
      realtime.getExistingChannel(channelName)?.trigger(topic, data);
    }
  }
}

/** Forward named-channel publishes to a direct worker test host. */
export function subscribeNamedRealtimeEvents(
  listener: NamedRealtimeEventListener,
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  namedRealtimeEventListeners.add(listener);
  signal.addEventListener(
    "abort",
    () => {
      namedRealtimeEventListeners.delete(listener);
    },
    { once: true },
  );
}

/** Re-invoke the newest client's auth callback to simulate token renewal. */
export function triggerAblyReauth(): Promise<AuthCallbackToken> {
  if (!capturedAuthCallback) {
    throw new Error("triggerAblyReauth called before Realtime was constructed");
  }
  return invokeAuthCallback(capturedAuthCallback);
}

/** Token bodies returned by every successful auth callback invocation. */
export function getAuthTokenHistory(): readonly AuthCallbackToken[] {
  return tokenBodies;
}

/**
 * Reattach every channel with continuity preserved, as Ably does after a brief
 * disconnect it could replay. Subscribers must not re-read their baseline.
 */
export function triggerAblyResume(): void {
  for (const realtime of realtimeInstances) {
    if (realtime.connection.state === "closed") {
      continue;
    }
    for (const channel of realtime.allChannels()) {
      channel.resume();
    }
  }
}

/** Fire a reconnect event on every connected Realtime instance. */
export function triggerAblyReconnect(): void {
  for (const realtime of realtimeInstances) {
    realtime.reconnect();
  }
}

function requireSharedWorkerRealtime(): Realtime {
  for (const realtime of realtimeInstances) {
    if (realtime.connection.state === "closed") {
      continue;
    }
    const ownsSharedDatabaseEvents = [...realtime.namedChannels()].some(
      ([channelName, channel]) => {
        return (
          channelName.startsWith("user-org:") &&
          channel.hasChannelSubscription()
        );
      },
    );
    if (ownsSharedDatabaseEvents) {
      return realtime;
    }
  }
  throw new Error(
    "SharedWorker Ably action triggered before its database subscription",
  );
}

/** Reconnect only the Realtime client that owns SharedWorker database events. */
export function triggerSharedWorkerAblyReconnect(): void {
  requireSharedWorkerRealtime().reconnect();
}

/** Transition only the Realtime client that owns SharedWorker database events. */
export function triggerSharedWorkerAblyConnectionState(
  state: "connected" | "disconnected" | "suspended",
  options: {
    readonly code?: number;
    readonly message?: string;
    readonly retryIn?: number;
    readonly statusCode?: number;
  } = {},
): void {
  requireSharedWorkerRealtime().transitionTo(
    state,
    {
      code: options.code,
      message: options.message,
      statusCode: options.statusCode,
    },
    options.retryIn,
  );
}

/** Fail only the Realtime client that owns SharedWorker database events. */
export function triggerSharedWorkerAblyFailure(
  message = "connection failed",
): void {
  requireSharedWorkerRealtime().fail(message);
}

export function triggerAblyConnectionState(
  state: "connected" | "disconnected" | "suspended",
  options: {
    readonly channelName?: string;
    readonly code?: number;
    readonly message?: string;
    readonly retryIn?: number;
    readonly statusCode?: number;
  } = {},
): void {
  let activeRealtime: Realtime | null = null;
  for (const realtime of realtimeInstances) {
    if (realtime.connection.state === "closed") {
      continue;
    }
    if (options.channelName) {
      const channel = realtime.getExistingChannel(options.channelName);
      if (!channel || channel.state === "initialized") {
        continue;
      }
      activeRealtime = realtime;
      break;
    }
    activeRealtime = realtime;
  }
  activeRealtime?.transitionTo(
    state,
    {
      code: options.code,
      message: options.message,
      statusCode: options.statusCode,
    },
    options.retryIn,
  );
}

/**
 * Put the newest live client into Ably's terminal failed state. Connected
 * clients win, so existing callers keep selecting the same client; a suspended
 * client is still eligible, because Ably reaches `failed` from there too.
 */
export function triggerAblyFailure(message = "connection failed"): void {
  let connectedRealtime: Realtime | null = null;
  let liveRealtime: Realtime | null = null;
  for (const realtime of realtimeInstances) {
    if (realtime.connection.state === "connected") {
      connectedRealtime = realtime;
    }
    if (realtime.connection.state !== "closed") {
      liveRealtime = realtime;
    }
  }
  (connectedRealtime ?? liveRealtime)?.fail(message);
}

/** Close every active client, including its channel subscriptions. */
export function triggerAblyConnectionClosed(): void {
  for (const realtime of realtimeInstances) {
    realtime.close();
  }
}

export function rejectNextAblySubscribe(message: string): void {
  nextSubscribeError = new Error(message);
}

export function deferNextAblySubscribe(signal: AbortSignal): {
  readonly started: Promise<void>;
  readonly attach: () => void;
} {
  if (nextSubscribeGate) {
    throw new Error("An Ably subscribe is already deferred");
  }
  const started = createDeferredPromise<void>(signal);
  const release = createDeferredPromise<void>(signal);
  nextSubscribeGate = { started, release };
  return {
    started: started.promise,
    attach: () => {
      release.resolve(undefined);
    },
  };
}

export function rejectAblySubscribe(
  topic: string,
  message: string,
  signal: AbortSignal,
): Promise<void> {
  const observed = createDeferredPromise<void>(signal);
  subscribeErrors.set(topic, { error: new Error(message), observed });
  return observed.promise;
}

/** Delay one external channel/topic registration without blocking other scopes. */
export function deferAblySubscribeOnChannel(
  channelName: string,
  topic: string,
  signal: AbortSignal,
): {
  readonly started: Promise<void>;
  readonly attach: () => void;
  readonly fail: (error: Error) => void;
} {
  const key = JSON.stringify([channelName, topic]);
  if (channelSubscribeGates.has(key)) {
    throw new Error("This Ably subscription is already deferred");
  }
  const started = createDeferredPromise<void>(signal);
  const release = createDeferredPromise<void>(signal);
  channelSubscribeGates.set(key, { started, release });
  return {
    started: started.promise,
    attach: () => {
      release.resolve();
    },
    fail: (error) => {
      release.reject(error);
    },
  };
}

/** Track a topic subscribed through the in-process direct worker bridge. */
export function registerDirectRealtimeSubscription(
  channelName: string,
  topic: string,
): () => void {
  let topics = directRealtimeSubscriptions.get(channelName);
  if (!topics) {
    topics = new Map();
    directRealtimeSubscriptions.set(channelName, topics);
  }
  topics.set(topic, (topics.get(topic) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const currentTopics = directRealtimeSubscriptions.get(channelName);
    const count = currentTopics?.get(topic);
    if (!currentTopics || count === undefined) {
      return;
    }
    if (count > 1) {
      currentTopics.set(topic, count - 1);
      return;
    }
    currentTopics.delete(topic);
    if (currentTopics.size === 0) {
      directRealtimeSubscriptions.delete(channelName);
    }
  };
}

/** Debug: check if a topic has an active transport subscription. */
export function hasSubscription(topic: string): boolean {
  for (const topics of directRealtimeSubscriptions.values()) {
    if ((topics.get(topic) ?? 0) > 0) {
      return true;
    }
  }
  for (const realtime of realtimeInstances) {
    for (const channel of realtime.allChannels()) {
      if (channel.hasSubscription(topic)) {
        return true;
      }
    }
  }
  return false;
}

export function hasSubscriptionOnChannel(
  channelName: string,
  topic: string,
): boolean {
  if ((directRealtimeSubscriptions.get(channelName)?.get(topic) ?? 0) > 0) {
    return true;
  }
  for (const realtime of realtimeInstances) {
    if (realtime.getExistingChannel(channelName)?.hasSubscription(topic)) {
      return true;
    }
  }
  return false;
}

export function hasRealtimeChannel(channelName: string): boolean {
  return [...realtimeInstances].some((realtime) => {
    return realtime.getExistingChannel(channelName) !== undefined;
  });
}

/** Debug: check if a user channel has an active catch-all subscription. */
export function hasChannelSubscription(): boolean {
  for (const realtime of realtimeInstances) {
    for (const channel of realtime.allChannels()) {
      if (channel.hasChannelSubscription()) {
        return true;
      }
    }
  }
  return false;
}

export function hasChannelSubscriptionOnChannel(channelName: string): boolean {
  for (const realtime of realtimeInstances) {
    if (
      realtime.connection.state === "connected" &&
      realtime.getExistingChannel(channelName)?.hasChannelSubscription() ===
        true
    ) {
      return true;
    }
  }
  return false;
}

/** Whether the test Shared Database bridge can receive server publishes. */
export function hasSharedDatabaseSubscription(): boolean {
  return chatDatabaseEventListeners.size > 0;
}

/** Reset all subscriptions and captured auth state between tests. */
export function resetAblySubscriptions(): void {
  triggerAblyConnectionClosed();
  chatDatabaseEventListeners.clear();
  userRealtimeEventListeners.clear();
  namedRealtimeEventListeners.clear();
  directRealtimeSubscriptions.clear();
  capturedAuthCallback = null;
  tokenBodies = [];
  nextSubscribeError = null;
  nextSubscribeGate = null;
  channelSubscribeGates.clear();
  subscribeErrors.clear();
}

export type RealtimeChannel = FakeChannel;
export type InboundMessage = { name: string; data: unknown };
