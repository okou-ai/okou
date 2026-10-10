import { revokedChatEventIds } from "@okouai/api-contracts/contracts/chat-events";
import {
  discordGatewayContract,
  type DiscordGatewayEnvelope,
} from "@okouai/api-contracts/contracts/discord-gateway";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { discordGatewayRoutes } from "../discord-gateway";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import {
  discordChatThreads,
  discordMessageForTest,
  DISCORD_TEST_APPLICATION_ID,
  DISCORD_TEST_GATEWAY_SECRET,
  mockDiscordProvider,
  postDiscordMessage,
  setupConnectedDiscordActor,
  type ConnectedDiscordActor,
} from "./helpers/discord-fixture";
import {
  mockDiscordMemberships,
  removePublicDiscordBinding,
  uniqueDiscordSnowflake,
} from "./helpers/discord";
import { deleteFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createFixtureTracker } from "./helpers/route-test";

const context = testContext();
const track = createFixtureTracker<ConnectedDiscordActor>(async (actor) => {
  mockDiscordMemberships(context, [actor]);
  await removePublicDiscordBinding(context, actor.fixture);
  await deleteFeatureSwitchesForUser(context, actor);
});

afterEach(async () => {
  await flushWaitUntilForTest();
});

async function currentInputs(threadId: string) {
  const events = await readProjectedChatEvents(context, {
    threadId,
    headers: { authorization: "Bearer clerk-session" },
  });
  const revokedIds = revokedChatEventIds(events);
  return events.filter((event) => {
    return event.eventType === "input.prompt" && !revokedIds.has(event.id);
  });
}

describe("Discord Gateway message identity", () => {
  it.each(["author", "channel", "guild"] as const)(
    "rejects a signed replay with changed %s identity and preserves the original input",
    async (field) => {
      const actor = await track(setupConnectedDiscordActor(context));
      const provider = mockDiscordProvider(actor);
      const original = discordMessageForTest(actor, {
        channelId: provider.guildChannelId,
        content: `<@${actor.botUserId}> keep the admitted message identity`,
      });
      provider.messages.set(original.id, original);
      expect((await postDiscordMessage(context, original)).body.outcome).toBe(
        "accepted",
      );
      await flushWaitUntilForTest();
      const [thread] = await discordChatThreads(context, actor);
      if (!thread) {
        throw new Error("Expected the original Discord conversation");
      }
      const before = await currentInputs(thread.id);
      expect(before).toHaveLength(1);
      const changedId = uniqueDiscordSnowflake();
      const payload = {
        ...original,
        ...(field === "author" && {
          author: { ...original.author, id: changedId },
        }),
        ...(field === "channel" && { channel_id: changedId }),
        ...(field === "guild" && { guild_id: changedId }),
      };
      const envelope: DiscordGatewayEnvelope = {
        version: 1,
        applicationId: DISCORD_TEST_APPLICATION_ID,
        eventType: "MESSAGE_CREATE",
        eventId: `identity-replay:${original.id}`,
        payload,
      };
      const timestamp = Math.floor(now() / 1000).toString();
      const signature = createHmac("sha256", DISCORD_TEST_GATEWAY_SECRET)
        .update(`${timestamp}.${JSON.stringify(envelope)}`)
        .digest("hex");
      const rejected = await accept(
        setupApp({ context, routes: discordGatewayRoutes })(
          discordGatewayContract,
        ).post({
          headers: {
            "x-discord-gateway-timestamp": timestamp,
            "x-discord-gateway-signature": signature,
          },
          body: envelope,
        }),
        [400],
      );
      expect(rejected.body).toStrictEqual({
        error: { code: "BAD_REQUEST", message: "Message identity changed" },
      });
      expect(
        (await postDiscordMessage(context, original, `original:${original.id}`))
          .body.outcome,
      ).toBe("duplicate");
      await flushWaitUntilForTest();
      await expect(discordChatThreads(context, actor)).resolves.toMatchObject([
        { id: thread.id },
      ]);
      const after = await currentInputs(thread.id);
      expect(after).toStrictEqual(before);
    },
  );
});
