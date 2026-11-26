import { randomUUID } from "node:crypto";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
import { threadEventCursor } from "./helpers/api-bdd-chat-files";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { createRouteMocks } from "./helpers/route-test";
import {
  configureDiscordApp,
  createPublicDiscordBinding,
  mockDiscordMemberships,
  uniqueDiscordSnowflake,
} from "./helpers/discord";
import {
  DISCORD_TEST_APPLICATION_ID,
  DISCORD_TEST_GATEWAY_SECRET,
  discordChatThreads,
  discordMessageForTest,
  mockDiscordProvider,
  postDiscordMessage,
} from "./helpers/discord-fixture";

const context = testContext();

/** Discord permission bits, as documented for the Discord API bitfield. */
const DiscordPermission = Object.freeze({
  Administrator: 1n << 3n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  ReadMessageHistory: 1n << 16n,
  CreatePublicThreads: 1n << 35n,
});

const DISCORD_API = "https://discord.com/api/v10";
const MESSAGE_ACCESS =
  DiscordPermission.ViewChannel |
  DiscordPermission.SendMessages |
  DiscordPermission.ReadMessageHistory;
const PROCESSING_FAILURE =
  "I couldn't process this Discord message. Please send it again.";

/** Gateway identity only: the sender has no Okou account. */
function configureUnboundGateway() {
  configureDiscordApp();
  mockEnv("DISCORD_APPLICATION_ID", DISCORD_TEST_APPLICATION_ID);
  mockEnv("DISCORD_GATEWAY_SECRET", DISCORD_TEST_GATEWAY_SECRET);
}

/** A provisioned workspace member with a verified Discord account link. */
async function connectedMember() {
  configureUnboundGateway();
  const authOrg = createAuthOrgBddApi(context);
  const workspace = {
    userId: `user_discord_${randomUUID()}`,
    orgId: `org_discord_${randomUUID()}`,
    orgRole: "org:admin",
  } as const;
  const actor = authOrg.user(workspace);
  await authOrg.provisionWorkspace(actor);
  mockDiscordMemberships(context, [workspace]);
  const binding = await createPublicDiscordBinding(context, {
    ...workspace,
    flow: "install",
    botUserId: DISCORD_TEST_APPLICATION_ID,
  });
  return {
    ...binding,
    sinceSetupSeqId: await threadEventCursor(context, actor),
  };
}

/** Every Chat Event the member can read in threads created since setup. */
async function threadEventText(member: {
  userId: string;
  orgId: string;
  sinceSetupSeqId?: number;
}) {
  const threads = await discordChatThreads(context, member);
  const events = [];
  for (const thread of threads) {
    createRouteMocks(context).clerk.session(member.userId, member.orgId);
    events.push(
      ...(await readProjectedChatEvents(context, {
        threadId: thread.id,
        headers: { authorization: "Bearer clerk-session" },
      })),
    );
  }
  return JSON.stringify(events);
}

/** A guild mention of the bot written by `authorId`. */
function guildMention(
  actor: { guildId: string; discordUserId: string; botUserId: string },
  channelId: string,
  authorId: string,
) {
  return {
    ...discordMessageForTest(actor, {
      channelId,
      content: `<@${actor.botUserId}> please help`,
    }),
    author: { id: authorId, username: `member-${authorId}` },
  };
}

/**
 * Gives the sender and the bot their own guild roles, replacing the default
 * provider roles so each party's permissions are explicit.
 */
function useGuildRoles(
  actor: { guildId: string; discordUserId: string; botUserId: string },
  permissions: {
    readonly everyone: bigint;
    readonly sender: bigint;
    readonly bot: bigint;
  },
) {
  const senderRoleId = uniqueDiscordSnowflake();
  const botRoleId = uniqueDiscordSnowflake();
  server.use(
    http.get(`${DISCORD_API}/guilds/${actor.guildId}/roles`, () => {
      return HttpResponse.json([
        {
          id: actor.guildId,
          name: "@everyone",
          permissions: permissions.everyone.toString(),
        },
        {
          id: senderRoleId,
          name: "Member",
          permissions: permissions.sender.toString(),
        },
        {
          id: botRoleId,
          name: "Okou bot",
          permissions: permissions.bot.toString(),
        },
      ]);
    }),
    http.get(
      `${DISCORD_API}/guilds/${actor.guildId}/members/:userId`,
      ({ params }) => {
        const userId = String(params.userId);
        const isBot = userId === actor.botUserId;
        return HttpResponse.json({
          user: { id: userId, username: isBot ? "Okou" : "member", bot: isBot },
          roles: isBot ? [botRoleId] : [senderRoleId],
        });
      },
    ),
  );
  return { senderRoleId, botRoleId };
}

