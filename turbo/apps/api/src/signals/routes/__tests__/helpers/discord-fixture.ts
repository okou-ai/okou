import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  discordGatewayContract,
  type DiscordGatewayEnvelope,
} from "@okouai/api-contracts/contracts/discord-gateway";
import {
  chatThreadsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { z } from "zod";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import type {
  DiscordChannel,
  DiscordMessage,
} from "../../../external/discord-client";
import { chatThreadRoutes } from "../../chat-threads";
import { discordGatewayRoutes } from "../../discord-gateway";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./api-bdd-auth-org";
import { createRunsApi } from "./api-bdd-runs";
import {
  configureDiscordApp,
  mockDiscordMemberships,
  seedDiscordFixture,
  uniqueDiscordSnowflake,
} from "./discord";
import { updateFeatureSwitchesForUser } from "./feature-switches";
import { createRouteMocks } from "./route-test";

export const DISCORD_TEST_APPLICATION_ID = "900000000000000001";
export const DISCORD_TEST_GATEWAY_SECRET = randomBytes(32).toString("hex");

export interface ConnectedDiscordActor {
  readonly actor: ApiTestUser;
  readonly fixture: Awaited<ReturnType<typeof seedDiscordFixture>>;
  readonly userId: string;
  readonly orgId: string;
  readonly guildId: string;
  readonly discordUserId: string;
  readonly botUserId: string;
  readonly defaultAgentId: string;
  readonly runnerGroup: string;
  readonly connectionId: string;
}

export async function setupConnectedDiscordActor(
  context: TestContext,
  options: {
    readonly userId?: string;
    readonly orgId?: string;
    readonly guildId?: string;
    readonly discordUserId?: string;
    readonly reuseOrganization?: boolean;
  } = {},
): Promise<ConnectedDiscordActor> {
  configureDiscordApp();
  mockEnv("DISCORD_APPLICATION_ID", DISCORD_TEST_APPLICATION_ID);
  mockEnv("DISCORD_GATEWAY_SECRET", DISCORD_TEST_GATEWAY_SECRET);
  const userId = options.userId ?? `user_discord_${randomUUID()}`;
  const orgId = options.orgId ?? `org_discord_${randomUUID()}`;
  const guildId = options.guildId ?? uniqueDiscordSnowflake();
  const discordUserId = options.discordUserId ?? uniqueDiscordSnowflake();
  const botUserId = DISCORD_TEST_APPLICATION_ID;
  const authOrgApi = createAuthOrgAgentsBddApi(context);
  const runsApi = createRunsApi(context);
  const actor = authOrgApi.user({ userId, orgId, orgRole: "org:admin" });
  const runnerGroup = runsApi.configureRunnerGroup();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  authOrgApi.acceptAgentStorageWrites();
  runsApi.acceptStorageDownloads();
  if (!options.reuseOrganization) {
    await runsApi.grantProEntitlement(actor);
  }
  const onboarding = await authOrgApi.readOnboardingStatus(actor);
  if (!onboarding.defaultAgentId) {
    throw new Error(
      "Discord fixture onboarding did not create a default agent",
    );
  }
  if (!options.reuseOrganization) {
    await authOrgApi.updateAgentMetadata(actor, onboarding.defaultAgentId, {
      visibility: "public",
    });
    // These lifecycle fixtures exercise the native Runner claim protocol.
    await runsApi.ensureOrgModelProvider(actor, {
      model: "claude-fable-5-1",
    });
  }
  mockDiscordMemberships(context, [{ userId, orgId, orgRole: "org:admin" }]);
  await updateFeatureSwitchesForUser(
    context,
    { userId, orgId, orgRole: "org:admin" },
    { [FeatureSwitchKey.DiscordIntegration]: true },
  );
  const fixture = await seedDiscordFixture(context, {
    userId,
    orgId,
    orgRole: "org:admin",
    guildId,
    botUserId,
    discordUserId,
    guildName: "Discord test guild",
  });
  return {
    actor,
    fixture,
    userId,
    orgId,
    guildId,
    discordUserId,
    botUserId,
    defaultAgentId: onboarding.defaultAgentId,
    runnerGroup,
    connectionId: fixture.connectionId,
  };
}

const sendBodySchema = z.object({
  content: z.string(),
  nonce: z.union([z.string(), z.number()]).optional(),
  enforce_nonce: z.boolean().optional(),
  allowed_mentions: z.object({
    parse: z.array(z.string()),
    replied_user: z.boolean(),
  }),
});

/** Discord deduplicates an enforced nonce for "the past few minutes". */
const DISCORD_NONCE_DEDUPE_MS = 5 * 60_000;

export function mockDiscordProvider(actor: ConnectedDiscordActor) {
  const guildChannelId = uniqueDiscordSnowflake();
  const dmChannelId = uniqueDiscordSnowflake();
  const botRoleId = uniqueDiscordSnowflake();
  const channels = new Map<string, DiscordChannel>([
    [
      guildChannelId,
      {
        id: guildChannelId,
        type: 0,
        guild_id: actor.guildId,
        name: "general",
        permission_overwrites: [],
      },
    ],
    [
      dmChannelId,
      {
        id: dmChannelId,
        type: 1,
        recipients: [{ id: actor.discordUserId, username: "member" }],
      },
    ],
  ]);
  const messages = new Map<string, DiscordMessage>();
  const guildIds = new Set([actor.guildId]);
  const sentMessages: DiscordMessage[] = [];
  const deniedChannels = new Set<string>();
  const deniedMembers = new Set<string>();
  const state: {
    everyonePermissions?: string;
    afterThreadCreated?: (
      channel: DiscordChannel,
    ) => Response | undefined | Promise<Response | undefined>;
    beforeMessageCreate?: () =>
      | Response
      | undefined
      | Promise<Response | undefined>;
    /** Runs for every accepted send, including enforced-nonce replays. */
    afterMessageCreated?: (
      message: DiscordMessage,
    ) => Response | undefined | Promise<Response | undefined>;
    channelResponse?: (
      channelId: string,
    ) => Response | undefined | Promise<Response | undefined>;
    historyResponse?: () =>
      | Response
      | undefined
      | Promise<Response | undefined>;
  } = {};
  const base = "https://discord.com/api/v10";
  server.use(
    http.get(`${base}/users/@me`, () => {
      return HttpResponse.json({
        id: actor.botUserId,
        username: "Okou",
        bot: true,
      });
    }),
    http.get(`${base}/guilds/:guildId`, ({ params }) => {
      const guildId = String(params.guildId);
      if (!guildIds.has(guildId)) {
        return HttpResponse.json({ message: "Unknown guild" }, { status: 404 });
      }
      return HttpResponse.json({
        id: guildId,
        name: "Guild",
        owner_id: uniqueDiscordSnowflake(),
      });
    }),
    http.get(`${base}/guilds/:guildId/members/:userId`, ({ params }) => {
      const userId = String(params.userId);
      if (!guildIds.has(String(params.guildId)) || deniedMembers.has(userId)) {
        return HttpResponse.json(
          { message: "Unknown member", code: 10_007 },
          { status: 404 },
        );
      }
      return HttpResponse.json({
        user: {
          id: userId,
          username: "member",
          bot: userId === actor.botUserId,
        },
        roles: userId === actor.botUserId ? [botRoleId] : [],
      });
    }),
    http.get(`${base}/guilds/:guildId/roles`, ({ params }) => {
      const guildId = String(params.guildId);
      if (!guildIds.has(guildId)) {
        return HttpResponse.json({ message: "Unknown guild" }, { status: 404 });
      }
      return HttpResponse.json([
        {
          id: guildId,
          name: "@everyone",
          permissions: state.everyonePermissions ?? "8",
        },
        { id: botRoleId, name: "Okou bot", permissions: "8" },
      ]);
    }),
    http.get(`${base}/channels/:channelId`, async ({ params }) => {
      const channelId = String(params.channelId);
      const overridden = await state.channelResponse?.(channelId);
      if (overridden) {
        return overridden;
      }
      const channel = channels.get(channelId);
      return channel && !deniedChannels.has(channelId)
        ? HttpResponse.json(channel)
        : HttpResponse.json(
            { message: "Unknown channel", code: 10_003 },
            { status: 404 },
          );
    }),
    http.get(
      `${base}/channels/:channelId/thread-members/:userId`,
      ({ params }) => {
        return HttpResponse.json({
          id: String(params.channelId),
          user_id: String(params.userId),
          join_timestamp: "2026-09-24T00:00:00.000Z",
          flags: 0,
        });
      },
    ),
    http.get(
      `${base}/channels/:channelId/messages/:messageId`,
      ({ params }) => {
        const message = messages.get(String(params.messageId));
        return message?.channel_id === String(params.channelId)
          ? HttpResponse.json(message)
          : HttpResponse.json(
              { message: "Unknown message", code: 10_008 },
              { status: 404 },
            );
      },
    ),
    http.get(
      `${base}/channels/:channelId/messages`,
      async ({ params, request }) => {
        const overridden = await state.historyResponse?.();
        if (overridden) {
          return overridden;
        }
        const query = new URL(request.url).searchParams;
        const before = query.get("before");
        const result = [...messages.values()]
          .filter((message) => {
            return (
              message.channel_id === String(params.channelId) &&
              (before === null || BigInt(message.id) < BigInt(before))
            );
          })
          .sort((left, right) => {
            return BigInt(left.id) > BigInt(right.id) ? -1 : 1;
          })
          .slice(0, Number(query.get("limit") ?? 50))
          .map(({ nonce: _nonce, ...message }) => {
            // Discord omits nonce from fetched history.
            return message;
          });
        return HttpResponse.json(result);
      },
    ),
    http.post(
      `${base}/channels/:channelId/messages/:messageId/threads`,
      async ({ params }) => {
        const channel: DiscordChannel = {
          id: String(params.messageId),
          parent_id: String(params.channelId),
          guild_id: actor.guildId,
          type: 11,
          name: "Okou conversation",
          permission_overwrites: [],
          thread_metadata: {
            archived: false,
            locked: false,
            auto_archive_duration: 1440,
            archive_timestamp: "2026-09-24T00:00:00.000Z",
          },
        };
        channels.set(channel.id, channel);
        const overridden = await state.afterThreadCreated?.(channel);
        return overridden ?? HttpResponse.json(channel);
      },
    ),
    http.post(
      `${base}/channels/:channelId/messages`,
      async ({ params, request }) => {
        const blocked = await state.beforeMessageCreate?.();
        if (blocked) {
          return blocked;
        }
        const body = sendBodySchema.parse(await request.json());
        const nonce = body.nonce === undefined ? undefined : String(body.nonce);
        const original =
          body.enforce_nonce === true && nonce !== undefined
            ? [...messages.values()].find((message) => {
                return (
                  message.nonce === nonce &&
                  message.author.id === actor.botUserId &&
                  now() - Date.parse(message.timestamp) <
                    DISCORD_NONCE_DEDUPE_MS
                );
              })
            : undefined;
        if (original) {
          // Discord returns the original message for a repeated enforced nonce.
          const overridden = await state.afterMessageCreated?.(original);
          return overridden ?? HttpResponse.json(original);
        }
        const message: DiscordMessage = {
          id: uniqueDiscordSnowflake(),
          channel_id: String(params.channelId),
          author: { id: actor.botUserId, username: "Okou", bot: true },
          content: body.content,
          attachments: [],
          timestamp: new Date(now()).toISOString(),
          ...(nonce === undefined ? {} : { nonce }),
        };
        messages.set(message.id, message);
        sentMessages.push(message);
        const overridden = await state.afterMessageCreated?.(message);
        return overridden ?? HttpResponse.json(message);
      },
    ),
    http.post(`${base}/channels/:channelId/typing`, () => {
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return {
    guildChannelId,
    dmChannelId,
    channels,
    guildIds,
    messages,
    sentMessages,
    deniedChannels,
    deniedMembers,
    state,
  };
}

export function discordMessageForTest(
  actor: ConnectedDiscordActor,
  args: {
    readonly id?: string;
    readonly channelId: string;
    readonly content: string;
    readonly guild?: boolean;
    readonly attachments?: DiscordMessage["attachments"];
  },
) {
  return {
    id: args.id ?? uniqueDiscordSnowflake(),
    channel_id: args.channelId,
    ...(args.guild === false ? {} : { guild_id: actor.guildId }),
    author: { id: actor.discordUserId, username: "member" },
    content: args.content,
    mentions:
      args.guild === false ? [] : [{ id: actor.botUserId, username: "Okou" }],
    attachments: args.attachments ?? [],
    timestamp: new Date(now()).toISOString(),
    type: 0,
  };
}

export function postDiscordMessage(
  context: TestContext,
  message: ReturnType<typeof discordMessageForTest>,
  eventId = `MESSAGE_CREATE:${message.id}`,
) {
  return postDiscordGatewayEnvelope(context, {
    version: 1,
    applicationId: DISCORD_TEST_APPLICATION_ID,
    eventType: "MESSAGE_CREATE",
    eventId,
    payload: message,
  });
}

export function postDiscordGatewayEnvelope(
  context: TestContext,
  envelope: DiscordGatewayEnvelope,
) {
  const timestamp = Math.floor(now() / 1000).toString();
  const signature = createHmac("sha256", DISCORD_TEST_GATEWAY_SECRET)
    .update(`${timestamp}.${JSON.stringify(envelope)}`)
    .digest("hex");
  return accept(
    setupApp({ context, routes: discordGatewayRoutes })(
      discordGatewayContract,
    ).post({
      headers: {
        "x-discord-gateway-timestamp": timestamp,
        "x-discord-gateway-signature": signature,
      },
      body: envelope,
    }),
    [200],
  );
}

export async function discordChatThreads(
  context: TestContext,
  actor: ConnectedDiscordActor,
) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:admin",
  );
  const client = setupApp({ context, routes: chatThreadRoutes })(
    chatThreadsContract,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const response = await accept(client.snapshot({ headers }), [200]);
  if (!("chatThreads" in response.body)) {
    throw new Error(
      "A newly created Discord fixture must have an inline chat snapshot",
    );
  }
  const lifecycleEvents: ChatThreadEvent[] = [];
  let sinceSeqId = response.body.latestSeqId ?? undefined;
  while (true) {
    const page = await accept(
      client.events({
        headers,
        query: sinceSeqId === undefined ? {} : { sinceSeqId },
      }),
      [200],
    );
    lifecycleEvents.push(...page.body.events);
    if (!page.body.hasMore) {
      break;
    }
    const next = page.body.events.at(-1)?.seqId;
    if (next === undefined || next <= (sinceSeqId ?? 0)) {
      throw new Error(
        "Discord fixture thread lifecycle cursor did not advance",
      );
    }
    sinceSeqId = next;
  }
  return replayChatThreadEvents(response.body.chatThreads, lifecycleEvents);
}
