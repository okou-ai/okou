import { revokedChatEventIds } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { testDiscordIngressContract } from "@okouai/api-contracts/contracts/test-discord-ingress";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { testDiscordIngressRoutes } from "../test-discord-ingress";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webDownloadRoutes } from "../web-download";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import {
  deleteDiscordFixture,
  mockDiscordMemberships,
  seedDiscordFixture,
  uniqueDiscordSnowflake,
} from "./helpers/discord";
import {
  discordChatThreads,
  discordMessageForTest,
  DISCORD_TEST_APPLICATION_ID,
  mockDiscordProvider,
  postDiscordGatewayEnvelope,
  postDiscordMessage,
  requestDiscordGatewayEnvelope,
  setupConnectedDiscordActor,
  type ConnectedDiscordActor,
} from "./helpers/discord-fixture";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";

const context = testContext();
const runsApi = createRunsApi(context);
const track = createFixtureTracker<ConnectedDiscordActor>(async (actor) => {
  await deleteDiscordFixture(context, actor.fixture);
  await deleteFeatureSwitchesForUser(context, actor);
});

afterEach(async () => {
  await flushWaitUntilForTest();
});

function connected() {
  return track(setupConnectedDiscordActor(context));
}

function events(actor: ConnectedDiscordActor, threadId: string) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:admin",
  );
  return readProjectedChatEvents(context, {
    threadId,
    headers: { authorization: "Bearer clerk-session" },
  });
}

function currentInputs(rows: readonly ChatEvent[]) {
  const revokedIds = revokedChatEventIds(rows);
  return rows.filter(
    (event): event is Extract<ChatEvent, { eventType: "input.prompt" }> => {
      return event.eventType === "input.prompt" && !revokedIds.has(event.id);
    },
  );
}

interface PublicThreadPermissionCase {
  readonly name: string;
  readonly allowed: boolean;
  readonly senderPermissions?: string;
  readonly botPermissions?: string;
  readonly senderIsOwner?: boolean;
  readonly channelType?: number;
  readonly overwrites?: readonly {
    readonly id: "senderRole" | "botRole" | "extraRole" | "sender" | "bot";
    readonly type: 0 | 1;
    readonly deny: string;
    readonly allow: string;
  }[];
}

function recover(actor: ConnectedDiscordActor) {
  return accept(
    setupApp({ context, routes: testDiscordIngressRoutes })(
      testDiscordIngressContract,
    ).recover({
      body: { connectionIds: [actor.connectionId] },
    }),
    [200],
  );
}

async function selectDmOrganization(actor: ConnectedDiscordActor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:admin",
  );
  await accept(
    setupApp({ context, routes: integrationsDiscordRoutes })(
      integrationsDiscordContract,
    ).setDmSelection({
      headers: { authorization: "Bearer clerk-session" },
      body: { connectionId: actor.connectionId },
    }),
    [200],
  );
}

function botReplyBefore(
  actor: ConnectedDiscordActor,
  provider: ReturnType<typeof mockDiscordProvider>,
  next: ReturnType<typeof discordMessageForTest>,
  content: string,
) {
  // Discord keeps a single bot DM channel per user, so an earlier reply stays
  // in it no matter which organization or DM session produced it.
  const reply = {
    ...discordMessageForTest(actor, {
      id: (BigInt(next.id) - 1n).toString(),
      channelId: next.channel_id,
      guild: false,
      content,
    }),
    author: { id: actor.botUserId, username: "Okou", bot: true },
  };
  provider.messages.set(reply.id, reply);
}

async function launchedRun(actor: ConnectedDiscordActor, threadId: string) {
  const [input] = currentInputs(await events(actor, threadId));
  if (!input?.runId) {
    throw new Error("Expected a launched Discord run");
  }
  return await runsApi.readRun(actor.actor, input.runId);
}