type DiscordProvider = ReturnType<typeof mockDiscordProvider>;

/** Asserts the setup notices sent for two unconnected senders. */
function expectSetupNotices(
  provider: DiscordProvider,
  guildId: string,
  notices: readonly { authorId: string; messageId: string }[],
) {
  expect(provider.sentMessages).toHaveLength(notices.length);
  for (const [index, notice] of notices.entries()) {
    const sent = provider.sentMessages[index];
    expect(sent?.channel_id).toBe(provider.guildChannelId);
    expect(sent?.message_reference?.message_id).toBe(notice.messageId);
    expect(sent?.content).toContain(`<@${notice.authorId}>`);
    expect(sent?.content).toContain("Please connect your account");
    const link = sent?.components?.[0]?.components[0]?.url;
    expect(link).toBeTruthy();
    expect(new URL(link ?? "").searchParams.get("guild_id")).toBe(guildId);
    expect(sent?.allowed_mentions).toStrictEqual({
      parse: [],
      replied_user: false,
    });
  }
  // Only the source channel and the DM exist: no Discord thread was created.
  expect(provider.channels.size).toBe(2);
}

/** Delivers the first mention, its replay and a second sender's mention. */
async function deliverUnconnectedMentions(
  actor: { guildId: string; discordUserId: string; botUserId: string },
  provider: DiscordProvider,
) {
  const firstSender = uniqueDiscordSnowflake();
  const secondSender = uniqueDiscordSnowflake();
  const first = guildMention(actor, provider.guildChannelId, firstSender);
  const firstResponse = await postDiscordMessage(context, first);
  await flushWaitUntilForTest();
  const replay = await postDiscordMessage(
    context,
    first,
    `MESSAGE_CREATE:${first.id}:replay`,
  );
  await flushWaitUntilForTest();
  const second = guildMention(actor, provider.guildChannelId, secondSender);
  await postDiscordMessage(context, second);
  await flushWaitUntilForTest();
  return {
    firstResponse: firstResponse.body,
    replay: replay.body,
    notices: [
      { authorId: firstSender, messageId: first.id },
      { authorId: secondSender, messageId: second.id },
    ],
  };
}

