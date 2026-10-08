import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { revokedChatEventIds } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { integrationsDiscordMessageContract } from "@okouai/api-contracts/contracts/integrations-discord-message";
import { integrationsDiscordReadContract } from "@okouai/api-contracts/contracts/integrations-discord-read";
import { z } from "zod";
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
import { seedLegacyPrivateDefaultAgentFixture } from "../../../test-fixtures/legacy-default-agent";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { integrationsDiscordMessageRoutes } from "../integrations-discord-message";
import { integrationsDiscordReadRoutes } from "../integrations-discord-read";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webDownloadRoutes } from "../web-download";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
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

async function claimMessage(
  actor: ConnectedDiscordActor,
  message: ReturnType<typeof discordMessageForTest>,
) {
  await postDiscordMessage(context, message);
  await flushWaitUntilForTest();
  const [thread] = await discordChatThreads(context, actor);
  if (!thread) {
    throw new Error("Expected a Discord thread");
  }
  const [input] = currentInputs(await events(actor, thread.id));
  if (!input?.runId) {
    throw new Error("Expected a launched Discord run");
  }
  await runsApi.heartbeatRunner(actor.runnerGroup);
  return {
    input,
    runId: input.runId,
    claim: await runsApi.claimRunnerJob(input.runId),
  };
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
  it.each([true, false])(
    "copies the Chat browser preference (%s) into new threads without changing existing routes",
    async (enabled) => {
      const actor = await connected();
      const provider = mockDiscordProvider(actor);
      const preferences = createMiscRoutesApi(context);
      const chat = createChatFilesBddApi(context);
      await preferences.updatePreferences(
        actor.actor,
        { cloudBrowserEnabledByDefault: enabled },
        [200],
      );
      const first = discordMessageForTest(actor, {
        channelId: provider.guildChannelId,
        content: `<@${actor.botUserId}> start with my browser preference`,
      });
      provider.messages.set(first.id, first);
      await postDiscordMessage(context, first);
      await flushWaitUntilForTest();
      const [guildThread] = await discordChatThreads(context, actor);
      if (!guildThread) {
        throw new Error("Expected the guild thread");
      }
      expect(guildThread.cloudBrowserEnabled).toBe(enabled);
      await expect(
        chat.readThreadMetadata(actor.actor, guildThread.id),
      ).resolves.toMatchObject({ cloudBrowserEnabled: enabled });
      const firstRun = await launchedRun(actor, guildThread.id);
      await runsApi.requestCancelRun(actor.actor, firstRun.runId, [200]);
      await flushWaitUntilForTest();

      await preferences.updatePreferences(
        actor.actor,
        { cloudBrowserEnabledByDefault: !enabled },
        [200],
      );
      const followup = discordMessageForTest(actor, {
        channelId: first.id,
        content: `<@${actor.botUserId}> continue the same task`,
      });
      provider.messages.set(followup.id, followup);
      await postDiscordMessage(context, followup);
      await flushWaitUntilForTest();
      await expect(
        chat.readThreadMetadata(actor.actor, guildThread.id),
      ).resolves.toMatchObject({ cloudBrowserEnabled: enabled });

      const dm = discordMessageForTest(actor, {
        channelId: provider.dmChannelId,
        guild: false,
        content: "start a new task with the updated browser preference",
      });
      provider.messages.set(dm.id, dm);
      await postDiscordMessage(context, dm);
      await flushWaitUntilForTest();
      const dmThread = (await discordChatThreads(context, actor)).find(
        (thread) => {
          return thread.id !== guildThread.id;
        },
      );
      if (!dmThread) {
        throw new Error("Expected the new DM thread");
      }
      expect(dmThread.cloudBrowserEnabled).toBe(!enabled);
      await expect(
        chat.readThreadMetadata(actor.actor, dmThread.id),
      ).resolves.toMatchObject({ cloudBrowserEnabled: !enabled });
    },
  );

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
      for (const thread of await discordChatThreads(context, actor)) {
        await expect(events(actor, thread.id)).resolves.toHaveLength(0);
      }
      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]).toMatchObject({
        channel_id: provider.guildChannelId,
        content:
          "I couldn't process this Discord message. Please send it again.",
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
    const inputs = [];
    for (const thread of await discordChatThreads(context, actor)) {
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

  it("pins guild and DM models when each thread is created", async () => {
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
    await runsApi.ensurePersonalSubscriptionModel(actor.actor, {
      model: "claude-fable-5-1",
    });
    await createBddIntegrationApi(context).configureNativeSubscriptionModels(
      actor.actor,
    );
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
        body: { selectedModel: "claude-opus-5-5", serviceTier: null },
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
    const originalDm = (await discordChatThreads(context, actor)).find(
      (thread) => {
        return thread.id !== guildThread.id;
      },
    );
    if (!originalDm) {
      throw new Error("Expected the main DM thread");
    }
    const originalDmRun = await launchedRun(actor, originalDm.id);
    await runsApi.requestCancelRun(actor.actor, originalDmRun.runId, [200]);
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
    expect(dmThreads).toMatchObject([
      { id: originalDm.id, selectedModel: "claude-opus-5-5" },
    ]);
    const inputs = currentInputs(await events(actor, originalDm.id));
    expect(inputs).toHaveLength(2);
    const nextInput = inputs.find((input) => {
      return input.userMessage.parts.some((part) => {
        return part.type === "text" && part.text === nextDm.content;
      });
    });
    if (!nextInput?.runId) {
      throw new Error("Expected the next DM input to launch");
    }
    await runsApi.heartbeatRunner(actor.runnerGroup);
    const claim = await runsApi.claimRunnerJob(nextInput.runId);
    expect(claim.prompt).toBe(nextDm.content);
    expect(claim.modelUsageProvider).toBe("claude-opus-5-5");
    expect(claim.appendSystemPrompt).not.toContain("ship on Friday");
    await runsApi.requestCancelRun(actor.actor, nextInput.runId, [200]);
  });

  it("keeps the same DM thread when its connected sender moves to a new physical channel", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const first = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "start in the original DM channel",
    });
    provider.messages.set(first.id, first);
    await postDiscordMessage(context, first);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected the original DM thread");
    }
    const firstRun = await launchedRun(actor, thread.id);
    await runsApi.requestCancelRun(actor.actor, firstRun.runId, [200]);
    await flushWaitUntilForTest();

    const channelId = uniqueDiscordSnowflake();
    provider.channels.set(channelId, {
      id: channelId,
      type: 1,
      recipients: [{ id: actor.discordUserId, username: "member" }],
    });
    provider.channels.delete(provider.dmChannelId);
    const next = discordMessageForTest(actor, {
      channelId,
      guild: false,
      content: "continue in the current DM channel",
    });
    provider.messages.set(next.id, next);
    await postDiscordMessage(context, next);
    await flushWaitUntilForTest();

    await expect(discordChatThreads(context, actor)).resolves.toMatchObject([
      { id: thread.id, selectedModel: "claude-fable-5-1" },
    ]);
    const inputs = currentInputs(await events(actor, thread.id));
    expect(inputs).toHaveLength(2);
    const input = inputs.find((candidate) => {
      return candidate.userMessage.parts.some((part) => {
        return part.type === "text" && part.text === next.content;
      });
    });
    expect(input?.userMessage.parts).toContainEqual({
      type: "source",
      kind: "discord",
      href: `https://discord.com/channels/@me/${channelId}/${next.id}`,
    });
    if (!input?.runId) {
      throw new Error("Expected the current DM input to launch");
    }
    await runsApi.heartbeatRunner(actor.runnerGroup);
    const claim = await runsApi.claimRunnerJob(input.runId);
    expect(claim.prompt).toBe(next.content);
    await runsApi.requestCancelRun(actor.actor, input.runId, [200]);
  });

  it("updates the main DM thread model without changing the member default", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const chatApi = createChatFilesBddApi(context);
    const first = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "start the main DM",
    });
    provider.messages.set(first.id, first);
    await postDiscordMessage(context, first);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected the main DM thread");
    }
    const firstRun = await launchedRun(actor, thread.id);
    await runsApi.requestCancelRun(actor.actor, firstRun.runId, [200]);
    await flushWaitUntilForTest();

    await createBddIntegrationApi(context).configureNativeSubscriptionModels(
      actor.actor,
    );
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    const preferenceBefore = await accept(
      preferenceClient.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await chatApi.updateThreadModelSelection(
      actor.actor,
      thread.id,
      "gpt-6-astra",
      { codexServiceTier: "fast" },
    );
    await expect(
      chatApi.readThreadMetadata(actor.actor, thread.id),
    ).resolves.toMatchObject({
      selectedModel: "gpt-6-astra",
      serviceTier: "priority",
    });
    await expect(discordChatThreads(context, actor)).resolves.toMatchObject([
      { id: thread.id, selectedModel: "gpt-6-astra", serviceTier: "priority" },
    ]);
    const preference = await accept(
      preferenceClient.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(preference.body).toMatchObject({
      selectedModel: preferenceBefore.body.selectedModel,
      serviceTier: preferenceBefore.body.serviceTier,
    });

    const next = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "use the stored DM model",
    });
    provider.messages.set(next.id, next);
    await postDiscordMessage(context, next);
    await flushWaitUntilForTest();
    const input = currentInputs(await events(actor, thread.id)).find(
      (candidate) => {
        return candidate.userMessage.parts.some((part) => {
          return part.type === "text" && part.text === next.content;
        });
      },
    );
    if (!input?.runId) {
      throw new Error("Expected the DM input to launch with its stored model");
    }
    await runsApi.heartbeatRunner(actor.runnerGroup);
    const claim = await runsApi.claimRunnerJob(input.runId);
    expect(claim.modelUsageProvider).toBe("gpt-6-astra");
    expect(claim.platformEnvironment.OKOU_CODEX_SERVICE_TIER).toBe("fast");
    await runsApi.requestCancelRun(actor.actor, input.runId, [200]);
  });

  it("pins a busy main DM and captures a web send model before the next pick", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const chatApi = createChatFilesBddApi(context);
    const first = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "occupy the main DM while the web queues its next input",
    });
    provider.messages.set(first.id, first);
    await postDiscordMessage(context, first);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected the main DM thread");
    }
    const firstRun = await launchedRun(actor, thread.id);

    await createBddIntegrationApi(context).configureNativeSubscriptionModels(
      actor.actor,
    );
    const sent = await chatApi.requestSendEvent(
      actor.actor,
      {
        agentId: actor.defaultAgentId,
        threadId: thread.id,
        prompt: "continue the DM from the web using my new default",
        model: "gpt-6-astra",
        runOptions: { codexServiceTier: "fast" },
      },
      [201],
    );
    expect(sent.body).toMatchObject({ threadId: thread.id, runId: null });
    await flushWaitUntilForTest();
    const queued = currentInputs(await events(actor, thread.id));
    expect(queued).toHaveLength(2);
    expect(queued[1]?.runId).toBeUndefined();
    await expect(
      chatApi.readThreadMetadata(actor.actor, thread.id),
    ).resolves.toMatchObject({
      selectedModel: "gpt-6-astra",
      serviceTier: "priority",
    });
    await expect(discordChatThreads(context, actor)).resolves.toMatchObject([
      { id: thread.id, selectedModel: "gpt-6-astra", serviceTier: "priority" },
    ]);
    const preference = await accept(
      setupApp({ context, routes: userModelPreferenceRoutes })(
        userModelPreferenceContract,
      ).get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(preference.body).toMatchObject({
      selectedModel: "gpt-6-astra",
      serviceTier: "priority",
    });

    await runsApi.requestCancelRun(actor.actor, firstRun.runId, [200]);
    await flushWaitUntilForTest();
    const input = currentInputs(await events(actor, thread.id))[1];
    if (!input?.runId) {
      throw new Error("Expected the queued web input to launch");
    }
    await runsApi.heartbeatRunner(actor.runnerGroup);
    const claim = await runsApi.claimRunnerJob(input.runId);
    expect(claim.modelUsageProvider).toBe("gpt-6-astra");
    expect(claim.platformEnvironment.OKOU_CODEX_SERVICE_TIER).toBe("fast");
    await runsApi.requestCancelRun(actor.actor, input.runId, [200]);
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

  it("tells an unconnected DM sender how to connect about once an hour", async () => {
    const actor = await connected();
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

  it("asks a DM sender with several workspaces to choose one with /okou org", async () => {
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
    for (const content of ["which workspace is this?", "hello again"]) {
      const message = discordMessageForTest(first, {
        channelId: provider.dmChannelId,
        guild: false,
        content,
      });
      expect((await postDiscordMessage(context, message)).body.outcome).toBe(
        "ignored",
      );
      await flushWaitUntilForTest();
    }
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]).toMatchObject({
      channel_id: provider.dmChannelId,
      content: expect.stringContaining("/okou org"),
    });
    await expect(discordChatThreads(context, first)).resolves.toHaveLength(0);
    await expect(discordChatThreads(context, second)).resolves.toHaveLength(0);
  });

  it("sends no DM notice while the feature is off for the sender's workspace", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.DiscordIntegration]: false,
    });
    const message = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "is this available?",
    });
    expect((await postDiscordMessage(context, message)).body.outcome).toBe(
      "ignored",
    );
    await flushWaitUntilForTest();
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("tells a member without an accessible agent immediately", async () => {
    const owner = await connected();
    const provider = mockDiscordProvider(owner);
    const member = await track(
      setupConnectedDiscordActor(context, {
        orgId: owner.orgId,
        guildId: owner.guildId,
        reuseOrganization: true,
      }),
    );
    mockDiscordMemberships(context, [
      { userId: owner.userId, orgId: owner.orgId, orgRole: "org:admin" },
      { userId: member.userId, orgId: member.orgId, orgRole: "org:admin" },
    ]);
    await seedLegacyPrivateDefaultAgentFixture(owner.defaultAgentId);
    const message = discordMessageForTest(member, {
      channelId: provider.guildChannelId,
      content: `<@${member.botUserId}> summarize this channel`,
    });
    provider.messages.set(message.id, message);
    expect((await postDiscordMessage(context, message)).body.outcome).toBe(
      "accepted",
    );
    // Delivered by the admission itself, not by the recovery sweep.
    await flushWaitUntilForTest();
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]).toMatchObject({
      channel_id: provider.guildChannelId,
      content:
        "No accessible workspace default agent is configured. Ask a workspace admin to set one in Okou.",
    });
    await expect(discordChatThreads(context, member)).resolves.toHaveLength(0);
  });

  it("combines parent context, the thread starter, an older quoted message and attachment-only history within one bounded snapshot", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    mockEnv("DISCORD_MESSAGE_CONTENT_ENABLED", "true");
    const threadId = uniqueDiscordSnowflake();
    const nextId = (BigInt(threadId) + 1000n).toString();
    provider.channels.set(threadId, {
      id: threadId,
      type: 11,
      guild_id: actor.guildId,
      parent_id: provider.guildChannelId,
      thread_metadata: {
        archived: false,
        locked: false,
        auto_archive_duration: 1440,
        archive_timestamp: new Date(now()).toISOString(),
      },
    });
    provider.messages.set(
      threadId,
      discordMessageForTest(actor, {
        id: threadId,
        channelId: provider.guildChannelId,
        content: "Original thread starter",
      }),
    );
    for (let index = 1; index <= 10; index++) {
      const entry = discordMessageForTest(actor, {
        id: (BigInt(threadId) - BigInt(index)).toString(),
        channelId: provider.guildChannelId,
        content: `Parent discussion ${index}`,
      });
      provider.messages.set(entry.id, entry);
    }
    const quotedId = (BigInt(threadId) + 1n).toString();
    provider.messages.set(
      quotedId,
      discordMessageForTest(actor, {
        id: quotedId,
        channelId: threadId,
        content: "Explicitly quoted older decision",
      }),
    );
    for (let index = 1; index <= 25; index++) {
      const entry = discordMessageForTest(actor, {
        id: (BigInt(threadId) + 100n + BigInt(index)).toString(),
        channelId: threadId,
        content: `Recent thread message ${index}`,
      });
      provider.messages.set(entry.id, entry);
    }
    const attachmentOnly = discordMessageForTest(actor, {
      id: (BigInt(threadId) + 200n).toString(),
      channelId: threadId,
      content: "",
      attachments: [
        {
          id: uniqueDiscordSnowflake(),
          filename: "decision.pdf",
          size: 128,
          content_type: "application/pdf",
          url: "https://cdn.discordapp.com/attachments/1/2/decision.pdf?hm=never-share-this",
        },
      ],
    });
    provider.messages.set(attachmentOnly.id, attachmentOnly);
    const message = {
      ...discordMessageForTest(actor, {
        id: nextId,
        channelId: threadId,
        content: `<@${actor.botUserId}> explain the quoted decision`,
      }),
      type: 19,
      message_reference: {
        message_id: quotedId,
        channel_id: threadId,
        guild_id: actor.guildId,
      },
    };
    const { claim } = await claimMessage(actor, message);
    expect(claim.appendSystemPrompt).toContain("Original thread starter");
    expect(claim.appendSystemPrompt).toContain("Parent discussion 1");
    expect(claim.appendSystemPrompt).toContain(
      "Explicitly quoted older decision",
    );
    expect(claim.appendSystemPrompt).toContain("decision.pdf");
    expect(claim.appendSystemPrompt).not.toContain("never-share-this");
    if (!claim.appendSystemPrompt) {
      throw new Error("Expected conversation context in the Runner prompt");
    }
    const snapshot = claim.appendSystemPrompt.split("\n").find((line) => {
      return line.startsWith('[{"messageId"');
    });
    if (!snapshot) {
      throw new Error(
        "Expected a bounded conversation snapshot in the Runner prompt",
      );
    }
    expect(snapshot.length).toBeLessThanOrEqual(16_000);
    const entries = z
      .array(
        z.object({
          messageId: z.string(),
          channelId: z.string(),
          referencedByCurrentMessage: z.boolean().optional(),
        }),
      )
      .parse(JSON.parse(snapshot));
    expect(entries.length).toBeLessThanOrEqual(20);
    expect(entries).toContainEqual({
      messageId: quotedId,
      channelId: threadId,
      referencedByCurrentMessage: true,
    });
  });

  it("omits unavailable parent history and never follows a reference into another channel", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    mockEnv("DISCORD_MESSAGE_CONTENT_ENABLED", "true");
    const threadId = uniqueDiscordSnowflake();
    provider.channels.set(threadId, {
      id: threadId,
      type: 11,
      guild_id: actor.guildId,
      parent_id: provider.guildChannelId,
      thread_metadata: {
        archived: false,
        locked: false,
        auto_archive_duration: 1440,
        archive_timestamp: new Date(now()).toISOString(),
      },
    });
    const history = discordMessageForTest(actor, {
      id: (BigInt(threadId) + 1n).toString(),
      channelId: threadId,
      content: "Authorized thread history",
    });
    provider.messages.set(history.id, history);
    const parent = discordMessageForTest(actor, {
      id: (BigInt(threadId) - 1n).toString(),
      channelId: provider.guildChannelId,
      content: "Unavailable parent content",
    });
    provider.messages.set(parent.id, parent);
    const elsewhere = discordMessageForTest(actor, {
      id: (BigInt(threadId) + 2n).toString(),
      channelId: uniqueDiscordSnowflake(),
      content: "Unrelated channel content",
    });
    provider.messages.set(elsewhere.id, elsewhere);
    server.use(
      http.get(
        `https://discord.com/api/v10/channels/${provider.guildChannelId}/messages`,
        () => {
          return HttpResponse.json({ message: "Forbidden" }, { status: 403 });
        },
      ),
    );
    const message = {
      ...discordMessageForTest(actor, {
        id: (BigInt(threadId) + 100n).toString(),
        channelId: threadId,
        content: `<@${actor.botUserId}> continue`,
      }),
      type: 19,
      message_reference: {
        message_id: elsewhere.id,
        channel_id: elsewhere.channel_id,
        guild_id: actor.guildId,
      },
    };
    const { claim } = await claimMessage(actor, message);
    expect(claim.appendSystemPrompt).toContain(history.content);
    expect(claim.appendSystemPrompt).not.toContain(parent.content);
    expect(claim.appendSystemPrompt).not.toContain(elsewhere.content);
  });

  it("keeps an explicit DM reference out of the Agent's context", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    mockEnv("DISCORD_MESSAGE_CONTENT_ENABLED", "true");
    const message = {
      ...discordMessageForTest(actor, {
        channelId: provider.dmChannelId,
        guild: false,
        content: "Continue my task",
      }),
      type: 19,
      message_reference: {
        message_id: "123456789012345678",
        channel_id: provider.dmChannelId,
      },
    };
    botReplyBefore(
      actor,
      provider,
      { ...message, id: "123456789012345679" },
      "Another organization's private DM content",
    );
    const { claim } = await claimMessage(actor, message);
    expect(claim.appendSystemPrompt).not.toContain(
      "Another organization's private DM content",
    );
    expect(claim.prompt).toContain("Continue my task");
  });

  it("adds run attribution once to a split native send", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const { runId } = await claimMessage(
      actor,
      discordMessageForTest(actor, {
        channelId: provider.guildChannelId,
        content: `<@${actor.botUserId}> start a task`,
      }),
    );
    const seconds = Math.floor(now() / 1000);
    const headers = {
      authorization: `Bearer ${signSandboxJwtForTests({ scope: "okou", orgId: actor.orgId, userId: actor.userId, runId, capabilities: ["discord:write", "discord:read"], iat: seconds, exp: seconds + 3600 })}`,
    };
    const text = "Native update ".repeat(320);
    const sent = await accept(
      setupApp({ context, routes: integrationsDiscordMessageRoutes })(
        integrationsDiscordMessageContract,
      ).sendMessage({
        headers,
        body: { channelId: provider.guildChannelId, text },
      }),
      [200],
    );
    const page = await accept(
      setupApp({ context, routes: integrationsDiscordReadRoutes })(
        integrationsDiscordReadContract,
      ).history({
        headers,
        query: { channelId: provider.guildChannelId, limit: 100 },
      }),
      [200],
    );
    const content = sent.body.messages
      .map((receipt) => {
        return page.body.messages.find((entry) => {
          return entry.id === receipt.id;
        })?.content;
      })
      .join("");
    expect(content.startsWith(text)).toBeTruthy();
    expect(content.match(/Sent via /g)).toHaveLength(1);
    expect(content).toContain(`Triggered by <@${actor.discordUserId}>`);
    expect(content).toContain("Claude Fable 5.1");
    expect(sent.body.messages.length).toBeGreaterThan(1);
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

  it("tells the Discord thread when the org is at its concurrent run limit and starts it once a slot frees up", async () => {
    // One active run fills the org, independent of the plan's own limit.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const actor = await connected();
    const provider = mockDiscordProvider(actor);

    // With capacity, the first mention starts a run without a wait notice.
    const active = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> occupy the only org run slot`,
    });
    provider.messages.set(active.id, active);
    expect((await postDiscordMessage(context, active)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();
    expect(provider.sentMessages).toHaveLength(0);
    const [activeThread] = await discordChatThreads(context, actor);
    if (!activeThread) {
      throw new Error("Expected the active canonical Discord thread");
    }
    const activeRun = await launchedRun(actor, activeThread.id);

    // A second top-level mention opens its own thread, held only by the limit.
    const waiting = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> wait for an org run slot`,
    });
    provider.messages.set(waiting.id, waiting);
    expect((await postDiscordMessage(context, waiting)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();

    expect(provider.sentMessages).toStrictEqual([
      expect.objectContaining({
        channel_id: waiting.id,
        content:
          "The workspace has reached its concurrent run limit; this will start automatically when a slot frees up.",
      }),
    ]);
    const waitingThread = (await discordChatThreads(context, actor)).find(
      (thread) => {
        return thread.id !== activeThread.id;
      },
    );
    if (!waitingThread) {
      throw new Error("Expected the waiting canonical Discord thread");
    }
    const [waitingInput] = currentInputs(await events(actor, waitingThread.id));
    expect(waitingInput?.userMessage.parts).toContainEqual({
      type: "text",
      text: "@Okou wait for an org run slot",
    });
    expect(waitingInput?.runId).toBeUndefined();

    // Freeing the slot picks the waiting thread and launches its input.
    await runsApi.requestCancelRun(actor.actor, activeRun.runId, [200]);
    await flushWaitUntilForTest();
    const waitingRun = await launchedRun(actor, waitingThread.id);
    expect(waitingRun.prompt).toBe("@Okou wait for an org run slot");
    // The cancelled run may reply in its own thread; the notice is not resent.
    expect(
      provider.sentMessages.filter((message) => {
        return message.channel_id === waiting.id;
      }),
    ).toHaveLength(1);
    await runsApi.requestCancelRun(actor.actor, waitingRun.runId, [200]);
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
