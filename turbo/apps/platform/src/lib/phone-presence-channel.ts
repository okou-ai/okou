import type {
  RealtimeChannel,
  ChannelStateChange,
  PresenceMessage,
} from "ably";
import { phoneUseChannel } from "@okouai/api-contracts/validators/phone-use";
import { now } from "./time.ts";
import { createDeadline, detach, Reason } from "../signals/utils.ts";
import type { AblyRealtime } from "./ably-realtime.ts";

type Callback = (message: { name: string | null; data: unknown }) => void;

function createPresenceObserver(
  userId: string,
  topic: string,
  callback: Callback,
  onResync: () => void,
  signal: AbortSignal,
) {
  const expiry = createDeadline(signal);
  const invalidate = () => {
    if (!signal.aborted) {
      callback({ name: topic, data: null });
    }
  };
  const armExpiry = (message: PresenceMessage) => {
    expiry.cancel();
    // Readiness renewals update the deadline without another HTTP list read.
    const data: unknown = message.data;
    const until =
      typeof data === "object" &&
      data !== null &&
      "readyUntil" in data &&
      typeof data.readyUntil === "string"
        ? Date.parse(data.readyUntil)
        : Number.NaN;
    if (Number.isFinite(until)) {
      expiry.schedule(invalidate, Math.max(0, until - now()));
    }
  };
  const receive = (message: PresenceMessage) => {
    if (signal.aborted || message.clientId !== userId) {
      return;
    }
    if (message.action !== "leave" && message.action !== "absent") {
      armExpiry(message);
    } else {
      expiry.cancel();
    }
    if (message.action !== "update") {
      invalidate();
    }
  };
  const changed = (change: ChannelStateChange) => {
    if (!signal.aborted && change.current === "attached" && !change.resumed) {
      onResync();
    }
  };
  return { receive, changed, armExpiry, cancel: expiry.cancel };
}

/** Read-only device presence; browser connections must never enter this channel. */
export function createPhonePresenceChannel(
  ably: AblyRealtime,
  identity: { userId: string; orgId: string },
  waitForAttachment: (
    channel: RealtimeChannel,
    signal: AbortSignal,
  ) => Promise<void>,
) {
  const subscriptions = new Map<Callback, () => Promise<void>>();
  const entries = new Map<
    string,
    { channel: RealtimeChannel; count: number; detaching?: Promise<void> }
  >();
  return {
    async subscribe(
      topic: string | null,
      callback: Callback,
      onResync: () => void,
      signal: AbortSignal,
    ) {
      if (!topic) {
        throw new Error("Phone presence requires a device generation");
      }
      const [id, generation] = topic.split(":");
      if (!id || !generation) {
        throw new Error("Invalid phone presence identity");
      }
      const name = phoneUseChannel(
        identity.orgId,
        identity.userId,
        id,
        Number(generation),
      );
      let entry = entries.get(name);
      if (!entry) {
        entry = {
          channel: ably.channels.get(name, { attachOnSubscribe: false }),
          count: 0,
        };
        entries.set(name, entry);
      }
      entry.count += 1;
      const current = entry;
      const channel = entry.channel;
      const observer = createPresenceObserver(
        identity.userId,
        topic,
        callback,
        onResync,
        signal,
      );
      // Keep listeners while suspended; Ably owns reattachment after the first attach.
      const attachWhenConnected = () => {
        if (
          !signal.aborted &&
          ably.connection.state === "connected" &&
          (channel.state === "initialized" || channel.state === "detached")
        ) {
          detach(channel.attach(), Reason.Daemon, "phone presence attachment");
        }
      };
      const cleanup = async () => {
        observer.cancel();
        ably.connection.off(attachWhenConnected);
        channel.presence.unsubscribe(observer.receive);
        channel.off(observer.changed);
        current.count -= 1;
        if (current.count > 0) {
          return;
        }
        current.detaching = channel.detach();
        await current.detaching.finally(() => {
          current.detaching = undefined;
        });
        if (current.count === 0 && entries.get(name) === current) {
          ably.channels.release(name);
          entries.delete(name);
        }
      };
      subscriptions.set(callback, cleanup);
      await current.detaching;
      signal.throwIfAborted();
      channel.on(observer.changed);
      await channel.presence.subscribe(observer.receive);
      signal.throwIfAborted();
      ably.connection.on(attachWhenConnected);
      attachWhenConnected();
      await waitForAttachment(channel, signal);
      signal.throwIfAborted();
      const members = await channel.presence.get();
      signal.throwIfAborted();
      for (const member of members) {
        if (member.clientId === identity.userId) {
          observer.armExpiry(member);
        }
      }
    },
    async unsubscribe(_topic: string | null, callback: Callback) {
      const cleanup = subscriptions.get(callback);
      subscriptions.delete(callback);
      await cleanup?.();
    },
  };
}