describe("canonical Discord ingress", () => {
  it("discord-ingress-013 replies to unconnected guild mentions with a setup link when the server has no installation", async () => {
    configureUnboundGateway();
    const guild = {
      guildId: uniqueDiscordSnowflake(),
      discordUserId: uniqueDiscordSnowflake(),
      botUserId: DISCORD_TEST_APPLICATION_ID,
    };
    const provider = mockDiscordProvider(guild);

    const delivered = await deliverUnconnectedMentions(guild, provider);

    expect(delivered.firstResponse).toMatchObject({
      ok: true,
      outcome: "ignored",
    });
    expect(delivered.replay).toMatchObject({ ok: true, outcome: "ignored" });
    expectSetupNotices(provider, guild.guildId, delivered.notices);
  });

  it("discord-ingress-009 ignores unmentioned guild chatter without any chat or provider side effect", async () => {
    const actor = await connectedMember();
    const provider = mockDiscordProvider(actor);
    const chatter = {
      ...discordMessageForTest(actor, {
        channelId: provider.guildChannelId,
        content: "just chatting with the team",
      }),
      mentions: [],
    };

    const response = await postDiscordMessage(context, chatter);
    await flushWaitUntilForTest();

    expect(response.body).toMatchObject({ ok: true, outcome: "ignored" });
    await expect(discordChatThreads(context, actor)).resolves.toHaveLength(0);
    expect(provider.sentMessages).toHaveLength(0);
    expect(provider.channels.size).toBe(2);
  });

  it("discord-ingress-012 replies to unconnected guild mentions with a setup link when the server has an installation", async () => {
    const installer = await connectedMember();
    const provider = mockDiscordProvider(installer);

    const delivered = await deliverUnconnectedMentions(installer, provider);

    expect(delivered.firstResponse).toMatchObject({
      ok: true,
      outcome: "ignored",
    });
    expect(delivered.replay).toMatchObject({ ok: true, outcome: "ignored" });
    expectSetupNotices(provider, installer.guildId, delivered.notices);
    await expect(discordChatThreads(context, installer)).resolves.toHaveLength(
      0,
    );
  });

  async function multiWorkspaceDmSender() {
    configureUnboundGateway();
    const authOrg = createAuthOrgBddApi(context);
    const userId = `user_discord_${randomUUID()}`;
    const discordUserId = uniqueDiscordSnowflake();
    const workspaces = [
      { userId, orgId: `org_discord_${randomUUID()}`, orgRole: "org:admin" },
      { userId, orgId: `org_discord_${randomUUID()}`, orgRole: "org:admin" },
    ] as const;
    for (const workspace of workspaces) {
      await authOrg.provisionWorkspace(authOrg.user(workspace));
    }
    mockDiscordMemberships(context, workspaces);
    const first = await createPublicDiscordBinding(context, {
      ...workspaces[0],
      flow: "install",
      discordUserId,
      botUserId: DISCORD_TEST_APPLICATION_ID,
    });
    await createPublicDiscordBinding(context, {
      ...workspaces[1],
      flow: "install",
      discordUserId,
      botUserId: DISCORD_TEST_APPLICATION_ID,
    });
    const provider = mockDiscordProvider(first);
    return { authOrg, workspaces, first, provider };
  }

  it("discord-ingress-053 (1/2) ignores both DMs and asks once to choose a workspace with /connect", async () => {
    const { first, provider } = await multiWorkspaceDmSender();

    const responses = [];
    for (const content of ["first question", "second question"]) {
      const dm = discordMessageForTest(first, {
        channelId: provider.dmChannelId,
        content,
        guild: false,
      });
      responses.push((await postDiscordMessage(context, dm)).body);
      await flushWaitUntilForTest();
    }

    for (const response of responses) {
      expect(response).toMatchObject({ ok: true, outcome: "ignored" });
    }
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]?.channel_id).toBe(provider.dmChannelId);
    expect(provider.sentMessages[0]?.content).toContain("/connect");
  });

  it("discord-ingress-053 (2/2) creates no chat in either eligible workspace after ambiguous DMs", async () => {
    const { authOrg, workspaces, first, provider } =
      await multiWorkspaceDmSender();
    const owners = [];
    for (const workspace of workspaces) {
      owners.push({
        ...workspace,
        sinceSetupSeqId: await threadEventCursor(
          context,
          authOrg.user(workspace),
        ),
      });
    }

    for (const content of ["first question", "second question"]) {
      const dm = discordMessageForTest(first, {
        channelId: provider.dmChannelId,
        content,
        guild: false,
      });
      await postDiscordMessage(context, dm);
      await flushWaitUntilForTest();
    }

    for (const owner of owners) {
      await expect(discordChatThreads(context, owner)).resolves.toHaveLength(0);
    }
  });

  it("discord-ingress-052 tells an unconnected DM sender how to connect about once an hour", async () => {
    configureUnboundGateway();
    const sender = {
      guildId: uniqueDiscordSnowflake(),
      discordUserId: uniqueDiscordSnowflake(),
      botUserId: DISCORD_TEST_APPLICATION_ID,
    };
    const provider = mockDiscordProvider(sender);
    const start = now();
    mockNow(start);
    function directMessage(content: string) {
      return discordMessageForTest(sender, {
        channelId: provider.dmChannelId,
        content,
        guild: false,
      });
    }

    const first = directMessage("hello");
    const firstResponse = await postDiscordMessage(context, first);
    await flushWaitUntilForTest();
    await postDiscordMessage(context, first);
    await postDiscordMessage(context, directMessage("are you there?"));
    await flushWaitUntilForTest();
    mockNow(start + 10 * 60_000);
    await postDiscordMessage(context, directMessage("ten minutes later"));
    await flushWaitUntilForTest();
    const noticesWithinTheHour = provider.sentMessages.length;
    mockNow(start + 61 * 60_000);
    await Promise.all([
      postDiscordMessage(context, directMessage("an hour later")),
      postDiscordMessage(context, directMessage("and again")),
    ]);
    await flushWaitUntilForTest();

    expect(firstResponse.body).toMatchObject({ ok: true, outcome: "ignored" });
    expect(noticesWithinTheHour).toBe(1);
    const notice = provider.sentMessages[0];
    expect(notice?.channel_id).toBe(provider.dmChannelId);
    const button = notice?.components?.[0]?.components[0];
    expect(button?.label).toBe("Connect");
    const link = new URL(button?.url ?? "");
    expect(link.pathname).toBe(INTEGRATION_SETTINGS_PATHS.discord);
    expect(link.searchParams.has("guild_id")).toBeFalsy();
    expect(provider.sentMessages).toHaveLength(2);
  });

  it("discord-ingress-022 requires the sender to create public threads even when the bot is an administrator", async () => {
    const actor = await connectedMember();
    const provider = mockDiscordProvider(actor);
    useGuildRoles(actor, {
      everyone: MESSAGE_ACCESS,
      sender: 0n,
      bot: DiscordPermission.Administrator,
    });
    const mention = guildMention(
      actor,
      provider.guildChannelId,
      actor.discordUserId,
    );

    const response = await postDiscordMessage(context, mention);
    await flushWaitUntilForTest();
    const replay = await postDiscordMessage(
      context,
      mention,
      `MESSAGE_CREATE:${mention.id}:replay`,
    );
    await flushWaitUntilForTest();

    expect(response.body).toMatchObject({ ok: true, outcome: "accepted" });
    expect(replay.body).toMatchObject({ ok: true, outcome: "duplicate" });
    expect(provider.channels.size).toBe(2);
    await expect(threadEventText(actor)).resolves.not.toContain("please help");
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]?.channel_id).toBe(provider.guildChannelId);
    expect(provider.sentMessages[0]?.content).toBe(PROCESSING_FAILURE);
  });

  it("discord-ingress-023 requires the bot to create public threads even when the sender is an administrator", async () => {
    const actor = await connectedMember();
    const provider = mockDiscordProvider(actor);
    useGuildRoles(actor, {
      everyone: MESSAGE_ACCESS,
      sender: DiscordPermission.Administrator,
      bot: 0n,
    });
    const mention = guildMention(
      actor,
      provider.guildChannelId,
      actor.discordUserId,
    );

    const response = await postDiscordMessage(context, mention);
    await flushWaitUntilForTest();
    const replay = await postDiscordMessage(
      context,
      mention,
      `MESSAGE_CREATE:${mention.id}:replay`,
    );
    await flushWaitUntilForTest();

    expect(response.body).toMatchObject({ ok: true, outcome: "accepted" });
    expect(replay.body).toMatchObject({ ok: true, outcome: "duplicate" });
    expect(provider.channels.size).toBe(2);
    await expect(threadEventText(actor)).resolves.not.toContain("please help");
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]?.channel_id).toBe(provider.guildChannelId);
    expect(provider.sentMessages[0]?.content).toBe(PROCESSING_FAILURE);
  });

  it("discord-ingress-031 admits nothing when a sender role overwrite denies public-thread creation", async () => {
    const actor = await connectedMember();
    const provider = mockDiscordProvider(actor);
    const { senderRoleId } = useGuildRoles(actor, {
      everyone: MESSAGE_ACCESS,
      sender: DiscordPermission.CreatePublicThreads,
      bot: DiscordPermission.Administrator,
    });
    const channel = provider.channels.get(provider.guildChannelId);
    if (!channel) {
      throw new Error("Expected the guild channel");
    }
    channel.permission_overwrites = [
      {
        id: senderRoleId,
        type: 0,
        allow: "0",
        deny: DiscordPermission.CreatePublicThreads.toString(),
      },
    ];

    const response = await postDiscordMessage(
      context,
      guildMention(actor, provider.guildChannelId, actor.discordUserId),
    );
    await flushWaitUntilForTest();

    expect(response.body).toMatchObject({ ok: true, outcome: "accepted" });
    expect(provider.channels.size).toBe(2);
    await expect(threadEventText(actor)).resolves.not.toContain("please help");
  });
});
