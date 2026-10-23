import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { revokedChatEventIds } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { http, HttpResponse } from "msw";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webFileUrlRoutes } from "../web-file-url";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import {
  removePublicDiscordBinding,
  mockDiscordApplication,
  mockDiscordMemberships,
  createPublicDiscordBinding,
  configureDiscordApp,
  uniqueDiscordSnowflake,
} from "./helpers/discord";
import {
  discordChatThreads,
  discordMessageForTest,
  DISCORD_TEST_APPLICATION_ID,
  DISCORD_TEST_GATEWAY_SECRET,
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
  mockDiscordMemberships(context, [actor]);
  await removePublicDiscordBinding(context, actor.fixture);
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

function observeDiscordRequests() {
  const requests: { readonly method: string; readonly url: URL }[] = [];
  const observe = ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    if (url.origin === "https://discord.com") {
      requests.push({ method: request.method, url });
    }
  };
  server.events.on("request:start", observe);
  onTestFinished(() => {
    server.events.removeListener("request:start", observe);
  });
  return requests;
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

async function launchedRun(actor: ConnectedDiscordActor, threadId: string) {
  const [input] = currentInputs(await events(actor, threadId));
  if (!input?.runId) {
    throw new Error("Expected a launched Discord run");
  }
  return await runsApi.readRun(actor.actor, input.runId);
}

async function discordStatus(
  actor: Pick<ConnectedDiscordActor, "userId" | "orgId">,
) {
  mockDiscordMemberships(context, [actor]);
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
  it.each(["channel", "thread", "private thread", "dm"] as const)(
    "deduplicates each %s admission and launch, with typing before context and concurrent launch reads",
    async (kind) => {
      mockNow(now());
      const actor = await connected();
      const provider = mockDiscordProvider(actor);
      mockDiscordApplication(1 << 19);
      let channelId = provider.guildChannelId;
      if (kind === "dm") {
        channelId = provider.dmChannelId;
      } else if (kind !== "channel") {
        const thread = provider.createThread(uniqueDiscordSnowflake());
        channelId = thread.id;
        if (kind === "private thread") {
          provider.channels.set(thread.id, { ...thread, type: 12 });
          // VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY |
          // SEND_MESSAGES_IN_THREADS, without MANAGE_THREADS.
          provider.state.everyonePermissions = "274877975552";
        }
      }
      const attachmentId = uniqueDiscordSnowflake();
      const url = `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/notes.txt`;
      const message = {
        ...discordMessageForTest(actor, {
          channelId,
          guild: kind !== "dm",
          content: `<@${actor.botUserId}> read this attachment`,
          attachments: [
            { id: attachmentId, filename: "notes.txt", size: 5, url },
          ],
        }),
        // A standalone thread's missing starter may also be quoted. Its 404
        // must not cause the quote path to repeat the same message read.
        ...((kind === "thread" || kind === "private thread") && {
          message_reference: {
            message_id: channelId,
            channel_id: provider.guildChannelId,
            guild_id: actor.guildId,
          },
        }),
      };
      provider.messages.set(message.id, message);
      const downloading = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      server.use(
        http.get(url, async () => {
          downloading.resolve(undefined);
          await release.promise;
          return new HttpResponse("notes", {
            headers: { "content-type": "text/plain", "content-length": "5" },
          });
        }),
      );
      const requests = observeDiscordRequests();
      const memberships =
        context.mocks.clerk.organizations.getOrganizationMembershipList;
      memberships.mockClear();
      let processing: Promise<void> | undefined;
      const checked = await settleIncludingAbort(async () => {
        await postDiscordMessage(context, message);
        processing = flushWaitUntilForTest();
        await Promise.race([
          downloading.promise,
          processing.then(() => {
            if (!downloading.settled()) {
              throw new Error("Ingress ended before attachment download");
            }
          }),
        ]);
        // Pause at the last external read in admission. Queued launch is a
        // separate authority boundary and must still perform fresh checks.
        const reads = requests.filter((request) => {
          return request.method === "GET";
        });
        expect(
          new Set(
            reads.map((request) => {
              return request.url.href;
            }),
          ).size,
        ).toBe(reads.length);
        expect(reads).toHaveLength(
          kind === "dm"
            ? 3
            : kind === "channel"
              ? 9
              : kind === "thread"
                ? 12
                : 13,
        );
        expect(memberships).toHaveBeenCalledTimes(1);
        expect(provider.typingChannels).toStrictEqual([channelId]);
        const typing = requests.findIndex((request) => {
          return (
            request.method === "POST" &&
            request.url.pathname.endsWith("/typing")
          );
        });
        const contextRead = requests.findIndex((request) => {
          return (
            request.method === "GET" &&
            request.url.pathname.includes("/messages")
          );
        });
        expect(typing).toBeGreaterThanOrEqual(0);
        expect(typing).toBeLessThan(contextRead);
      });
      const independentPaths =
        kind === "dm"
          ? []
          : [
              `/api/v10/channels/${channelId}`,
              `/api/v10/guilds/${actor.guildId}`,
              `/api/v10/guilds/${actor.guildId}/roles`,
              `/api/v10/guilds/${actor.guildId}/members/${actor.discordUserId}`,
              `/api/v10/guilds/${actor.guildId}/members/${actor.botUserId}`,
              "/api/v10/users/@me",
              "/api/v10/applications/@me",
            ];
      const privateMemberPaths =
        kind === "private thread"
          ? [
              `/api/v10/channels/${channelId}/thread-members/${actor.discordUserId}`,
              `/api/v10/channels/${channelId}/thread-members/${actor.botUserId}`,
            ]
          : [];
      const independentReads = createDeferredPromise<void>(context.signal);
      const privateReads = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!independentReads.settled()) {
          independentReads.resolve(undefined);
        }
        if (!privateReads.settled()) {
          privateReads.resolve(undefined);
        }
      });
      const observeLaunch = () => {
        const paths = new Set(
          requests.map((request) => {
            return request.url.pathname;
          }),
        );
        if (
          !independentReads.settled() &&
          independentPaths.every((path) => {
            return paths.has(path);
          })
        ) {
          independentReads.resolve(undefined);
        }
        if (
          !privateReads.settled() &&
          privateMemberPaths.every((path) => {
            return paths.has(path);
          })
        ) {
          privateReads.resolve(undefined);
        }
      };
      server.events.on("request:start", observeLaunch);
      onTestFinished(() => {
        server.events.removeListener("request:start", observeLaunch);
      });
      if (checked.ok) {
        // Admission and launch must each read fresh facts, but only once within
        // each boundary. Hold the launch channel response until every unrelated
        // provider read starts: serial fetches cannot complete this handshake.
        requests.length = 0;
        memberships.mockClear();
        if (kind !== "dm") {
          provider.state.channelResponse = async () => {
            await independentReads.promise;
            return undefined;
          };
        }
        if (kind === "private thread") {
          provider.state.botPermissions = "274877975552";
          server.use(
            http.get(
              `https://discord.com/api/v10/channels/${channelId}/thread-members/:userId`,
              async ({ params }) => {
                await privateReads.promise;
                return HttpResponse.json({
                  id: channelId,
                  user_id: String(params.userId),
                  join_timestamp: "2026-09-24T00:00:00.000Z",
                  flags: 0,
                });
              },
            ),
          );
        }
      }
      if (!release.settled()) {
        release.resolve(undefined);
      }
      await processing;
      if (!checked.ok) {
        throw checked.error;
      }
      const expectedPaths =
        kind === "dm"
          ? [`/api/v10/channels/${channelId}`, "/api/v10/users/@me"]
          : [
              ...independentPaths,
              ...(kind === "channel"
                ? []
                : [`/api/v10/channels/${provider.guildChannelId}`]),
              ...privateMemberPaths,
            ];
      expect(
        requests
          .filter((request) => {
            return request.method === "GET";
          })
          .map((request) => {
            return request.url.pathname;
          })
          .sort(),
      ).toStrictEqual(expectedPaths.sort());
      expect(memberships).toHaveBeenCalledTimes(1);
      const [thread] = await discordChatThreads(context, actor);
      expect(thread).toBeDefined();
      await expect(launchedRun(actor, thread!.id)).resolves.toMatchObject({
        prompt: expect.stringContaining("read this attachment"),
      });
    },
  );

  it("reads fresh permissions on the next message and does not type after revocation", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    mockDiscordApplication(1 << 19);
    const first = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> first authorized message`,
    });
    await postDiscordMessage(context, first);
    await flushWaitUntilForTest();
    expect(provider.typingChannels).toStrictEqual([provider.guildChannelId]);
    const requests = observeDiscordRequests();
    provider.state.everyonePermissions = "0";
    const second = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> revoked message`,
    });
    await postDiscordMessage(context, second);
    await flushWaitUntilForTest();
    expect(
      requests.filter((request) => {
        return request.url.pathname.endsWith("/roles");
      }),
    ).toHaveLength(1);
    expect(
      requests.some((request) => {
        return (
          request.url.pathname.includes("/messages") ||
          request.url.pathname.endsWith("/typing")
        );
      }),
    ).toBeFalsy();
    const threads = await discordChatThreads(context, actor);
    expect(threads).toHaveLength(1);
    const inputs = currentInputs(await events(actor, threads[0]!.id));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.userMessage.parts).toContainEqual({
      type: "text",
      text: "@Okou first authorized message",
    });
  });

  it("sends one unavailable-agent notice before workspace bootstrap without admitting or replaying a chat", async () => {
    configureDiscordApp();
    mockEnv("DISCORD_APPLICATION_ID", DISCORD_TEST_APPLICATION_ID);
    mockEnv("DISCORD_GATEWAY_SECRET", DISCORD_TEST_GATEWAY_SECRET);
    const identity = {
      userId: `user_discord_${randomUUID()}`,
      orgId: `org_discord_${randomUUID()}`,
      orgRole: "org:admin" as const,
    };
    context.mocks.ably.publish.mockResolvedValue(undefined);
    mockDiscordMemberships(context, [identity]);
    // Register public cleanup before either setup request can commit.
    onTestFinished(async () => {
      mockDiscordMemberships(context, [identity]);
      createRouteMocks(context).clerk.session(
        identity.userId,
        identity.orgId,
        identity.orgRole,
      );
      const client = setupApp({ context, routes: integrationsDiscordRoutes })(
        integrationsDiscordContract,
      );
      await accept(
        client.disconnect({
          headers: { authorization: "Bearer clerk-session" },
          query: {},
        }),
        [200, 404],
      );
      await deleteFeatureSwitchesForUser(context, identity);
    });
    await updateFeatureSwitchesForUser(context, identity, {
      [FeatureSwitchKey.DiscordIntegration]: true,
    });
    // OAuth does not require onboarding or completion of Clerk's bootstrap job.
    const actor = await createPublicDiscordBinding(context, {
      ...identity,
      flow: "install",
      botUserId: DISCORD_TEST_APPLICATION_ID,
    });
    const provider = mockDiscordProvider(actor);
    const status = await discordStatus(actor);
    expect(status).toMatchObject({
      isAvailable: true,
      isConnected: true,
      discordUserId: actor.discordUserId,
      defaultAgentId: null,
      defaultAgentName: null,
    });
    expect(status.dmBindings).toStrictEqual([
      {
        connectionId: actor.connectionId,
        guildId: actor.guildId,
        guildName: actor.guildName,
        workspaceName: "Discord test workspace",
      },
    ]);
    const message = discordMessageForTest(actor, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> help before the workspace agent is ready`,
    });
    provider.messages.set(message.id, message);
    expect((await postDiscordMessage(context, message)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();
    expect(provider.sentMessages).toStrictEqual([
      expect.objectContaining({
        channel_id: provider.guildChannelId,
        content:
          "No accessible workspace default agent is configured. Ask a workspace admin to set one in Okou.",
        message_reference: {
          message_id: message.id,
          fail_if_not_exists: true,
        },
      }),
    ]);
    await expect(discordChatThreads(context, actor)).resolves.toStrictEqual([]);
    const delivered = [...provider.sentMessages];
    expect(
      (await postDiscordMessage(context, message, `agent-replay:${message.id}`))
        .body.outcome,
    ).toBe("duplicate");
    await flushWaitUntilForTest();
    expect(provider.sentMessages).toStrictEqual(delivered);
    await expect(discordChatThreads(context, actor)).resolves.toStrictEqual([]);
  });

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

  it.each(["unmentioned", "disabled"] as const)(
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

  it("uses a connected account in another server after the bot leaves its original server", async () => {
    const actor = await connected();
    const elsewhere = { ...actor, guildId: uniqueDiscordSnowflake() };
    const provider = mockDiscordProvider(elsewhere);
    const message = discordMessageForTest(elsewhere, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> help from another server`,
    });
    provider.messages.set(message.id, message);
    expect((await postDiscordMessage(context, message)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected cross-server account routing");
    }
    expect(currentInputs(await events(actor, thread.id))).toHaveLength(1);
    await launchedRun(actor, thread.id);
    // A connection does not grant access after Discord removes the bot.
    provider.deniedMembers.add(actor.botUserId);
    const denied = discordMessageForTest(elsewhere, {
      channelId: provider.guildChannelId,
      content: `<@${actor.botUserId}> bot no longer belongs here`,
    });
    provider.messages.set(denied.id, denied);
    // Gateway acceptance records the event; live authorization happens before chat admission.
    expect((await postDiscordMessage(context, denied)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();
    expect(currentInputs(await events(actor, thread.id))).toHaveLength(1);
    await expect(discordChatThreads(context, actor)).resolves.toHaveLength(1);
    await expect(discordStatus(actor)).resolves.toMatchObject({
      isConnected: true,
    });
  });

  it("uses the account's bot DM when its original server is no longer shared", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider({
      ...actor,
      guildId: uniqueDiscordSnowflake(),
    });
    const message = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "continue in my private chat",
    });
    provider.messages.set(message.id, message);
    await postDiscordMessage(context, message);
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected the verified account's DM to remain usable");
    }
    expect(currentInputs(await events(actor, thread.id))).toHaveLength(1);
    await launchedRun(actor, thread.id);
  });

  it.each(["installed", "uninstalled"] as const)(
    "replies to unconnected guild mentions with a setup link (%s)",
    async (scenario) => {
      mockEnv("APP_URL", "https://app.okou.ai");
      const actor = await connected();
      const provider = mockDiscordProvider(actor);
      const guildId =
        scenario === "installed" ? actor.guildId : uniqueDiscordSnowflake();
      provider.channels.set(provider.guildChannelId, {
        id: provider.guildChannelId,
        type: 0,
        guild_id: guildId,
      });
      const stranger = uniqueDiscordSnowflake();
      const message = {
        ...discordMessageForTest(actor, {
          channelId: provider.guildChannelId,
          content: `<@${actor.botUserId}> hello`,
        }),
        guild_id: guildId,
        author: { id: stranger, username: "new-member" },
      };
      expect((await postDiscordMessage(context, message)).body.outcome).toBe(
        "ignored",
      );
      await flushWaitUntilForTest();
      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]).toMatchObject({
        channel_id: message.channel_id,
        content: `<@${stranger}> Please connect your account to use Okou from Discord.`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: "Connect",
                url: `https://app.okou.ai/settings/discord?guild_id=${guildId}`,
              },
            ],
          },
        ],
        message_reference: { message_id: message.id },
        allowed_mentions: { parse: [], replied_user: false },
      });
      await postDiscordMessage(context, message);
      await flushWaitUntilForTest();
      expect(provider.sentMessages).toHaveLength(1);
      // One sender's notice must not silence another unconnected member.
      const other = {
        ...message,
        id: uniqueDiscordSnowflake(),
        author: { id: uniqueDiscordSnowflake(), username: "another-member" },
      };
      await postDiscordMessage(context, other);
      await flushWaitUntilForTest();
      expect(provider.sentMessages).toHaveLength(2);
      await expect(discordChatThreads(context, actor)).resolves.toHaveLength(0);
      expect([...provider.channels.keys()]).toStrictEqual([
        provider.guildChannelId,
        provider.dmChannelId,
      ]);
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

  it.each(["thread", "dm"] as const)(
    "publishes one owned %s and created event for concurrent distinct messages on the same physical key",
    async (kind) => {
      const actor = await connected();
      const provider = mockDiscordProvider(actor);
      const chat = createChatFilesBddApi(context);
      const before = await chat.getThreadSnapshot(actor.actor);
      const channelId =
        kind === "dm"
          ? provider.dmChannelId
          : provider.createThread(uniqueDiscordSnowflake()).id;
      const messages = [
        "first concurrent input",
        "second concurrent input",
      ].map((text) => {
        const message = discordMessageForTest(actor, {
          channelId,
          guild: kind !== "dm",
          content: kind === "dm" ? text : `<@${actor.botUserId}> ${text}`,
        });
        provider.messages.set(message.id, message);
        return message;
      });
      const receipts = await Promise.all(
        messages.map((message) => {
          return postDiscordMessage(context, message);
        }),
      );
      expect(
        receipts.map((receipt) => {
          return receipt.body.outcome;
        }),
      ).toStrictEqual(["accepted", "accepted"]);
      await flushWaitUntilForTest();
      const threads = await discordChatThreads(context, actor);
      expect(threads).toHaveLength(1);
      const [thread] = threads;
      if (!thread) {
        throw new Error("Expected one canonical Discord thread");
      }
      const inputs = currentInputs(await events(actor, thread.id));
      expect(inputs).toHaveLength(2);
      expect(
        inputs.map((input) => {
          return input.userMessage.parts;
        }),
      ).toStrictEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            {
              type: "text",
              text:
                kind === "dm"
                  ? "first concurrent input"
                  : "@Okou first concurrent input",
            },
          ]),
          expect.arrayContaining([
            {
              type: "text",
              text:
                kind === "dm"
                  ? "second concurrent input"
                  : "@Okou second concurrent input",
            },
          ]),
        ]),
      );
      const lifecycle = await chat.requestThreadEvents(
        actor.actor,
        before.latestSeqId === null ? {} : { sinceSeqId: before.latestSeqId },
        [200],
      );
      if (lifecycle.status !== 200) {
        throw new Error("Expected current lifecycle events");
      }
      expect(lifecycle.body.hasMore).toBeFalsy();
      const created = lifecycle.body.events.filter((event) => {
        return event.kind === "created";
      });
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        chatThreadId: thread.id,
        agentId: actor.defaultAgentId,
        selectedModel: thread.selectedModel,
        modelSettings: thread.modelSettings,
        cloudBrowserEnabled: thread.cloudBrowserEnabled,
      });
      const sequence = lifecycle.body.events.map((event) => {
        return event.seqId;
      });
      expect(sequence).toStrictEqual(
        [...new Set(sequence)].sort((left, right) => {
          return left - right;
        }),
      );
      const replays = await Promise.all(
        messages.map((message) => {
          return postDiscordMessage(context, message, `replayed:${message.id}`);
        }),
      );
      expect(
        replays.map((receipt) => {
          return receipt.body.outcome;
        }),
      ).toStrictEqual(["duplicate", "duplicate"]);
      await flushWaitUntilForTest();
      expect(
        currentInputs(await events(actor, thread.id))
          .map((input) => {
            return input.id;
          })
          .sort(),
      ).toStrictEqual(
        inputs
          .map((input) => {
            return input.id;
          })
          .sort(),
      );
      const afterReplay = await chat.requestThreadEvents(
        actor.actor,
        before.latestSeqId === null ? {} : { sinceSeqId: before.latestSeqId },
        [200],
      );
      if (afterReplay.status !== 200) {
        throw new Error("Expected current lifecycle events after replay");
      }
      expect(
        afterReplay.body.events.filter((event) => {
          return event.kind === "created";
        }),
      ).toStrictEqual(created);
      expect(
        (await discordChatThreads(context, actor)).map((entry) => {
          return entry.id;
        }),
      ).toStrictEqual([thread.id]);
    },
  );

  it("keeps deleted DM receipts consumed while a new message creates a new owned chat", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const chat = createChatFilesBddApi(context);
    const message = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "remember this message identity",
    });
    provider.messages.set(message.id, message);
    expect((await postDiscordMessage(context, message)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    if (!thread) {
      throw new Error("Expected original canonical DM thread");
    }
    await chat.deleteThread(actor.actor, thread.id);
    await chat.requestReadThreadMetadata(actor.actor, thread.id, [404]);
    expect(
      (await postDiscordMessage(context, message, `after-delete:${message.id}`))
        .body.outcome,
    ).toBe("duplicate");
    await flushWaitUntilForTest();
    await expect(discordChatThreads(context, actor)).resolves.toHaveLength(0);
    const next = discordMessageForTest(actor, {
      channelId: provider.dmChannelId,
      guild: false,
      content: "start a new conversation after deletion",
    });
    provider.messages.set(next.id, next);
    expect((await postDiscordMessage(context, next)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();
    const threads = await discordChatThreads(context, actor);
    expect(threads).toHaveLength(1);
    const [replacement] = threads;
    if (!replacement) {
      throw new Error("Expected replacement canonical DM thread");
    }
    expect(replacement.id).not.toBe(thread.id);
    const inputs = currentInputs(await events(actor, replacement.id));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.userMessage.parts).toContainEqual({
      type: "text",
      text: "start a new conversation after deletion",
    });
    const lifecycle = await chat.requestThreadEvents(actor.actor, {}, [200]);
    if (lifecycle.status !== 200) {
      throw new Error("Expected DM lifecycle events");
    }
    expect(lifecycle.body.events).toContainEqual(
      expect.objectContaining({ kind: "deleted", chatThreadId: thread.id }),
    );
    expect(
      lifecycle.body.events
        .filter((event) => {
          return event.kind === "created";
        })
        .map((event) => {
          return event.chatThreadId;
        }),
    ).toStrictEqual([thread.id, replacement.id]);
  });

  it("tells a Discord run how its final reply and files reach Discord", async () => {
    const actor = await connected();
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
      'okou discord install-link --invite "<invitation-url>" --json',
    );
    expect(claim.appendSystemPrompt).toContain(
      "Never claim Okou has joined based only on link generation",
    );
    expect(claim.appendSystemPrompt).toContain(
      "- Discord files: when the task explicitly asks to share a file in Discord, use `okou discord upload-file --help`",
    );
    const privateArtifactRule =
      "A private `/artifacts/...` address is not openable from Discord, so a link alone shows the user nothing.";
    expect(claim.appendSystemPrompt).toContain(privateArtifactRule);
    expect(claim.appendSystemPrompt).toContain(
      "upload it with `okou discord upload-file` so the user has something they can open there",
    );
  });

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

  it.each([403, 404, 502])(
    "does not send or replay a terminal notice when Discord channel access fails with %s",
    async (status) => {
      const actor = await connected();
      const provider = mockDiscordProvider(actor);
      const message = discordMessageForTest(actor, {
        channelId: provider.guildChannelId,
        content: `<@${actor.botUserId}> handle a rejected thread creation`,
      });
      provider.messages.set(message.id, message);
      server.use(
        http.post(
          `https://discord.com/api/v10/channels/${provider.guildChannelId}/messages/${message.id}/threads`,
          () => {
            provider.state.channelResponse = (channelId) => {
              return channelId === provider.guildChannelId
                ? HttpResponse.json(
                    { message: "Channel unavailable" },
                    { status },
                  )
                : undefined;
            };
            return HttpResponse.json(
              { message: "Cannot create thread" },
              { status: 400 },
            );
          },
        ),
      );

      expect((await postDiscordMessage(context, message)).body.outcome).toBe(
        "accepted",
      );
      await flushWaitUntilForTest();
      expect(provider.channels.has(message.id)).toBeFalsy();
      expect(provider.sentMessages).toStrictEqual([]);
      expect(
        (
          await postDiscordMessage(
            context,
            message,
            `access-replay:${message.id}`,
          )
        ).body.outcome,
      ).toBe("duplicate");
      await flushWaitUntilForTest();
      expect(provider.sentMessages).toStrictEqual([]);
    },
  );

  it.each(["rate limited", "response lost"] as const)(
    "does not resend a terminal notice when its delivery is %s",
    async (failure) => {
      const actor = await connected();
      const provider = mockDiscordProvider(actor);
      // Allow conversation access while denying the sender thread creation.
      provider.state.everyonePermissions = "68608";
      if (failure === "rate limited") {
        provider.state.beforeMessageCreate = () => {
          return HttpResponse.json(
            { message: "Rate limited", retry_after: 1, global: false },
            { status: 429 },
          );
        };
      } else {
        provider.state.afterMessageCreated = () => {
          return HttpResponse.error();
        };
      }
      const message = discordMessageForTest(actor, {
        channelId: provider.guildChannelId,
        content: `<@${actor.botUserId}> report the missing thread permission once`,
      });
      provider.messages.set(message.id, message);
      expect((await postDiscordMessage(context, message)).body.outcome).toBe(
        "accepted",
      );
      await flushWaitUntilForTest();
      const acceptedMessages = provider.sentMessages.map((sent) => {
        return { channelId: sent.channel_id, content: sent.content };
      });
      expect(acceptedMessages).toStrictEqual(
        failure === "rate limited"
          ? []
          : [
              {
                channelId: provider.guildChannelId,
                content:
                  "I couldn't process this Discord message. Please send it again.",
              },
            ],
      );
      expect(
        (
          await postDiscordMessage(
            context,
            message,
            `notice-replay:${message.id}`,
          )
        ).body.outcome,
      ).toBe("duplicate");
      await flushWaitUntilForTest();
      expect(
        provider.sentMessages.map((sent) => {
          return { channelId: sent.channel_id, content: sent.content };
        }),
      ).toStrictEqual(acceptedMessages);
    },
  );

  it("keeps one canonical error and one reply when an attachment disappears after routing", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    const channel = provider.createThread(uniqueDiscordSnowflake());
    const attachmentId = uniqueDiscordSnowflake();
    const message = discordMessageForTest(actor, {
      channelId: channel.id,
      content: `<@${actor.botUserId}> read the missing attachment`,
      attachments: [
        {
          id: attachmentId,
          filename: "missing.txt",
          size: 5,
          url: `https://cdn.discordapp.com/attachments/${channel.id}/${attachmentId}/missing.txt`,
        },
      ],
    });
    // The gateway observed the attachment, but Discord's authorized refresh
    // no longer returns it after the canonical route has been established.
    provider.messages.set(message.id, { ...message, attachments: [] });
    expect((await postDiscordMessage(context, message)).body.outcome).toBe(
      "accepted",
    );
    await flushWaitUntilForTest();
    const [thread] = await discordChatThreads(context, actor);
    expect(thread).toBeDefined();
    if (!thread) {
      throw new Error("Routed Discord failure must remain visible in chat");
    }
    const content =
      "I couldn't process this Discord message. Please send it again.";
    const original = await events(actor, thread.id);
    const errors = original.filter((event) => {
      return event.eventType === "output.error";
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ content });
    expect(currentInputs(original)).toStrictEqual([]);
    expect(
      original.every((event) => {
        return event.runId === undefined;
      }),
    ).toBeTruthy();
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]).toMatchObject({
      channel_id: channel.id,
      content,
    });

    provider.messages.set(message.id, message);
    expect(
      (
        await postDiscordMessage(
          context,
          message,
          `terminal-replay:${message.id}`,
        )
      ).body.outcome,
    ).toBe("duplicate");
    await flushWaitUntilForTest();
    await expect(events(actor, thread.id)).resolves.toStrictEqual(original);
    expect(provider.sentMessages).toHaveLength(1);
  });

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
    expect(provider.channels.has(message.id)).toBeFalsy();
    const inputs = [];
    for (const thread of await discordChatThreads(context, actor)) {
      inputs.push(...currentInputs(await events(actor, thread.id)));
    }
    expect(inputs).toHaveLength(testCase.allowed ? 1 : 0);
    if (testCase.allowed) {
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
    provider.createThread(firstMessage.id);
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

  it("preserves account connections across temporary unavailability, bot removal, and replay", async () => {
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
      isConnected: true,
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
    ).toBe("ignored");
    await flushWaitUntilForTest();
    expect(channelsPublishedTo(context.mocks, "discord:changed")).toStrictEqual(
      [],
    );
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    await expect(discordStatus(actor)).resolves.toMatchObject({
      isConnected: true,
    });
    const reinstalled = await createPublicDiscordBinding(context, {
      flow: "install",
      userId: actor.userId,
      orgId: actor.orgId,
      orgRole: "org:admin",
      guildId: actor.guildId,
      botUserId: actor.botUserId,
      discordUserId: actor.discordUserId,
      guildName: "Discord test guild",
    });
    expect(reinstalled.connectionId).toBe(actor.connectionId);
    await flushWaitUntilForTest();
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.channelGet.mockClear();
    expect(
      (await postDiscordGatewayEnvelope(context, removed)).body.outcome,
    ).toBe("ignored");
    await flushWaitUntilForTest();
    expect(channelsPublishedTo(context.mocks, "discord:changed")).toStrictEqual(
      [],
    );
    await expect(discordStatus(actor)).resolves.toMatchObject({
      isConnected: true,
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
    const reinstalled = await createPublicDiscordBinding(context, {
      flow: "connect",
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
    provider.createThread(first.id);
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
    expect(sent.body).toMatchObject({ threadId: thread.id });
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
    mockDiscordApplication(1 << 19);
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
    mockEnv("APP_URL", "https://app.okou.ai");
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
    expect(noticesTo(dmId)[0]).toMatchObject({
      content: "Please connect your account to use Okou from Discord.",
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 5,
              label: "Connect",
              url: "https://app.okou.ai/settings/discord",
            },
          ],
        },
      ],
    });
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

  it("asks a DM sender with several workspaces to choose one with /connect", async () => {
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
      content: expect.stringContaining("/connect"),
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

  it("imports refreshed attachment metadata while keeping context and signed URLs private", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    mockDiscordApplication(1 << 19);
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.DiscordIntegration]: true,
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
      setupApp({ context, routes: webFileUrlRoutes })(webFilesContract).fileUrl(
        {
          headers: { authorization: "Bearer clerk-session" },
          query: { file_id: attachedFile.fileId },
        },
      ),
      [200],
    );
    expect(downloaded.body.downloadUrl).toMatch(/^https:\/\//u);
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

  it("replies to the original message while queued without creating an empty thread", async () => {
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

    // A second mention waits for capacity without opening an empty native thread.
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
        channel_id: provider.guildChannelId,
        message_reference: {
          message_id: waiting.id,
          fail_if_not_exists: true,
        },
        content:
          "The workspace has reached its concurrent run limit; this will start automatically when a slot frees up.",
      }),
    ]);
    expect(provider.channels.has(waiting.id)).toBeFalsy();
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
        return message.content.includes("concurrent run limit");
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
    mockDiscordApplication(1 << 19);
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
