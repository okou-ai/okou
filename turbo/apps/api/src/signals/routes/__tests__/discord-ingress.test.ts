import { describe, expect, it, onTestFinished, afterEach } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { configureDiscordApp, uniqueDiscordSnowflake } from "./helpers/discord";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  DISCORD_TEST_APPLICATION_ID,
  DISCORD_TEST_GATEWAY_SECRET,
  mockDiscordProvider,
  discordMessageForTest,
  postDiscordMessage,
} from "./helpers/discord-fixture";
const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
afterEach(async () => {
  await flushWaitUntilForTest();
});
function unboundSender() {
  configureDiscordApp();
  mockEnv("DISCORD_APPLICATION_ID", DISCORD_TEST_APPLICATION_ID);
  mockEnv("DISCORD_GATEWAY_SECRET", DISCORD_TEST_GATEWAY_SECRET);
  const actor = bdd.user();
  return {
    ...actor,
    actor,
    orgId: actor.orgId!,
    guildId: uniqueDiscordSnowflake(),
    discordUserId: uniqueDiscordSnowflake(),
    botUserId: DISCORD_TEST_APPLICATION_ID,
  };
}
describe("unbound Discord ingress", () => {
  it.each(["unmentioned", "unbound", "disabled"] as const)(
    "ignores %s messages without canonical chat or provider thread side effects",
    async (scenario) => {
      const actor = unboundSender();
      const provider = mockDiscordProvider(actor);
      if (scenario === "disabled") {
        await updateFeatureSwitchesForUser(context, actor, {
          [FeatureSwitchKey.DiscordIntegration]: false,
        });
      }
      const message = discordMessageForTest(actor, {
        channelId: provider.guildChannelId,
        content:
          scenario === "unmentioned"
            ? "ordinary guild conversation"
            : `<@${actor.botUserId}> this message cannot be admitted`,
      });
      const ignored = {
        ...message,
        mentions: scenario === "unmentioned" ? [] : message.mentions,
        author:
          scenario === "unbound"
            ? { id: uniqueDiscordSnowflake(), username: "unbound-member" }
            : message.author,
      };
      expect((await postDiscordMessage(context, ignored)).body.outcome).toBe(
        "ignored",
      );
      await flushWaitUntilForTest();
      await expect(chat.getThreadSnapshot(actor.actor)).resolves.toMatchObject({
        chatThreads: [],
      });
      expect([...provider.channels.keys()]).toStrictEqual([
        provider.guildChannelId,
        provider.dmChannelId,
      ]);
      expect(provider.sentMessages).toHaveLength(0);
    },
  );
  it("ignores an unbound guild while the identity provider is failing", async () => {
    const actor = unboundSender();
    const provider = mockDiscordProvider(actor);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new Error("Clerk unavailable"),
    );
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: "ordinary guild conversation",
    });

    expect(
      (await postDiscordMessage(context, { ...message, mentions: [] })).body,
    ).toStrictEqual({
      ok: true,
      outcome: "ignored",
      reason: "unbound-disabled-or-dm-selection-required",
    });
  });
  it("tells an unconnected DM sender how to connect about once an hour", async () => {
    const actor = unboundSender();
    const provider = mockDiscordProvider(actor);
    const stranger = uniqueDiscordSnowflake();
    const dmId = uniqueDiscordSnowflake();
    provider.channels.set(dmId, {
      id: dmId,
      type: 1,
      recipients: [{ id: stranger, username: "stranger" }],
    });
    const strangerDm = (content: string) => {
      return {
        ...discordMessageForTest(actor, {
          channelId: dmId,
          guild: false,
          content,
        }),
        author: { id: stranger, username: "stranger" },
      };
    };
    const noticesTo = (channelId: string) => {
      return provider.sentMessages.filter((message) => {
        return message.channel_id === channelId;
      });
    };
    mockNow(now());
    const first = strangerDm("hello?");
    expect((await postDiscordMessage(context, first)).body.outcome).toBe(
      "ignored",
    );
    await flushWaitUntilForTest();
    expect(noticesTo(dmId)).toHaveLength(1);
    expect(noticesTo(dmId)[0]?.content).toContain("/okou connect");
    // A relay retry of the same event and a follow-up DM send nothing more.
    await postDiscordMessage(context, first);
    await postDiscordMessage(context, strangerDm("are you there?"));
    await flushWaitUntilForTest();
    expect(noticesTo(dmId)).toHaveLength(1);
    // Past Discord's nonce window, the notice already in the DM still counts.
    mockNow(now() + 10 * 60 * 1000);
    await postDiscordMessage(context, strangerDm("still nothing?"));
    await flushWaitUntilForTest();
    expect(noticesTo(dmId)).toHaveLength(1);
    // An hour after that notice, two racing DMs both find none and still
    // produce one new notice.
    mockNow(now() + 60 * 60 * 1000);
    const secondRead = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!secondRead.settled()) {
        secondRead.resolve(undefined);
      }
    });
    let historyReads = 0;
    provider.state.historyResponse = async () => {
      historyReads += 1;
      if (historyReads === 1) {
        await secondRead.promise;
      } else {
        secondRead.resolve(undefined);
      }
      return undefined;
    };
    await postDiscordMessage(context, strangerDm("trying again later"));
    await postDiscordMessage(context, strangerDm("and once more"));
    await flushWaitUntilForTest();
    expect(noticesTo(dmId)).toHaveLength(2);
  });
});