async function discordStatus(actor: ConnectedDiscordActor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:admin",
  );
  const response = await accept(
    setupApp({ context, routes: integrationsDiscordRoutes })(
      integrationsDiscordContract,
    ).getStatus({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
  return response.body;
}

describe("canonical Discord ingress", () => {
  it.each(["unmentioned", "unbound", "disabled"] as const)(
    "ignores %s messages without canonical chat or provider thread side effects",
    async (scenario) => {
      const actor = await connected();
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
      await expect(discordChatThreads(context, actor)).resolves.toHaveLength(0);
      expect([...provider.channels.keys()]).toStrictEqual([
        provider.guildChannelId,
        provider.dmChannelId,
      ]);
      expect(provider.sentMessages).toHaveLength(0);
    },
  );

  it("ignores unmentioned guild chatter even while the identity provider is failing", async () => {
    const actor = await connected();
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
      reason: "no-explicit-mention",
    });
  });

  it("creates one owned input and run across concurrent relay retries", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> preserve this request`,
    });
    provider.messages.set(message.id, message);
    const receipts = await Promise.all([
      postDiscordMessage(context, message),
      postDiscordMessage(context, message, `replayed:${message.id}`),
    ]);
    expect(
      receipts
        .map((receipt) => {
          return receipt.body.outcome;
        })
        .sort(),
    ).toStrictEqual(["accepted", "duplicate"]);
    await flushWaitUntilForTest();
    const threads = await discordChatThreads(context, actor);
    expect(threads).toHaveLength(1);
    const thread = threads[0];
    if (!thread) {
      throw new Error("Expected canonical Discord thread");
    }
    const projected = await events(actor, thread.id);
    const inputs = currentInputs(projected);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.userMessage.parts).toContainEqual({
      type: "text",
      text: "@Okou preserve this request",
    });
    expect(inputs[0]?.userMessage.parts).toContainEqual({
      type: "source",
      kind: "discord",
      href: `https://discord.com/channels/${actor.guildId}/${provider.guildChannelId}/${message.id}`,
    });
    expect(inputs[0]?.runId).toStrictEqual(expect.any(String));
    expect(JSON.stringify(projected)).not.toContain(actor.connectionId);
    expect(JSON.stringify(projected)).not.toContain("conversationContext");
    if (!inputs[0]?.runId) {
      throw new Error("Expected Discord run launch");
    }
    const run = await runsApi.readRun(actor.actor, inputs[0].runId);
    expect(run.prompt).toBe("@Okou preserve this request");
    expect(run.appendSystemPrompt).toContain("MESSAGE_CONTENT is unavailable");
  });

  it.each([false, true])(
    "tells a Discord run how its final reply and files reach Discord (private artifacts %s)",
    async (privateArtifacts) => {
      const actor = await connected();
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.PrivateArtifacts]: privateArtifacts,
      });
      const provider = mockDiscordProvider(actor);
      const message = discordMessageForTest(actor, {
        channelId: provider.guildChannelId,
        content: `<@${actor.botUserId}> make me a report file`,
      });
      provider.messages.set(message.id, message);
      await postDiscordMessage(context, message);
      await flushWaitUntilForTest();
      const [thread] = await discordChatThreads(context, actor);
      if (!thread) {
        throw new Error("Expected canonical Discord thread");
      }
      const [input] = currentInputs(await events(actor, thread.id));
      if (!input?.runId) {
        throw new Error("Expected Discord run launch");
      }
      await runsApi.heartbeatRunner(actor.runnerGroup);
      const claim = await runsApi.claimRunnerJob(input.runId);

      expect(claim.appendSystemPrompt).toContain(
        "# Integration Note\n\n- Discord messaging and files: only your final reply is delivered to the Discord channel or thread in the integration context, so do not duplicate it with `okou discord message send`;",
      );
      expect(claim.appendSystemPrompt).toContain(
        "`okou discord upload-file -h` can attach a local file to a Discord channel or thread",
      );
      expect(claim.appendSystemPrompt).toContain(
        "- Discord files: when the task explicitly asks to share a file in Discord, use `okou discord upload-file --help`",
      );
      // Native reads deny bot DMs, so the prompt must not steer runs there.
      expect(claim.appendSystemPrompt).toContain(
        "Bot DM content is not readable; you can only send or upload to your own bot DM.",
      );
      expect(claim.appendSystemPrompt).toContain(
        "bot DM attachments cannot be downloaded",
      );
      expect(claim.appendSystemPrompt).toContain(
        "bot DM content, including earlier DM messages and their attachments, is not readable",
      );
      expect(claim.appendSystemPrompt).not.toContain(
        "Only your own bot DM is accessible",
      );
      const privateArtifactRule =
        "A private `/artifacts/...` address is not openable from Discord, so a link alone shows the user nothing.";
      if (privateArtifacts) {
        expect(claim.appendSystemPrompt).toContain(privateArtifactRule);
        expect(claim.appendSystemPrompt).toContain(
          "upload it with `okou discord upload-file` so the user has something they can open there",
        );
      } else {
        expect(claim.appendSystemPrompt).not.toContain(
          "Private artifacts in the final reply",
        );
      }
    },
  );

  it.each(["sender", "bot"] as const)(
    "requires %s public-thread creation permission even when the other party is an administrator",
    async (deniedParty) => {
      const actor = await connected();
      const provider = mockDiscordProvider(actor);
      // Discord wire bits VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY
      // allow both parties to converse, but omit CREATE_PUBLIC_THREADS.
      const administratorRoleId = uniqueDiscordSnowflake();
      const administratorUserId =
        deniedParty === "sender" ? actor.botUserId : actor.discordUserId;
      server.use(
        http.get(
          `https://discord.com/api/v10/guilds/${actor.guildId}/roles`,
          () => {
            return HttpResponse.json([
              { id: actor.guildId, name: "@everyone", permissions: "68608" },
              {
                id: administratorRoleId,
                name: "Administrator",
                permissions: "8",
              },
            ]);
          },
        ),
        http.get(
          `https://discord.com/api/v10/guilds/${actor.guildId}/members/:userId`,
          ({ params }) => {
            const userId = String(params.userId);
            return HttpResponse.json({
              user: {
                id: userId,
                username: "member",
                bot: userId === actor.botUserId,
              },
              roles:
                userId === administratorUserId ? [administratorRoleId] : [],
            });
          },
        ),
      );
      const message = discordMessageForTest(actor, {
        channelId: provider.guildChannelId,
        content: `<@${actor.botUserId}> do not create a thread on my behalf`,
      });
      provider.messages.set(message.id, message);
      expect((await postDiscordMessage(context, message)).body.outcome).toBe(
        "accepted",
      );
      await flushWaitUntilForTest();
      expect([...provider.channels.keys()]).toStrictEqual([
        provider.guildChannelId,
        provider.dmChannelId,
      ]);
      // The denial is decided before any route exists, so no empty chat is
      // left behind and the notice names the missing permission.
      await expect(discordChatThreads(context, actor)).resolves.toHaveLength(0);
      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]).toMatchObject({
        channel_id: provider.guildChannelId,
        content:
          "I can't start a thread for this request here. You and Okou both need the Create Public Threads permission in this channel.",
      });
      await postDiscordMessage(context, message, `denied-replay:${message.id}`);
      await flushWaitUntilForTest();
      expect(provider.sentMessages).toHaveLength(1);
    },
  );

  // Discord's CREATE_PUBLIC_THREADS bit, independent of ordinary conversation
  // permissions. The case data below are Discord role and overwrite payloads.
  const createPublicThreads = "34359738368";
  it.each<PublicThreadPermissionCase>([
    { name: "both role grants", allowed: true },
    {
      name: "sender role deny",
      allowed: false,
      overwrites: [
        { id: "senderRole", type: 0, deny: createPublicThreads, allow: "0" },
      ],
    },
    {
      name: "bot role deny",
      allowed: false,
      overwrites: [
        { id: "botRole", type: 0, deny: createPublicThreads, allow: "0" },
      ],
    },
    {
      name: "sender member deny",
      allowed: false,
      overwrites: [
        { id: "sender", type: 1, deny: createPublicThreads, allow: "0" },
      ],
    },
    {
      name: "bot member deny",
      allowed: false,
      overwrites: [
        { id: "bot", type: 1, deny: createPublicThreads, allow: "0" },
      ],
    },
    {
      name: "aggregated role allow",
      allowed: true,
      senderPermissions: "0",
      overwrites: [
        { id: "senderRole", type: 0, deny: createPublicThreads, allow: "0" },
        { id: "extraRole", type: 0, deny: "0", allow: createPublicThreads },
      ],
    },
    {
      name: "member allow after role deny",
      allowed: true,
      overwrites: [
        { id: "senderRole", type: 0, deny: createPublicThreads, allow: "0" },
        { id: "sender", type: 1, deny: "0", allow: createPublicThreads },
      ],
    },
    {
      name: "sender admin despite overwrite",
      allowed: true,
      senderPermissions: "8",
      overwrites: [
        { id: "sender", type: 1, deny: createPublicThreads, allow: "0" },
      ],
    },
    {
      name: "bot admin despite overwrite",
      allowed: true,
      botPermissions: "8",
      overwrites: [
        { id: "bot", type: 1, deny: createPublicThreads, allow: "0" },
      ],
    },
    {
      name: "sender owner despite overwrite",
      allowed: true,
      senderPermissions: "0",
      senderIsOwner: true,
      overwrites: [
        { id: "sender", type: 1, deny: createPublicThreads, allow: "0" },
      ],
    },
    { name: "announcement parent", allowed: true, channelType: 5 },
    { name: "forum parent", allowed: false, channelType: 15 },
    { name: "media parent", allowed: false, channelType: 16 },
  ])("applies public-thread creation authority: $name", async (testCase) => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const base = "https://discord.com/api/v10";
    const ids = {
      senderRole: uniqueDiscordSnowflake(),
      extraRole: uniqueDiscordSnowflake(),
      botRole: uniqueDiscordSnowflake(),
      sender: actor.discordUserId,
      bot: actor.botUserId,
    };
    server.use(
      http.get(`${base}/guilds/${actor.guildId}`, () => {
        return HttpResponse.json({
          id: actor.guildId,
          name: "Permission test guild",
          owner_id: testCase.senderIsOwner
            ? actor.discordUserId
            : uniqueDiscordSnowflake(),
        });
      }),
      http.get(`${base}/guilds/${actor.guildId}/roles`, () => {
        return HttpResponse.json([
          {
            id: actor.guildId,
            name: "@everyone",
            // VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY |
            // SEND_MESSAGES_IN_THREADS, without CREATE_PUBLIC_THREADS.
            permissions: "274877975552",
          },
          {
            id: ids.senderRole,
            name: "sender",
            permissions: testCase.senderPermissions ?? createPublicThreads,
          },
          { id: ids.extraRole, name: "extra", permissions: "0" },
          {
            id: ids.botRole,
            name: "bot",
            permissions: testCase.botPermissions ?? createPublicThreads,
          },
        ]);
      }),
      http.get(
        `${base}/guilds/${actor.guildId}/members/:userId`,
        ({ params }) => {
          const userId = String(params.userId);
          const isBot = userId === actor.botUserId;
          return HttpResponse.json({
            user: {
              id: userId,
              username: isBot ? "Okou" : "sender",
              bot: isBot,
            },
            roles: isBot ? [ids.botRole] : [ids.senderRole, ids.extraRole],
          });
        },
      ),
    );
    const parent = provider.channels.get(provider.guildChannelId);
    if (!parent) {
      throw new Error("Expected the source guild channel fixture");
    }
    parent.type = testCase.channelType ?? 0;
    parent.permission_overwrites = (testCase.overwrites ?? []).map(
      (overwrite) => {
        return { ...overwrite, id: ids[overwrite.id] };
      },
    );
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> apply the current creation permissions`,
    });
    provider.messages.set(message.id, message);
    expect((await postDiscordMessage(context, message)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();
    expect(provider.channels.has(message.id)).toBe(testCase.allowed);
    const threads = await discordChatThreads(context, actor);
    expect(threads).toHaveLength(testCase.allowed ? 1 : 0);
    const inputs = [];
    for (const thread of threads) {
      inputs.push(...currentInputs(await events(actor, thread.id)));
    }
    expect(inputs).toHaveLength(testCase.allowed ? 1 : 0);
    if (testCase.allowed) {
      expect(provider.channels.get(message.id)?.parent_id).toBe(
        provider.guildChannelId,
      );
      const [input] = inputs;
      if (!input?.runId) {
        throw new Error("Expected one run for the permitted Discord input");
      }
      const run = await runsApi.readRun(actor.actor, input.runId);
      expect(run.prompt).toBe("@Okou apply the current creation permissions");
    }
  });

  it("recovers a lost thread-create response without creating another physical thread", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> recover the existing Discord thread`,
    });
    provider.messages.set(message.id, message);
    let threadCreations = 0;
    provider.state.afterThreadCreated = (channel) => {
      threadCreations++;
      // The immediate reconciliation read is unavailable until the next attempt.
      provider.deniedChannels.add(channel.id);
      return HttpResponse.error();
    };
    mockNow(now());
    await postDiscordMessage(context, message);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected a durable route before the lost response");
    }
    await expect(events(actor, thread.id)).resolves.toHaveLength(0);
    expect(provider.channels.has(message.id)).toBeTruthy();
    provider.deniedChannels.delete(message.id);
    mockNow(now() + 61_000);
    await recover(actor);
    const inputs = currentInputs(await events(actor, thread.id));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.runId).toStrictEqual(expect.any(String));
    expect(threadCreations).toBe(1);
  });

  it("keeps two users in one physical Discord thread in separate owned chats", async () => {
    const first = await connected();
    const provider = mockDiscordProvider(first);
    const firstMessage = discordMessageForTest(first, {
      channelId: provider.guildChannelId,
      content: `<@${first.botUserId}> first user's private task`,
    });
    provider.messages.set(firstMessage.id, firstMessage);
    await postDiscordMessage(context, firstMessage);
    await flushWaitUntilForTest();
    const second = await track(
      setupConnectedDiscordActor(context, {
        orgId: first.orgId,
        guildId: first.guildId,
        reuseOrganization: true,
      }),
    );
    mockDiscordMemberships(context, [
      { userId: first.userId, orgId: first.orgId, orgRole: "org:admin" },
      { userId: second.userId, orgId: second.orgId, orgRole: "org:admin" },
    ]);
    const secondMessage = discordMessageForTest(second, {
      channelId: firstMessage.id,
      content: `<@${second.botUserId}> second user's private task`,
    });
    provider.messages.set(secondMessage.id, secondMessage);
    await postDiscordMessage(context, secondMessage);
    await flushWaitUntilForTest();
    const firstThreads = await discordChatThreads(context, first);
    const secondThreads = await discordChatThreads(context, second);
    expect(firstThreads).toHaveLength(1);
    expect(secondThreads).toHaveLength(1);
    const firstThread = firstThreads[0];
    const secondThread = secondThreads[0];
    if (!firstThread || !secondThread) {
      throw new Error("Expected distinct owned Discord chats");
    }
    expect(firstThread.id).not.toBe(secondThread.id);
    expect(JSON.stringify(await events(first, firstThread.id))).not.toContain(
      "second user's private task",
    );
    expect(JSON.stringify(await events(second, secondThread.id))).not.toContain(
      "first user's private task",
    );
  });

  it("ignores temporary guild unavailability and deduplicates uninstall replay after reinstall", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const eventId = `GUILD_DELETE:${actor.guildId}:removed`;
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    expect(
      (
        await postDiscordGatewayEnvelope(context, {
          version: 1,
          applicationId: DISCORD_TEST_APPLICATION_ID,
          eventType: "GUILD_DELETE",
          eventId: `GUILD_DELETE:${actor.guildId}:unavailable`,
          payload: { id: actor.guildId, unavailable: true },
        })
      ).body.outcome,
    ).toBe("ignored");
    await flushWaitUntilForTest();
    expect(channelsPublishedTo(context.mocks, "discord:changed")).toStrictEqual(
      [],
    );
    await expect(discordStatus(actor)).resolves.toMatchObject({
      isInstalled: true,
    });
    const removed = {
      version: 1 as const,
      applicationId: DISCORD_TEST_APPLICATION_ID,
      eventType: "GUILD_DELETE" as const,
      eventId,
      payload: { id: actor.guildId },
    };
    // Discord no longer lists the bot in a guild it was removed from.
    provider.guildIds.delete(actor.guildId);
    expect(
      (await postDiscordGatewayEnvelope(context, removed)).body.outcome,
    ).toBe("accepted");
    await flushWaitUntilForTest();
    expect(channelsPublishedTo(context.mocks, "discord:changed")).toStrictEqual(
      [`user:${actor.userId}`],
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "discord:changed",
      null,
    );
    await expect(discordStatus(actor)).resolves.toMatchObject({
      isInstalled: false,
    });
    const reinstalled = await seedDiscordFixture(context, {
      userId: actor.userId,
      orgId: actor.orgId,
      orgRole: "org:admin",
      guildId: actor.guildId,
      botUserId: actor.botUserId,
      discordUserId: actor.discordUserId,
      guildName: "Discord test guild",
    });
    expect(reinstalled.connectionId).not.toBe(actor.connectionId);
    provider.guildIds.add(actor.guildId);
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    expect(
      (await postDiscordGatewayEnvelope(context, removed)).body.outcome,
    ).toBe("duplicate");
    await flushWaitUntilForTest();
    expect(channelsPublishedTo(context.mocks, "discord:changed")).toStrictEqual(
      [],
    );
    await expect(discordStatus(actor)).resolves.toMatchObject({
      isInstalled: true,
    });
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> installed again`,
    });
    provider.messages.set(message.id, message);
    await postDiscordMessage(context, message);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected reinstalled binding to accept messages");
    }
    expect(currentInputs(await events(actor, thread.id))).toHaveLength(1);
  });

  it("keeps a reinstalled guild when an earlier removal is delivered late", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    // The relay queued this removal before a halt, then the guild reinstalled
    // the bot. Its sequence-based eventId is new to the API.
    const late = {
      version: 1 as const,
      applicationId: DISCORD_TEST_APPLICATION_ID,
      eventType: "GUILD_DELETE" as const,
      eventId: `GUILD_DELETE:halted-session:${uniqueDiscordSnowflake()}`,
      payload: { id: actor.guildId },
    };
    await expect(
      postDiscordGatewayEnvelope(context, late),
    ).resolves.toMatchObject({
      body: { outcome: "ignored", reason: "guild-membership-current" },
    });
    let discordFailing = true;
    server.use(
      http.get(`https://discord.com/api/v10/guilds/${actor.guildId}`, () => {
        return discordFailing
          ? HttpResponse.json(
              { message: "Internal Server Error" },
              { status: 500 },
            )
          : undefined;
      }),
    );
    // An unverifiable removal stays with the relay for retry.
    await accept(requestDiscordGatewayEnvelope(context, late), [503]);
    discordFailing = false;
    await flushWaitUntilForTest();
    expect(channelsPublishedTo(context.mocks, "discord:changed")).toStrictEqual(
      [],
    );
    await expect(discordStatus(actor)).resolves.toMatchObject({
      isInstalled: true,
      isConnected: true,
    });
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> still installed`,
    });
    provider.messages.set(message.id, message);
    await postDiscordMessage(context, message);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected the retained installation to accept messages");
    }
    expect(currentInputs(await events(actor, thread.id))).toHaveLength(1);
  });

  it("does not launch an accepted message again after disconnect and reinstall", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> run this request only once`,
    });
    provider.messages.set(message.id, message);
    await postDiscordMessage(context, message);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected original Discord conversation");
    }
    const originalInputs = currentInputs(await events(actor, thread.id));
    expect(originalInputs).toHaveLength(1);
    expect(originalInputs[0]?.runId).toStrictEqual(expect.any(String));
    await accept(
      setupApp({ context, routes: integrationsDiscordRoutes })(
        integrationsDiscordContract,
      ).disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );
    const reinstalled = await seedDiscordFixture(context, {
      userId: actor.userId,
      orgId: actor.orgId,
      orgRole: "org:admin",
      guildId: actor.guildId,
      guildName: "Discord test guild",
      botUserId: actor.botUserId,
      discordUserId: actor.discordUserId,
    });
    expect(reinstalled.connectionId).not.toBe(actor.connectionId);
    expect(
      (
        await postDiscordMessage(
          context,
          message,
          `reinstall-replay:${message.id}`,
        )
      ).body.outcome,
    ).toBe("duplicate");
    await flushWaitUntilForTest();
    const afterReplay = await discordChatThreads(context, actor);
    expect(
      afterReplay.map((current) => {
        return current.id;
      }),
    ).toStrictEqual([thread.id]);
    expect(currentInputs(await events(actor, thread.id))).toStrictEqual(
      originalInputs,
    );
  });

  it("keeps native guild routes sticky while a changed DM model starts a new session without earlier DM history", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const first = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> start a guild task`,
    });
    provider.messages.set(first.id, first);
    await postDiscordMessage(context, first);
    await flushWaitUntilForTest();
    const [guildThread] = await discordChatThreads(context, actor);
    if (!guildThread) {
      throw new Error("Expected guild thread");
    }
    const { providerId } = await runsApi.ensureOrgModelProvider(actor.actor, {
      model: "claude-fable-5-1",
    });
    await runsApi.updateOrgModelPolicies(actor.actor, [
      {
        model: "claude-fable-5-1",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-opus-5",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      "org:admin",
    );
    const preferences = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    await accept(
      preferences.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { selectedModel: "claude-opus-5", serviceTier: null },
      }),
      [200],
    );
    const followup = discordMessageForTest(actor, {
      channelId: first.id,
      content: `<@${actor.botUserId}> continue the guild task`,
    });
    provider.messages.set(followup.id, followup);
    await postDiscordMessage(context, followup);
    await flushWaitUntilForTest();
    const sticky = await discordChatThreads(context, actor);
    expect(sticky).toHaveLength(1);
    expect(sticky[0]).toMatchObject({
      id: guildThread.id,
      agentId: guildThread.agentId,
      selectedModel: guildThread.selectedModel,
    });
    expect(currentInputs(await events(actor, guildThread.id))).toHaveLength(2);

    const dm = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "start a DM with the selected model",
    });
    provider.messages.set(dm.id, dm);
    await postDiscordMessage(context, dm);
    await flushWaitUntilForTest();
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      "org:admin",
    );
    await accept(
      preferences.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { selectedModel: "claude-fable-5-1", serviceTier: null },
      }),
      [200],
    );
    const nextDm = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "use the other DM session",
    });
    botReplyBefore(
      actor,
      provider,
      nextDm,
      "Opus session answer: ship on Friday",
    );
    provider.messages.set(nextDm.id, nextDm);
    await postDiscordMessage(context, nextDm);
    await flushWaitUntilForTest();
    const dmThreads = (await discordChatThreads(context, actor)).filter(
      (thread) => {
        return thread.id !== guildThread.id;
      },
    );
    expect(dmThreads).toHaveLength(2);
    expect(
      dmThreads
        .map((thread) => {
          return thread.selectedModel;
        })
        .sort(),
    ).toStrictEqual(["claude-fable-5-1", "claude-opus-5"]);
    const nextSession = dmThreads.find((thread) => {
      return thread.selectedModel === "claude-fable-5-1";
    });
    if (!nextSession) {
      throw new Error("Expected the changed DM session");
    }
    const run = await launchedRun(actor, nextSession.id);
    expect(run.prompt).toBe(nextDm.content);
    expect(run.appendSystemPrompt).not.toContain("ship on Friday");
    expect(run.appendSystemPrompt).not.toContain(dm.content);
    expect(run.appendSystemPrompt).not.toContain("Prior Discord Messages");
  });

  it("keeps another organization's DM replies out of a newly selected organization's run", async () => {
    const first = await connected();
    const provider = mockDiscordProvider(first);
    const second = await track(
      setupConnectedDiscordActor(context, {
        userId: first.userId,
        discordUserId: first.discordUserId,
      }),
    );
    provider.guildIds.add(second.guildId);
    mockDiscordMemberships(context, [
      { userId: first.userId, orgId: first.orgId, orgRole: "org:admin" },
      { userId: second.userId, orgId: second.orgId, orgRole: "org:admin" },
    ]);
    // DM content never depends on the guild MESSAGE_CONTENT intent.
    mockEnv("DISCORD_MESSAGE_CONTENT_ENABLED", "true");
    await selectDmOrganization(first);
    const firstDm = discordMessageForTest(first, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "summarize the first organization's pipeline",
    });
    provider.messages.set(firstDm.id, firstDm);
    await postDiscordMessage(context, firstDm);
    await flushWaitUntilForTest();
    await expect(discordChatThreads(context, first)).resolves.toHaveLength(1);

    await selectDmOrganization(second);
    const secondDm = discordMessageForTest(second, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "hi",
    });
    botReplyBefore(
      first,
      provider,
      secondDm,
      "First organization pipeline: 42 open deals",
    );
    provider.messages.set(secondDm.id, secondDm);
    await postDiscordMessage(context, secondDm);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, second);
    if (!thread) {
      throw new Error("Expected the second organization's DM chat");
    }
    const run = await launchedRun(second, thread.id);
    expect(run.prompt).toBe("hi");
    expect(run.appendSystemPrompt).not.toContain("42 open deals");
    expect(run.appendSystemPrompt).not.toContain(firstDm.content);
    expect(run.appendSystemPrompt).not.toContain("Prior Discord Messages");
  });

  it("requires explicit DM org choice and keeps a replay bound to its original org", async () => {
    const first = await connected();
    const provider = mockDiscordProvider(first);
    const second = await track(
      setupConnectedDiscordActor(context, {
        userId: first.userId,
        discordUserId: first.discordUserId,
      }),
    );
    provider.guildIds.add(second.guildId);
    mockDiscordMemberships(context, [
      { userId: first.userId, orgId: first.orgId, orgRole: "org:admin" },
      { userId: second.userId, orgId: second.orgId, orgRole: "org:admin" },
    ]);
    const message = discordMessageForTest(first, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "keep this task in the selected organization",
    });
    provider.messages.set(message.id, message);
    expect((await postDiscordMessage(context, message)).body.outcome).toBe(
      "ignored",
    );
    await selectDmOrganization(first);
    expect((await postDiscordMessage(context, message)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();
    await selectDmOrganization(second);
    expect(
      (
        await postDiscordMessage(
          context,
          message,
          `response-lost:${message.id}`,
        )
      ).body.outcome,
    ).toBe("duplicate");
    await flushWaitUntilForTest();
    await expect(discordChatThreads(context, first)).resolves.toHaveLength(1);
    await expect(discordChatThreads(context, second)).resolves.toHaveLength(0);
    const newMessage = discordMessageForTest(second, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "start in the newly selected organization",
    });
    provider.messages.set(newMessage.id, newMessage);
    await postDiscordMessage(context, newMessage);
    await flushWaitUntilForTest();
    await expect(discordChatThreads(context, second)).resolves.toHaveLength(1);
  });

  it("imports refreshed attachment metadata while keeping context and signed URLs private", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    mockEnv("DISCORD_MESSAGE_CONTENT_ENABLED", "true");
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.DiscordIntegration]: true,
      [FeatureSwitchKey.PrivateArtifacts]: true,
    });
    const objects = new Map<
      string,
      {
        readonly body: Uint8Array;
        readonly contentType: string;
        readonly metadata: Record<string, string>;
      }
    >();
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (
        command instanceof PutObjectCommand &&
        command.input.Body instanceof Uint8Array
      ) {
        objects.set(`${command.input.Bucket}/${command.input.Key}`, {
          body: command.input.Body,
          contentType: command.input.ContentType ?? "application/octet-stream",
          metadata: command.input.Metadata ?? {},
        });
        return Promise.resolve({});
      }
      if (
        command instanceof GetObjectCommand ||
        command instanceof HeadObjectCommand
      ) {
        const object = objects.get(
          `${command.input.Bucket}/${command.input.Key}`,
        );
        if (object) {
          return Promise.resolve({
            ContentLength: object.body.byteLength,
            ContentType: object.contentType,
            Metadata: object.metadata,
            Body: {
              async *[Symbol.asyncIterator]() {
                yield object.body;
              },
            },
          });
        }
      }
      return Promise.resolve({ ContentLength: 1024 });
    });
    const attachmentId = uniqueDiscordSnowflake();
    const originalUrl = `https://cdn.discordapp.com/attachments/${provider.guildChannelId}/${attachmentId}/notes.txt?ex=expired-private`;
    const refreshedUrl = `https://cdn.discordapp.com/attachments/${provider.guildChannelId}/${attachmentId}/notes.txt?ex=fresh-private`;
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> summarize the attachment`,
      attachments: [
        {
          id: attachmentId,
          filename: "notes.txt",
          size: 5,
          content_type: "text/plain",
          url: originalUrl,
        },
      ],
    });
    provider.messages.set(message.id, {
      ...message,
      attachments: [
        {
          id: attachmentId,
          filename: "notes.txt",
          size: 5,
          content_type: "text/plain",
          url: originalUrl,
        },
      ],
    });
    for (let index = 1; index <= 25; index++) {
      const history = discordMessageForTest(actor, {
        id: (BigInt(message.id) - BigInt(index)).toString(),
        channelId: provider.guildChannelId,
        content: `private-history-${index}:` + "x".repeat(2000),
      });
      provider.messages.set(history.id, history);
    }
    server.use(
      http.get(
        `https://cdn.discordapp.com/attachments/${provider.guildChannelId}/${attachmentId}/notes.txt`,
        ({ request }) => {
          if (new URL(request.url).searchParams.get("ex") === "fresh-private") {
            return new HttpResponse("notes", {
              headers: {
                "content-type": "text/plain",
                "content-length": "5",
              },
            });
          }
          provider.messages.set(message.id, {
            ...message,
            attachments: [
              {
                id: attachmentId,
                filename: "notes.txt",
                size: 5,
                content_type: "text/plain",
                url: refreshedUrl,
              },
            ],
          });
          return new HttpResponse(null, { status: 403 });
        },
      ),
    );
    await postDiscordMessage(context, message);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected imported Discord input");
    }
    const projected = await events(actor, thread.id);
    const [input] = currentInputs(projected);
    expect(input?.userMessage.parts).toContainEqual(
      expect.objectContaining({
        type: "file",
        filenameSnapshot: "notes.txt",
        contentType: "text/plain",
      }),
    );
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("private-history-");
    expect(serialized).not.toContain("expired-private");
    expect(serialized).not.toContain("fresh-private");
    const attachedFile = input?.userMessage.parts.find((part) => {
      return part.type === "file";
    });
    if (!attachedFile) {
      throw new Error("Expected canonical attachment");
    }
    const downloaded = await accept(
      setupApp({ context, routes: webDownloadRoutes })(
        webFilesContract,
      ).download({
        headers: { authorization: "Bearer clerk-session" },
        query: { file_id: attachedFile.fileId },
      }),
      [200],
    );
    // The HTTP client decodes text/plain assets as text.
    expect(downloaded.body).toBe("notes");
    if (!input?.runId) {
      throw new Error("Expected run with canonical file input");
    }
    await runsApi.heartbeatRunner(actor.runnerGroup);
    const claim = await runsApi.claimRunnerJob(input.runId);
    expect(claim.prompt).toContain("[Web file] notes.txt");
    expect(claim.appendSystemPrompt).toContain("private-history-1:");
    expect(claim.appendSystemPrompt).not.toContain("private-history-25:");
    expect(claim.appendSystemPrompt).toContain("untrusted");
  });

  function textAttachment(
    channelId: string,
    filename: string,
  ): ReturnType<typeof discordMessageForTest>["attachments"][number] {
    const id = uniqueDiscordSnowflake();
    return {
      id,
      filename,
      size: 5,
      content_type: "text/plain",
      url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/${filename}`,
    };
  }

  it("imports a mention's own file when the sender cannot read message history", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    // Discord wire bits VIEW_CHANNEL | SEND_MESSAGES | CREATE_PUBLIC_THREADS |
    // SEND_MESSAGES_IN_THREADS, without READ_MESSAGE_HISTORY.
    provider.state.everyonePermissions = "309237648384";
    const attachment = textAttachment(provider.guildChannelId, "own.txt");
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> read my file`,
      attachments: [attachment],
    });
    provider.messages.set(message.id, message);
    server.use(
      http.get(attachment.url, () => {
        return new HttpResponse("notes", {
          headers: { "content-type": "text/plain", "content-length": "5" },
        });
      }),
    );
    expect((await postDiscordMessage(context, message)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected the mention with a file to be admitted");
    }
    const [input] = currentInputs(await events(actor, thread.id));
    expect(input?.userMessage.parts).toContainEqual(
      expect.objectContaining({
        type: "file",
        filenameSnapshot: "own.txt",
        contentType: "text/plain",
      }),
    );
    if (!input?.runId) {
      throw new Error("Expected a run for the admitted file mention");
    }
    await runsApi.heartbeatRunner(actor.runnerGroup);
    const claim = await runsApi.claimRunnerJob(input.runId);
    expect(claim.prompt).toContain("[Web file] own.txt");
    // Only the admission notice path posts; this request was not dropped.
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("keeps a file mention with a failed file when Okou cannot read message history", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const base = "https://discord.com/api/v10";
    const botRoleId = uniqueDiscordSnowflake();
    server.use(
      http.get(`${base}/guilds/${actor.guildId}/roles`, () => {
        return HttpResponse.json([
          { id: actor.guildId, name: "@everyone", permissions: "8" },
          // VIEW_CHANNEL | SEND_MESSAGES | CREATE_PUBLIC_THREADS |
          // SEND_MESSAGES_IN_THREADS, without READ_MESSAGE_HISTORY.
          { id: botRoleId, name: "Okou", permissions: "309237648384" },
        ]);
      }),
      http.get(
        `${base}/guilds/${actor.guildId}/members/:userId`,
        ({ params }) => {
          const userId = String(params.userId);
          const isBot = userId === actor.botUserId;
          return HttpResponse.json({
            user: {
              id: userId,
              username: isBot ? "Okou" : "member",
              bot: isBot,
            },
            roles: isBot ? [botRoleId] : [],
          });
        },
      ),
    );
    const attachment = textAttachment(provider.guildChannelId, "hidden.txt");
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> summarize this`,
      attachments: [attachment],
    });
    provider.messages.set(message.id, message);
    // Discord's answer when the bot may not read the channel's messages.
    provider.state.messageResponse = (messageId) => {
      return messageId === message.id
        ? HttpResponse.json(
            { message: "Missing Access", code: 50_001 },
            { status: 403 },
          )
        : undefined;
    };
    let cdnRequests = 0;
    server.use(
      http.get(attachment.url, () => {
        cdnRequests++;
        return new HttpResponse("notes", {
          headers: { "content-type": "text/plain", "content-length": "5" },
        });
      }),
    );
    await postDiscordMessage(context, message);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected the mention to be admitted");
    }
    const [input] = currentInputs(await events(actor, thread.id));
    expect(input?.runId).toStrictEqual(expect.any(String));
    expect(JSON.stringify(input?.userMessage.parts)).toContain("hidden.txt");
    // The unauthorized refresh never downloads the file bytes.
    expect(cdnRequests).toBe(0);
  });

  it("admits a Nitro-length mention of more than 100 users that includes Okou", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const others = Array.from({ length: 120 }, (_, index) => {
      return { id: uniqueDiscordSnowflake(), username: `member${index}` };
    });
    const base = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> ${others
        .map((user) => {
          return `<@${user.id}>`;
        })
        .join(" ")} plan the offsite`,
    });
    const message = {
      ...base,
      mentions: [...base.mentions, ...others],
    };
    expect(message.mentions.length).toBeGreaterThan(100);
    provider.messages.set(message.id, message);
    expect((await postDiscordMessage(context, message)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected the many-mention message to be admitted");
    }
    const [input] = currentInputs(await events(actor, thread.id));
    expect(input?.runId).toStrictEqual(expect.any(String));
    expect(input?.userMessage.parts).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("@member119 plan the offsite"),
      }),
    );
  });

  it("recovers a transient provider failure through the connection-scoped sweep", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    mockEnv("DISCORD_MESSAGE_CONTENT_ENABLED", "true");
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> recover this admitted task`,
    });
    provider.messages.set(message.id, message);
    mockNow(now());
    provider.state.historyResponse = () => {
      return new HttpResponse(null, { status: 503 });
    };
    await postDiscordMessage(context, message);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error(
        "Expected durable route before temporary context failure",
      );
    }
    expect(
      (await events(actor, thread.id)).filter((event) => {
        return event.eventType === "input.prompt";
      }),
    ).toHaveLength(0);
    provider.state.historyResponse = undefined;
    mockNow(now() + 61_000);
    await recover(actor);
    const inputs = currentInputs(await events(actor, thread.id));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.runId).toStrictEqual(expect.any(String));
  });

  it("honors source permission Retry-After before retrying signed Gateway ingress", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const channel = provider.channels.get(provider.guildChannelId);
    if (!channel) {
      throw new Error("Expected the source guild channel fixture");
    }
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> resume after the permission cooldown`,
    });
    provider.messages.set(message.id, message);
    let lookups = 0;
    let rateLimited = true;
    server.use(
      http.get(
        `https://discord.com/api/v10/channels/${provider.guildChannelId}`,
        () => {
          lookups++;
          return rateLimited
            ? HttpResponse.json(
                { message: "Rate limited", retry_after: 300, global: false },
                { status: 429, headers: { "Retry-After": "300" } },
              )
            : HttpResponse.json(channel);
        },
      ),
    );
    mockNow(now());
    await postDiscordMessage(context, message);
    await flushWaitUntilForTest();
    expect(lookups).toBe(1);
    await expect(discordChatThreads(context, actor)).resolves.toHaveLength(0);

    rateLimited = false;
    mockNow(now() + 299_000);
    await recover(actor);
    expect(lookups).toBe(1);
    await expect(discordChatThreads(context, actor)).resolves.toHaveLength(0);

    mockNow(now() + 2000);
    await recover(actor);
    expect(lookups).toBeGreaterThan(1);
    const threads = await discordChatThreads(context, actor);
    expect(threads).toHaveLength(1);
    const [thread] = threads;
    if (!thread) {
      throw new Error("Expected the recovered Discord chat");
    }
    const inputs = currentInputs(await events(actor, thread.id));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.runId).toStrictEqual(expect.any(String));
  });

  it("keeps accepted ingress retryable while app configuration is missing", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const channel = provider.channels.get(provider.guildChannelId);
    if (!channel) {
      throw new Error("Expected the source guild channel fixture");
    }
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> survive a configuration outage`,
    });
    provider.messages.set(message.id, message);
    let rateLimited = true;
    server.use(
      http.get(
        `https://discord.com/api/v10/channels/${provider.guildChannelId}`,
        () => {
          return rateLimited
            ? HttpResponse.json(
                { message: "Rate limited", retry_after: 1, global: false },
                { status: 429, headers: { "Retry-After": "1" } },
              )
            : HttpResponse.json(channel);
        },
      ),
    );
    mockNow(now());
    expect((await postDiscordMessage(context, message)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();
    await expect(discordChatThreads(context, actor)).resolves.toHaveLength(0);

    rateLimited = false;
    mockEnv("DISCORD_BOT_TOKEN", undefined);
    for (let sweep = 0; sweep < 6; sweep++) {
      mockNow(now() + 3 * 60 * 60 * 1000);
      await expect(recover(actor)).resolves.toMatchObject({
        body: { processed: 0 },
      });
    }
    await expect(discordChatThreads(context, actor)).resolves.toHaveLength(0);
    expect(provider.sentMessages).toHaveLength(0);

    mockEnv("DISCORD_BOT_TOKEN", "discord-test-bot-token");
    mockNow(now() + 61_000);
    await recover(actor);
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected the admitted Discord chat after recovery");
    }
    const inputs = currentInputs(await events(actor, thread.id));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.runId).toStrictEqual(expect.any(String));
  });

  it("retries a temporary CDN failure before admitting the canonical file input", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const attachmentId = uniqueDiscordSnowflake();
    const url = `https://cdn.discordapp.com/attachments/${provider.dmChannelId}/${attachmentId}/retry.txt`;
    const message = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "wait for the complete attachment",
      attachments: [
        {
          id: attachmentId,
          filename: "retry.txt",
          size: 5,
          content_type: "text/plain",
          url,
        },
      ],
    });
    provider.messages.set(message.id, message);
    let available = false;
    server.use(
      http.get(url, () => {
        return available
          ? new HttpResponse("notes", {
              headers: {
                "content-type": "text/plain",
                "content-length": "5",
              },
            })
          : new HttpResponse(null, { status: 503 });
      }),
    );
    mockNow(now());
    await postDiscordMessage(context, message);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected durable route before CDN recovery");
    }
    await expect(events(actor, thread.id)).resolves.toHaveLength(0);
    available = true;
    mockNow(now() + 61_000);
    await recover(actor);
    const inputs = currentInputs(await events(actor, thread.id));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.userMessage.parts).toContainEqual(
      expect.objectContaining({
        type: "file",
        filenameSnapshot: "retry.txt",
        contentType: "text/plain",
      }),
    );
    expect(inputs[0]?.runId).toStrictEqual(expect.any(String));
    await recover(actor);
    expect(currentInputs(await events(actor, thread.id))).toHaveLength(1);
  });

  it.each(["access", "metadata"] as const)(
    "preserves Retry-After from expired attachment %s refresh through canonical import",
    async (limitedRefresh) => {
      const actor = await connected();
      const provider = mockDiscordProvider(actor);
      const channel = provider.channels.get(provider.dmChannelId);
      if (!channel) {
        throw new Error("Expected the DM channel fixture");
      }
      const attachmentId = uniqueDiscordSnowflake();
      const attachmentPath = `https://cdn.discordapp.com/attachments/${provider.dmChannelId}/${attachmentId}/refresh.txt`;
      const originalUrl = `${attachmentPath}?ex=expired`;
      const refreshedUrl = `${attachmentPath}?ex=fresh`;
      const message = discordMessageForTest(actor, {
        channelId: provider.dmChannelId,
        guild: false,
        content: "wait for the expired attachment refresh cooldown",
        attachments: [
          {
            id: attachmentId,
            filename: "refresh.txt",
            size: 5,
            url: originalUrl,
          },
        ],
      });
      provider.messages.set(message.id, message);
      let expiredUrlFetched = false;
      let rateLimited = true;
      const attempts = { access: 0, metadata: 0, download: 0 };
      server.use(
        http.get(
          `https://discord.com/api/v10/channels/${provider.dmChannelId}`,
          () => {
            attempts.access++;
            if (
              expiredUrlFetched &&
              rateLimited &&
              limitedRefresh === "access"
            ) {
              return HttpResponse.json(
                { message: "Rate limited", retry_after: 300, global: false },
                { status: 429, headers: { "Retry-After": "300" } },
              );
            }
            return HttpResponse.json(channel);
          },
        ),
        http.get(
          `https://discord.com/api/v10/channels/${provider.dmChannelId}/messages/${message.id}`,
          () => {
            attempts.metadata++;
            if (
              expiredUrlFetched &&
              rateLimited &&
              limitedRefresh === "metadata"
            ) {
              return HttpResponse.json(
                { message: "Rate limited", retry_after: 300, global: false },
                { status: 429, headers: { "Retry-After": "300" } },
              );
            }
            return HttpResponse.json({
              ...message,
              attachments: message.attachments.map((attachment) => {
                return {
                  ...attachment,
                  url: expiredUrlFetched ? refreshedUrl : originalUrl,
                };
              }),
            });
          },
        ),
        http.get(attachmentPath, ({ request }) => {
          attempts.download++;
          if (new URL(request.url).searchParams.get("ex") === "expired") {
            expiredUrlFetched = true;
            return new HttpResponse(null, { status: 403 });
          }
          // Missing metadata MIME must preserve the validated CDN header,
          // even when it differs from the type suggested by the filename.
          return new HttpResponse("a,b\n1", {
            headers: { "content-type": "text/csv", "content-length": "5" },
          });
        }),
      );
      mockNow(now());
      await postDiscordMessage(context, message);
      await flushWaitUntilForTest();
      expect(attempts.download).toBe(1);
      expect(attempts.metadata).toBe(limitedRefresh === "metadata" ? 2 : 1);
      const [thread] = await discordChatThreads(context, actor);
      if (!thread) {
        throw new Error(
          "Expected a retained route while attachment refresh waits",
        );
      }
      await expect(events(actor, thread.id)).resolves.toHaveLength(0);
      const initialAttempts = { ...attempts };

      rateLimited = false;
      mockNow(now() + 299_000);
      await recover(actor);
      expect(attempts).toStrictEqual(initialAttempts);
      await expect(events(actor, thread.id)).resolves.toHaveLength(0);

      mockNow(now() + 2000);
      await recover(actor);
      expect(attempts.download).toBe(2);
      const inputs = currentInputs(await events(actor, thread.id));
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.userMessage.parts).toContainEqual(
        expect.objectContaining({
          type: "file",
          filenameSnapshot: "refresh.txt",
          contentType: "text/csv",
        }),
      );
      expect(inputs[0]?.runId).toStrictEqual(expect.any(String));
    },
  );

  it("records one canonical admission error when the finite retry budget is exhausted", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    mockEnv("DISCORD_MESSAGE_CONTENT_ENABLED", "true");
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> report this task if Discord never recovers`,
    });
    provider.messages.set(message.id, message);
    provider.state.historyResponse = () => {
      return new HttpResponse(null, { status: 503 });
    };
    mockNow(now());
    await postDiscordMessage(context, message);
    await flushWaitUntilForTest();
    for (const delay of [61_000, 301_000, 1_501_000, 7_501_000]) {
      mockNow(now() + delay);
      await recover(actor);
    }
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected retained chat for terminal admission failure");
    }
    const failed = await events(actor, thread.id);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      eventType: "output.error",
      content: "I couldn't process this Discord message. Please send it again.",
      error: "I couldn't process this Discord message. Please send it again.",
    });
    expect(failed[0]?.runId).toBeUndefined();
    provider.state.historyResponse = undefined;
    await postDiscordMessage(
      context,
      message,
      `exhausted-replay:${message.id}`,
    );
    await recover(actor);
    await flushWaitUntilForTest();
    await expect(events(actor, thread.id)).resolves.toStrictEqual(failed);
  });

  it("fences a stale processor when recovery commits the same input first", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    mockEnv("DISCORD_MESSAGE_CONTENT_ENABLED", "true");
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> one canonical input after a stale lease`,
    });
    provider.messages.set(message.id, message);
    const reading = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
    });
    let reads = 0;
    provider.state.historyResponse = async () => {
      reads++;
      if (reads === 1) {
        reading.resolve(undefined);
        await release.promise;
      }
      return undefined;
    };
    mockNow(now());
    let processing: Promise<void> | undefined;
    const result = await settleIncludingAbort(
      (async () => {
        await postDiscordMessage(context, message);
        processing = flushWaitUntilForTest();
        await Promise.race([
          reading.promise,
          processing.then(() => {
            if (!reading.settled()) {
              throw new Error(
                "Discord processing ended before reading history",
              );
            }
          }),
        ]);
        mockNow(now() + 5 * 60_000 + 1);
        await recover(actor);
      })(),
    );
    if (!release.settled()) {
      release.resolve(undefined);
    }
    await processing;
    if (!result.ok) {
      throw result.error;
    }
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected one recovered thread");
    }
    const inputs = currentInputs(await events(actor, thread.id));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.runId).toStrictEqual(expect.any(String));
  });

  it("suppresses input and delivery when the sender disconnects during context import", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const reading = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
    });
    provider.state.historyResponse = async () => {
      reading.resolve(undefined);
      await release.promise;
      return undefined;
    };
    mockEnv("DISCORD_MESSAGE_CONTENT_ENABLED", "true");
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> do not launch after disconnect`,
    });
    provider.messages.set(message.id, message);
    let processing: Promise<void> | undefined;
    const result = await settleIncludingAbort(
      (async () => {
        await postDiscordMessage(context, message);
        processing = flushWaitUntilForTest();
        await Promise.race([
          reading.promise,
          processing.then(() => {
            if (!reading.settled()) {
              throw new Error(
                "Discord processing ended before reading history",
              );
            }
          }),
        ]);
        createRouteMocks(context).clerk.session(
          actor.userId,
          actor.orgId,
          "org:admin",
        );
        await accept(
          setupApp({ context, routes: integrationsDiscordRoutes })(
            integrationsDiscordContract,
          ).disconnect({
            headers: { authorization: "Bearer clerk-session" },
            query: {},
          }),
          [200],
        );
      })(),
    );
    if (!release.settled()) {
      release.resolve(undefined);
    }
    await processing;
    if (!result.ok) {
      throw result.error;
    }
    await flushWaitUntilForTest();
    for (const thread of await discordChatThreads(context, actor)) {
      expect(
        (await events(actor, thread.id)).filter((event) => {
          return event.eventType === "input.prompt";
        }),
      ).toHaveLength(0);
    }
    expect(provider.sentMessages).toHaveLength(0);
  });
});
