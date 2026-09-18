import type { ApiTestMocks } from "../../../../__tests__/mocks";

/** One Ably publish paired with the channel it was actually routed to. */
interface PublishedChannelTopic {
  readonly channel: string;
  readonly topic: unknown;
}

/**
 * Every Ably publish paired with the channel it was routed to. The client mock
 * records `channels.get(name)` and the returned channel's `publish(topic)` on
 * two separate spies that every channel shares, so neither call array names a
 * channel on its own and pairing the two by position would only assume their
 * order. The channel is instead recovered from the last `get` whose global
 * invocation order precedes the publish. Every publisher in
 * `signals/external/realtime.ts` calls `channels.get(...)` and that channel's
 * `publish(...)` in one synchronous step with no await between them, so no
 * other `get` can interleave and the pairing is exact rather than assumed.
 */
function publishedChannelTopics(
  mocks: ApiTestMocks,
): readonly PublishedChannelTopic[] {
  const gets = mocks.ably.channelGet.mock;
  const publishes = mocks.ably.publish.mock;
  return publishes.calls.map((call, index) => {
    const publishedAt = publishes.invocationCallOrder[index] ?? 0;
    let channel = "";
    for (const [getIndex, order] of gets.invocationCallOrder.entries()) {
      if (order < publishedAt) {
        channel = String(gets.calls[getIndex]?.[0] ?? "");
      }
    }
    return { channel, topic: call[0] };
  });
}

/** The per-user-org channel `publishChatDatabaseSignalNow` routes to. */
export function userOrgChannelName(target: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  return `user-org:${target.userId}:${target.orgId}`;
}

/** Publications of one topic actually routed to one exact channel. */
export function countPublishedTo(
  mocks: ApiTestMocks,
  target: { readonly channel: string; readonly topic: string },
): number {
  return publishedChannelTopics(mocks).filter((published) => {
    return (
      published.channel === target.channel && published.topic === target.topic
    );
  }).length;
}

/** Every channel one topic reached, so a total can be asserted without
 * collapsing two owners into one sum. */
export function channelsPublishedTo(
  mocks: ApiTestMocks,
  topic: string,
): readonly string[] {
  return publishedChannelTopics(mocks)
    .filter((published) => {
      return published.topic === topic;
    })
    .map((published) => {
      return published.channel;
    });
}
