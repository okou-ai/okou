import { Realtime, type AuthOptions } from "ably";
import type { RealtimeSubscription } from "@okouai/api-contracts/contracts/realtime";

export interface RealtimeNotifier {
  readonly active: boolean;
  readonly closed: boolean;
  readonly ready: Promise<void>;
  wait(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

/** Notifications invalidate HTTP state; connection setup never suspends reads. */
export function createRealtimeNotifier(
  subscription: RealtimeSubscription,
  signal: AbortSignal,
): RealtimeNotifier {
  const authCallback: NonNullable<AuthOptions["authCallback"]> = (
    _params,
    callback,
  ) => {
    callback(null, subscription.tokenRequest);
  };
  const ably = new Realtime({
    authCallback,
    autoConnect: false,
    disconnectedRetryTimeout: 5000,
    suspendedRetryTimeout: 15_000,
  });
  const channel = ably.channels.get(subscription.channelName);
  let closed = false;
  let active = false;
  let pendingEvent = false;
  let wake: (() => void) | undefined;
  let stopConnecting: () => void = () => {
    return undefined;
  };
  const stopped = new Promise<void>((resolve) => {
    stopConnecting = resolve;
  });

  function notify() {
    pendingEvent = true;
    wake?.();
  }

  function updateTransport() {
    if (closed) return;
    const wasActive = active;
    active =
      ably.connection.state === "connected" && channel.state === "attached";
    if (ably.connection.state === "failed" || channel.state === "failed") {
      stop();
      return;
    }
    if (active !== wasActive) notify();
  }

  function stop() {
    if (closed) return;
    closed = true;
    active = false;
    clearTimeout(connectTimer);
    signal.removeEventListener("abort", stop);
    ably.connection.off(updateTransport);
    channel.off(updateTransport);
    channel.unsubscribe(subscription.eventName, notify);
    stopConnecting();
    notify();
    ably.close();
  }

  ably.connection.on(
    ["connected", "disconnected", "suspended", "failed"],
    updateTransport,
  );
  channel.on(["attached", "detached", "suspended", "failed"], updateTransport);
  const connectTimer = setTimeout(stop, 10_000);
  signal.addEventListener("abort", stop, { once: true });
  const ready = (async () => {
    try {
      if (signal.aborted) {
        stop();
        return;
      }
      ably.connect();
      await Promise.race([
        channel.subscribe(subscription.eventName, notify),
        stopped,
      ]);
      if (closed) return;
      clearTimeout(connectTimer);
      updateTransport();
    } catch {
      // External connection/auth failure leaves HTTP result reads available.
      stop();
    }
  })();

  return {
    get active() {
      return active;
    },
    get closed() {
      return closed;
    },
    ready,
    wait(timeoutMs: number): Promise<void> {
      if (pendingEvent || closed || timeoutMs <= 0) {
        pendingEvent = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          pendingEvent = false;
          if (wake === done) wake = undefined;
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        wake = done;
      });
    },
    async close() {
      stop();
      await ready;
    },
  };
}
