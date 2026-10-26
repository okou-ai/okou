import { Realtime, type RealtimeChannel } from "ably";
import { number, object, string } from "zod";
import type { RealtimeSubscription } from "@okouai/api-contracts/contracts/realtime";

const tokenDetailsSchema = object({
  token: string().min(1),
  issued: number(),
  expires: number(),
  capability: string(),
  clientId: string().optional(),
});

async function redeemToken(
  tokenRequest: RealtimeSubscription["tokenRequest"],
  signal: AbortSignal,
) {
  const response = await fetch(
    `https://main.realtime.ably.net/keys/${encodeURIComponent(tokenRequest.keyName)}/requestToken`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(tokenRequest),
      redirect: "error",
      signal,
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Notification token exchange failed: HTTP ${response.status}`,
    );
  }
  const body: unknown = await response.json();
  signal.throwIfAborted();
  return tokenDetailsSchema.parse(body);
}

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
  // The SDK's TokenRequest redemption is independent of Realtime.close(). Own
  // that HTTP request before creating the connection so completion cancels it.
  const authorization = new AbortController();
  let ably: Realtime | undefined;
  let channel: RealtimeChannel | undefined;
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
      ably?.connection.state === "connected" && channel?.state === "attached";
    if (ably?.connection.state === "failed" || channel?.state === "failed") {
      stop();
      return;
    }
    if (active !== wasActive) notify();
  }

  function stop() {
    if (closed) return;
    closed = true;
    active = false;
    authorization.abort();
    clearTimeout(connectTimer);
    signal.removeEventListener("abort", stop);
    ably?.connection.off(updateTransport);
    channel?.off(updateTransport);
    channel?.unsubscribe(subscription.eventName, notify);
    stopConnecting();
    notify();
    ably?.close();
  }

  const connectTimer = setTimeout(stop, 10_000);
  signal.addEventListener("abort", stop, { once: true });
  const ready = (async () => {
    try {
      if (signal.aborted) {
        stop();
        return;
      }
      const tokenDetails = await redeemToken(
        subscription.tokenRequest,
        AbortSignal.any([signal, authorization.signal]),
      );
      if (closed) return;
      ably = new Realtime({
        authCallback: (_params, callback) => {
          callback(null, tokenDetails);
        },
        autoConnect: false,
        disconnectedRetryTimeout: 5000,
        suspendedRetryTimeout: 15_000,
      });
      channel = ably.channels.get(subscription.channelName);
      ably.connection.on(
        ["connected", "disconnected", "suspended", "failed"],
        updateTransport,
      );
      channel.on(
        ["attached", "detached", "suspended", "failed"],
        updateTransport,
      );
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
