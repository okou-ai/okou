import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { array, boolean, object, string } from "zod";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { integrationsDiscordMessageContract } from "@okouai/api-contracts/contracts/integrations-discord-message";
import { integrationsDiscordReadContract } from "@okouai/api-contracts/contracts/integrations-discord-read";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { cliAuthRoutes } from "../cli-auth";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { integrationsDiscordMessageRoutes } from "../integrations-discord-message";
import { integrationsDiscordReadRoutes } from "../integrations-discord-read";
import {
  configureDiscordApp,
  createPublicDiscordBinding,
  uniqueDiscordSnowflake,
  type DiscordFixture,
} from "./helpers/discord";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const DISCORD_API = "https://discord.com/api/v10";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const app = setupApp({
  context,
  routes: [
    ...integrationsDiscordReadRoutes,
    ...integrationsDiscordMessageRoutes,
    ...integrationsDiscordRoutes,
    ...cliAuthRoutes,
  ],
});

function readApi() {
  return app(integrationsDiscordReadContract);
}

function messageApi() {
  return app(integrationsDiscordMessageContract);
}

const Permission = {
  view: 1n << 10n,
  send: 1n << 11n,
  history: 1n << 16n,
  manageThreads: 1n << 34n,
  sendInThreads: 1n << 38n,
} as const;

const MEMBER_PERMISSIONS =
  Permission.view |
  Permission.send |
  Permission.history |
  Permission.sendInThreads;
const MESSAGE_CONTENT_INTENT = 1 << 18;

interface Overwrite {
  readonly id: string;
  readonly type: 0 | 1;
  readonly allow: string;
  readonly deny: string;
}

interface Channel {
  readonly id: string;
  readonly type: number;
  readonly guild_id?: string;
  readonly name?: string;
  readonly parent_id?: string | null;
  permission_overwrites?: Overwrite[];
  readonly recipients?: { id: string; username: string }[];
  readonly thread_metadata?: {
    readonly archived: boolean;
    readonly locked: boolean;
    readonly auto_archive_duration: number;
    readonly archive_timestamp: string;
  };
}

interface Attachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly url: string;
  readonly proxy_url?: string;
  readonly content_type?: string;
}

interface StoredMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly author: { id: string; username: string; bot?: boolean };
  readonly content: string;
  readonly timestamp: string;
  readonly attachments: Attachment[];
  readonly flags?: number;
  readonly message_reference?: { message_id: string; channel_id: string };
  readonly thread?: Channel;
}

interface Member {
  readonly user: { id: string; username: string; bot?: boolean };
  readonly roles: string[];
  readonly communication_disabled_until?: string;
}

const postBodySchema = object({
  content: string(),
  allowed_mentions: object({
    parse: array(string()),
    replied_user: boolean(),
  }),
});

const openDmBodySchema = object({ recipient_id: string() }).strict();

/** Discord's provider-side state for one guild, as its REST API reports it. */
interface DiscordWorld {
  readonly guildId: string;
  readonly discordUserId: string;
  readonly botUserId: string;
  readonly roles: { id: string; name: string; permissions: string }[];
  readonly members: Map<string, Member>;
  readonly channels: Map<string, Channel>;
  readonly messages: Map<string, StoredMessage[]>;
  readonly threadMembers: Set<string>;
  readonly posts: { channelId: string; id: string; body: unknown }[];
  readonly dmOpens: unknown[];
  readonly openedDms: string[];
  applicationFlags: number;
  dmOpenForbidden: boolean;
  rateLimitAfterPosts: number | undefined;
}

function overwrite(
  id: string,
  type: 0 | 1,
  grants: { allow?: bigint; deny?: bigint },
): Overwrite {
  return {
    id,
    type,
    allow: String(grants.allow ?? 0n),
    deny: String(grants.deny ?? 0n),
  };
}

function unknown(code: number) {
  return HttpResponse.json({ message: "Unknown", code }, { status: 404 });
}

function serveDiscord(world: DiscordWorld): void {
  const ownerId = uniqueDiscordSnowflake();
  server.use(
    http.get(`${DISCORD_API}/applications/@me`, () => {
      return HttpResponse.json({
        id: env("DISCORD_APPLICATION_ID"),
        flags: world.applicationFlags,
      });
    }),
    http.get(`${DISCORD_API}/users/@me`, () => {
      return HttpResponse.json({
        id: world.botUserId,
        username: "Okou",
        bot: true,
      });
    }),
    http.post(`${DISCORD_API}/users/@me/channels`, async ({ request }) => {
      const body: unknown = await request.json();
      world.dmOpens.push(body);
      if (world.dmOpenForbidden) {
        return HttpResponse.json(
          { message: "Cannot send messages to this user", code: 50_007 },
          { status: 403 },
        );
      }
      const recipient = openDmBodySchema.parse(body).recipient_id;
      const channel: Channel = {
        id: uniqueDiscordSnowflake(),
        type: 1,
        recipients: [{ id: recipient, username: "recipient" }],
      };
      world.channels.set(channel.id, channel);
      world.openedDms.push(channel.id);
      return HttpResponse.json(channel);
    }),
    http.get(`${DISCORD_API}/guilds/:guildId`, ({ params }) => {
      if (params.guildId !== world.guildId) {
        return unknown(10_004);
      }
      return HttpResponse.json({
        id: world.guildId,
        name: "Native guild",
        owner_id: ownerId,
      });
    }),
    http.get(`${DISCORD_API}/guilds/:guildId/roles`, ({ params }) => {
      if (params.guildId !== world.guildId) {
        return unknown(10_004);
      }
      return HttpResponse.json(world.roles);
    }),
    http.get(`${DISCORD_API}/guilds/:guildId/members/:userId`, ({ params }) => {
      const member = world.members.get(String(params.userId));
      if (params.guildId !== world.guildId || !member) {
        return unknown(10_007);
      }
      return HttpResponse.json(member);
    }),
    http.get(`${DISCORD_API}/guilds/:guildId/channels`, ({ params }) => {
      if (params.guildId !== world.guildId) {
        return unknown(10_004);
      }
      return HttpResponse.json(
        [...world.channels.values()].filter((channel) => {
          return (
            channel.guild_id === world.guildId &&
            ![10, 11, 12].includes(channel.type)
          );
        }),
      );
    }),
    http.get(`${DISCORD_API}/channels/:channelId`, ({ params }) => {
      const channel = world.channels.get(String(params.channelId));
      return channel ? HttpResponse.json(channel) : unknown(10_003);
    }),
    http.get(
      `${DISCORD_API}/channels/:channelId/thread-members/:userId`,
      ({ params }) => {
        const threadId = String(params.channelId);
        const userId = String(params.userId);
        if (!world.threadMembers.has(`${threadId}:${userId}`)) {
          return unknown(10_007);
        }
        return HttpResponse.json({
          id: threadId,
          user_id: userId,
          join_timestamp: TIMESTAMP,
          flags: 0,
        });
      },
    ),
    http.get(
      `${DISCORD_API}/channels/:channelId/messages/:messageId`,
      ({ params }) => {
        const message = (
          world.messages.get(String(params.channelId)) ?? []
        ).find((entry) => {
          return entry.id === params.messageId;
        });
        return message ? HttpResponse.json(message) : unknown(10_008);
      },
    ),
    http.get(
      `${DISCORD_API}/channels/:channelId/messages`,
      ({ params, request }) => {
        const query = new URL(request.url).searchParams;
        const before = query.get("before");
        const limit = Number(query.get("limit") ?? "50");
        const page = (world.messages.get(String(params.channelId)) ?? [])
          .filter((message) => {
            return before === null || BigInt(message.id) < BigInt(before);
          })
          .sort((a, b) => {
            return BigInt(a.id) > BigInt(b.id) ? -1 : 1;
          })
          .slice(0, limit);
        return HttpResponse.json(page);
      },
    ),
    http.post(
      `${DISCORD_API}/channels/:channelId/messages`,
      async ({ params, request }) => {
        const channelId = String(params.channelId);
        const body: unknown = await request.json();
        if (
          world.rateLimitAfterPosts !== undefined &&
          world.posts.length >= world.rateLimitAfterPosts
        ) {
          return HttpResponse.json(
            {
              message: "You are being rate limited.",
              retry_after: 60,
              global: false,
            },
            { status: 429 },
          );
        }
        const message: StoredMessage = {
          id: uniqueDiscordSnowflake(),
          channel_id: channelId,
          author: { id: world.botUserId, username: "Okou", bot: true },
          content: postBodySchema.parse(body).content,
          timestamp: TIMESTAMP,
          attachments: [],
        };
        world.posts.push({ channelId, id: message.id, body });
        world.messages.set(channelId, [
          ...(world.messages.get(channelId) ?? []),
          message,
        ]);
        return HttpResponse.json(message);
      },
    ),
  );
}

function message(
  channelId: string,
  content: string,
  extra: Partial<StoredMessage> = {},
): StoredMessage {
  return {
    id: uniqueDiscordSnowflake(),
    channel_id: channelId,
    author: { id: uniqueDiscordSnowflake(), username: "someone" },
    content,
    timestamp: TIMESTAMP,
    attachments: [],
    ...extra,
  };
}

interface Native {
  readonly fixture: DiscordFixture;
  readonly world: DiscordWorld;
  readonly cli: { readonly authorization: string };
  /** A readable text channel holding one message. */
  readonly channelId: string;
  addChannel(channel: Omit<Channel, "guild_id">): Channel;
  addThread(
    parentId: string,
    options: { type?: number; archived?: boolean; locked?: boolean },
  ): Channel;
}

async function issueCliToken(userId: string, orgId: string) {
  const device = await accept(
    app(cliAuthDeviceContract).create({ body: {} }),
    [200],
  );
  createRouteMocks(context).clerk.session(userId, orgId, "org:admin");
  await accept(
    app(cliAuthApproveContract).approve({
      headers: SESSION,
      body: { device_code: device.body.device_code },
    }),
    [200],
  );
  const issued = await accept(
    app(cliAuthTokenContract).exchange({
      body: { device_code: device.body.device_code },
    }),
    [200],
  );
  if (!("access_token" in issued.body)) {
    throw new Error("Expected an issued CLI token");
  }
  return { authorization: `Bearer ${issued.body.access_token}` };
}

/** An admin installed the bot through Discord OAuth and signed in the CLI. */
async function nativeAdmin(
  options: {
    applicationFlags?: number;
    /** Workspaces that exist side by side share one identity provider. */
    identities?: ReturnType<typeof createStore>;
  } = {},
): Promise<Native> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await (options.identities ?? createStore()).set(
    seedOrgMembership$,
    { orgId, userId, role: "admin", name: "Discord native workspace" },
    context.signal,
  );
  configureDiscordApp();
  const fixture = await createPublicDiscordBinding(context, {
    orgId,
    userId,
    orgRole: "org:admin",
    flow: "install",
  });
  const { guildId } = fixture;
  const world: DiscordWorld = {
    guildId,
    discordUserId: fixture.discordUserId,
    botUserId: fixture.botUserId,
    roles: [
      {
        id: guildId,
        name: "@everyone",
        permissions: String(MEMBER_PERMISSIONS),
      },
    ],
    members: new Map([
      [
        fixture.discordUserId,
        { user: { id: fixture.discordUserId, username: "member" }, roles: [] },
      ],
      [
        fixture.botUserId,
        {
          user: { id: fixture.botUserId, username: "Okou", bot: true },
          roles: [],
        },
      ],
    ]),
    channels: new Map(),
    messages: new Map(),
    threadMembers: new Set(),
    posts: [],
    dmOpens: [],
    openedDms: [],
    applicationFlags: options.applicationFlags ?? MESSAGE_CONTENT_INTENT,
    dmOpenForbidden: false,
    rateLimitAfterPosts: undefined,
  };
  serveDiscord(world);
  const addChannel = (channel: Omit<Channel, "guild_id">): Channel => {
    const stored: Channel = {
      permission_overwrites: [],
      ...channel,
      guild_id: guildId,
    };
    world.channels.set(stored.id, stored);
    return stored;
  };
  const addThread = (
    parentId: string,
    threadOptions: { type?: number; archived?: boolean; locked?: boolean },
  ): Channel => {
    const thread: Channel = {
      id: uniqueDiscordSnowflake(),
      type: threadOptions.type ?? 11,
      guild_id: guildId,
      name: "Thread",
      parent_id: parentId,
      thread_metadata: {
        archived: threadOptions.archived ?? false,
        locked: threadOptions.locked ?? false,
        auto_archive_duration: 1440,
        archive_timestamp: TIMESTAMP,
      },
    };
    world.channels.set(thread.id, thread);
    world.messages.set(thread.id, [message(thread.id, "thread message")]);
    return thread;
  };
  const channel = addChannel({
    id: uniqueDiscordSnowflake(),
    type: 0,
    name: "general",
    parent_id: null,
  });
  world.messages.set(channel.id, [message(channel.id, "hello")]);
  const cli = await issueCliToken(userId, orgId);
  return {
    fixture,
    world,
    cli,
    channelId: channel.id,
    addChannel,
    addThread,
  };
}

function channelOf(world: DiscordWorld, channelId: string): Channel {
  const channel = world.channels.get(channelId);
  if (!channel) {
    throw new Error(`Discord channel ${channelId} is not configured`);
  }
  return channel;
}

async function readHistory(
  native: Native,
  query: {
    channelId: string;
    guildId?: string;
    limit?: number;
    before?: string;
  },
  headers: { authorization: string } = native.cli,
) {
  return await readApi().history({ headers, query });
}

async function sendText(native: Native, channelId: string, text: string) {
  return await messageApi().sendMessage({
    headers: native.cli,
    body: { channelId, text },
  });
}

describe("Discord native authorization and reads", () => {
  it("integrations-discord-native-008 fails guild history closed on application discovery failure 500 without blocking sends", async () => {
    const native = await nativeAdmin();
    server.use(
      http.get(`${DISCORD_API}/applications/@me`, () => {
        return HttpResponse.json(
          { message: "Internal Server Error", code: 0 },
          { status: 500 },
        );
      }),
    );

    const read = await accept(
      readHistory(native, { channelId: native.channelId }),
      [502],
    );
    const sent = await accept(
      sendText(native, native.channelId, "still deliverable"),
      [200],
    );

    expect(read.body.error.code).toBe("DISCORD_ERROR");
    expect(sent.status).toBe(200);
  });

  it("integrations-discord-native-005 marks ordinary guild content as limited", async () => {
    const native = await nativeAdmin({ applicationFlags: 0 });

    const read = await accept(
      readHistory(native, { channelId: native.channelId }),
      [200],
    );

    expect(read.body.contextMode).toBe("mentions_only");
  });

  it("integrations-discord-native-001 reads a post in a type 15 forum or media channel by its thread ID", async () => {
    const native = await nativeAdmin();
    const forum = native.addChannel({
      id: uniqueDiscordSnowflake(),
      type: 15,
      name: "forum",
    });
    const thread = native.addThread(forum.id, {});

    const post = await accept(
      readHistory(native, { channelId: thread.id }),
      [200],
    );
    const parent = await accept(
      readHistory(native, { channelId: forum.id }),
      [404],
    );

    expect(post.body.messages[0]?.content).toBe("thread message");
    expect(parent.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-native-002 reads a post in a type 16 forum or media channel by its thread ID", async () => {
    const native = await nativeAdmin();
    const media = native.addChannel({
      id: uniqueDiscordSnowflake(),
      type: 16,
      name: "media",
    });
    const thread = native.addThread(media.id, {});

    const post = await accept(
      readHistory(native, { channelId: thread.id }),
      [200],
    );
    const parent = await accept(
      readHistory(native, { channelId: media.id }),
      [404],
    );

    expect(post.body.messages[0]?.content).toBe("thread message");
    expect(parent.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-native-003 returns attachment metadata without the signed CDN URL", async () => {
    const native = await nativeAdmin();
    const attachmentId = uniqueDiscordSnowflake();
    const signed = `?ex=6a000000&is=69ff0000&hm=0123abcd&`;
    native.world.messages.set(native.channelId, [
      message(native.channelId, "see attached", {
        attachments: [
          {
            id: attachmentId,
            filename: "report.pdf",
            size: 1234,
            content_type: "application/pdf",
            url: `https://cdn.discordapp.com/attachments/${native.channelId}/${attachmentId}/report.pdf${signed}`,
            proxy_url: `https://media.discordapp.net/attachments/${native.channelId}/${attachmentId}/report.pdf${signed}`,
          },
        ],
      }),
    ]);

    const read = await accept(
      readHistory(native, { channelId: native.channelId }),
      [200],
    );

    expect(read.body.messages[0]?.attachments).toStrictEqual([
      {
        id: attachmentId,
        filename: "report.pdf",
        size: 1234,
        contentType: "application/pdf",
      },
    ]);
    expect(JSON.stringify(read.body)).not.toContain("hm=0123abcd");
  });

  it("integrations-discord-native-004 returns exact snowflake pagination and source links", async () => {
    const native = await nativeAdmin();
    const { channelId } = native;
    native.world.messages.set(channelId, [
      message(channelId, "first", { id: "18446744073709551614" }),
      message(channelId, "second", { id: "18446744073709551613" }),
      message(channelId, "third", { id: "18446744073709551612" }),
    ]);

    const first = await accept(
      readHistory(native, { channelId, limit: 2 }),
      [200],
    );
    const nextBefore = first.body.nextBefore;
    if (nextBefore === null) {
      throw new Error("Expected a next page cursor");
    }
    const second = await accept(
      readHistory(native, { channelId, limit: 2, before: nextBefore }),
      [200],
    );

    expect(
      first.body.messages.map((entry) => {
        return entry.id;
      }),
    ).toStrictEqual(["18446744073709551614", "18446744073709551613"]);
    expect(nextBefore).toBe("18446744073709551613");
    expect(first.body.messages[0]?.url).toBe(
      `https://discord.com/channels/${native.world.guildId}/${channelId}/18446744073709551614`,
    );
    expect(
      second.body.messages.map((entry) => {
        return entry.id;
      }),
    ).toStrictEqual(["18446744073709551612"]);
    expect(second.body.nextBefore).toBeNull();
  });

  it("integrations-discord-native-006 rechecks provider grants instead of retaining a prior content capability", async () => {
    const native = await nativeAdmin({
      applicationFlags: MESSAGE_CONTENT_INTENT,
    });

    const full = await accept(
      readHistory(native, { channelId: native.channelId }),
      [200],
    );
    native.world.applicationFlags = 0;
    const limited = await accept(
      readHistory(native, { channelId: native.channelId }),
      [200],
    );

    expect(full.body.contextMode).toBe("full");
    expect(limited.body.contextMode).toBe("mentions_only");
  });

  it("integrations-discord-native-013 opens an outbound DM for me without enabling private reads", async () => {
    const native = await nativeAdmin();

    const sent = await accept(
      messageApi().sendMessage({
        headers: native.cli,
        body: { userId: "me", text: "note to self" },
      }),
      [200],
    );
    const dmChannelId = sent.body.messages[0]?.channelId;
    if (!dmChannelId) {
      throw new Error("Expected a DM receipt");
    }
    await accept(readHistory(native, { channelId: dmChannelId }), [403]);

    expect(native.world.dmOpens).toStrictEqual([
      { recipient_id: native.fixture.discordUserId },
    ]);
    expect(native.world.openedDms).toStrictEqual([dmChannelId]);
  });

  it("integrations-discord-native-014 opens an outbound DM for other without enabling private reads", async () => {
    const native = await nativeAdmin();
    const otherUserId = uniqueDiscordSnowflake();

    const sent = await accept(
      messageApi().sendMessage({
        headers: native.cli,
        body: { userId: otherUserId, text: "hello there" },
      }),
      [200],
    );
    const dmChannelId = sent.body.messages[0]?.channelId;
    if (!dmChannelId) {
      throw new Error("Expected a DM receipt");
    }
    await accept(readHistory(native, { channelId: dmChannelId }), [404]);

    expect(native.world.dmOpens).toStrictEqual([{ recipient_id: otherUserId }]);
    expect(native.world.openedDms).toStrictEqual([dmChannelId]);
  });

  it("integrations-discord-native-015 does not send when opening a DM returns forbidden", async () => {
    const native = await nativeAdmin();
    native.world.dmOpenForbidden = true;

    await accept(
      messageApi().sendMessage({
        headers: native.cli,
        body: { userId: uniqueDiscordSnowflake(), text: "must not send" },
      }),
      [404],
    );

    expect(native.world.posts).toStrictEqual([]);
  });

  it("integrations-discord-native-019 denies group-dm without exposing message contents", async () => {
    const native = await nativeAdmin();
    const groupId = uniqueDiscordSnowflake();
    native.world.channels.set(groupId, {
      id: groupId,
      type: 3,
      recipients: [
        { id: native.fixture.discordUserId, username: "member" },
        { id: uniqueDiscordSnowflake(), username: "friend" },
      ],
    });
    native.world.messages.set(groupId, [message(groupId, "group secret")]);

    const read = await accept(
      readHistory(native, { channelId: groupId }),
      [404],
    );
    const sent = await accept(sendText(native, groupId, "hello group"), [404]);

    expect(read.body.error.code).toBe("NOT_FOUND");
    expect(read.body).not.toHaveProperty("messages");
    expect(sent.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-native-020 denies missing-user without exposing message contents", async () => {
    const native = await nativeAdmin();
    native.world.members.delete(native.fixture.discordUserId);

    const read = await accept(
      readHistory(native, { channelId: native.channelId }),
      [404],
    );
    const sent = await accept(sendText(native, native.channelId, "hi"), [404]);

    expect(read.body.error.code).toBe("NOT_FOUND");
    expect(read.body).not.toHaveProperty("messages");
    expect(sent.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-native-021 denies missing-bot without exposing message contents", async () => {
    const native = await nativeAdmin();
    native.world.members.delete(native.fixture.botUserId);

    const read = await accept(
      readHistory(native, { channelId: native.channelId }),
      [404],
    );
    const sent = await accept(sendText(native, native.channelId, "hi"), [404]);

    expect(read.body.error.code).toBe("NOT_FOUND");
    expect(read.body).not.toHaveProperty("messages");
    expect(sent.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-native-022 denies an explicit different guild selector and another organization token", async () => {
    const identities = createStore();
    const native = await nativeAdmin({ identities });
    const other = await nativeAdmin({ identities });

    await accept(
      readHistory(native, {
        channelId: native.channelId,
        guildId: uniqueDiscordSnowflake(),
      }),
      [404],
    );
    const foreign = await accept(
      readHistory(
        native,
        { channelId: native.channelId, guildId: native.world.guildId },
        other.cli,
      ),
      [404],
    );

    expect(foreign.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-native-023 applies everyone, aggregated role, and member overwrite precedence", async () => {
    const native = await nativeAdmin();
    const { world } = native;
    const deniedRole = uniqueDiscordSnowflake();
    const allowedRole = uniqueDiscordSnowflake();
    const botRole = uniqueDiscordSnowflake();
    world.roles.push(
      { id: deniedRole, name: "denied", permissions: "0" },
      { id: allowedRole, name: "allowed", permissions: "0" },
      { id: botRole, name: "bot", permissions: "0" },
    );
    world.members.set(world.discordUserId, {
      user: { id: world.discordUserId, username: "member" },
      roles: [deniedRole, allowedRole],
    });
    world.members.set(world.botUserId, {
      user: { id: world.botUserId, username: "Okou", bot: true },
      roles: [botRole],
    });
    const channel = channelOf(world, native.channelId);
    const roleOverwrites = [
      overwrite(world.guildId, 0, { deny: Permission.view }),
      overwrite(deniedRole, 0, { deny: Permission.view }),
      overwrite(allowedRole, 0, { allow: Permission.view }),
      overwrite(botRole, 0, { allow: Permission.view }),
    ];
    channel.permission_overwrites = roleOverwrites;

    const first = await accept(
      readHistory(native, { channelId: native.channelId }),
      [200],
    );
    channel.permission_overwrites = [
      ...roleOverwrites,
      overwrite(world.discordUserId, 1, { deny: Permission.view }),
    ];
    await accept(readHistory(native, { channelId: native.channelId }), [404]);
    channel.permission_overwrites = [
      ...roleOverwrites,
      overwrite(world.discordUserId, 1, { allow: Permission.view }),
    ];
    const third = await accept(
      readHistory(native, { channelId: native.channelId }),
      [200],
    );

    expect(first.body.messages).toHaveLength(1);
    expect(third.body.messages).toHaveLength(1);
  });

  it("integrations-discord-native-024 lists only mutually visible readable channels and requires history permission to read", async () => {
    const native = await nativeAdmin();
    const { world } = native;
    native.addChannel({
      id: uniqueDiscordSnowflake(),
      type: 0,
      name: "bot-hidden",
      permission_overwrites: [
        overwrite(world.botUserId, 1, { deny: Permission.view }),
      ],
    });
    const announcement = native.addChannel({
      id: uniqueDiscordSnowflake(),
      type: 5,
      name: "announcements",
    });
    world.messages.set(announcement.id, [message(announcement.id, "news")]);
    const forum = native.addChannel({
      id: uniqueDiscordSnowflake(),
      type: 15,
      name: "forum",
    });
    const media = native.addChannel({
      id: uniqueDiscordSnowflake(),
      type: 16,
      name: "media",
    });

    const listed = await accept(
      readApi().listChannels({ headers: native.cli, query: {} }),
      [200],
    );
    await accept(readHistory(native, { channelId: announcement.id }), [200]);
    const forumRead = await accept(
      readHistory(native, { channelId: forum.id }),
      [404],
    );
    const mediaRead = await accept(
      readHistory(native, { channelId: media.id }),
      [404],
    );
    channelOf(world, native.channelId).permission_overwrites = [
      overwrite(world.discordUserId, 1, { deny: Permission.history }),
    ];
    await accept(readHistory(native, { channelId: native.channelId }), [404]);

    expect(
      listed.body.channels.map((channel) => {
        return channel.id;
      }),
    ).toStrictEqual([native.channelId, announcement.id]);
    expect(forumRead.body.error.code).toBe("NOT_FOUND");
    expect(mediaRead.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-native-025 requires private thread membership for the user", async () => {
    const native = await nativeAdmin();
    const thread = native.addThread(native.channelId, { type: 12 });
    native.world.threadMembers.add(`${thread.id}:${native.world.botUserId}`);

    const read = await accept(
      readHistory(native, { channelId: thread.id }),
      [404],
    );
    const sent = await accept(sendText(native, thread.id, "hello"), [404]);

    expect(read.body.error.code).toBe("NOT_FOUND");
    expect(sent.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-native-029 reads a private thread with both memberships and inherits parent overwrites", async () => {
    const native = await nativeAdmin();
    const { world } = native;
    const thread = native.addThread(native.channelId, { type: 12 });
    world.threadMembers.add(`${thread.id}:${world.botUserId}`);
    world.threadMembers.add(`${thread.id}:${world.discordUserId}`);

    const first = await accept(
      readHistory(native, { channelId: thread.id }),
      [200],
    );
    channelOf(world, native.channelId).permission_overwrites = [
      overwrite(world.discordUserId, 1, { deny: Permission.view }),
    ];
    const second = await accept(
      readHistory(native, { channelId: thread.id }),
      [404],
    );

    expect(first.body.messages[0]?.content).toBe("thread message");
    expect(second.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-native-030 reads native thread replies and refuses to treat an ordinary reply as a thread", async () => {
    const native = await nativeAdmin();
    const { world, channelId } = native;
    const thread = native.addThread(channelId, {});
    const parent = message(channelId, "start a thread", {
      id: thread.id,
      flags: 32,
      thread,
    });
    world.messages.set(channelId, [parent]);

    const replies = await accept(
      readApi().replies({
        headers: native.cli,
        query: { channelId, messageId: parent.id },
      }),
      [200],
    );
    world.messages.set(channelId, [
      message(channelId, "just a reply", {
        id: parent.id,
        message_reference: {
          message_id: uniqueDiscordSnowflake(),
          channel_id: channelId,
        },
      }),
    ]);
    await accept(
      readApi().replies({
        headers: native.cli,
        query: { channelId, messageId: parent.id },
      }),
      [404],
    );

    expect(replies.body.threadId).toBe(thread.id);
    expect(replies.body.messages[0]?.content).toBe("thread message");
  });

  it("integrations-discord-native-032 revokes native access after disconnect without reusing a previously verified binding", async () => {
    const native = await nativeAdmin();
    await accept(readHistory(native, { channelId: native.channelId }), [200]);

    createRouteMocks(context).clerk.session(
      native.fixture.userId,
      native.fixture.orgId,
      "org:admin",
    );
    await accept(
      app(integrationsDiscordContract).disconnect({
        headers: SESSION,
        query: {},
      }),
      [200],
    );
    await accept(readHistory(native, { channelId: native.channelId }), [404]);
    const sent = await accept(sendText(native, native.channelId, "hi"), [404]);

    expect(sent.body.error.code).toBe("NOT_FOUND");
  });
});

function stripFences(chunk: string): string {
  return chunk.replace(/```(?:ts)?\n?/gu, "");
}

describe("Discord native sends and transport failures", () => {
  it("integrations-discord-native-048 requires SEND_MESSAGES_IN_THREADS rather than parent SEND_MESSAGES", async () => {
    const native = await nativeAdmin();
    const { world } = native;
    const thread = native.addThread(native.channelId, {});
    channelOf(world, native.channelId).permission_overwrites = [
      overwrite(world.discordUserId, 1, { deny: Permission.send }),
    ];
    const first = await accept(
      sendText(native, thread.id, "in the thread"),
      [200],
    );
    channelOf(world, native.channelId).permission_overwrites = [
      overwrite(world.discordUserId, 1, { deny: Permission.sendInThreads }),
    ];
    const second = await accept(
      sendText(native, thread.id, "denied in the thread"),
      [404],
    );

    expect(first.status).toBe(200);
    expect(second.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-native-054 surfaces a provider server failure without resending an uncertain write", async () => {
    const native = await nativeAdmin();
    server.use(
      http.post(`${DISCORD_API}/channels/:channelId/messages`, () => {
        return HttpResponse.json(
          { message: "Internal Server Error", code: 0 },
          { status: 500 },
        );
      }),
    );

    const sent = await accept(
      sendText(native, native.channelId, "uncertain write"),
      [502],
    );
    const history = await accept(
      readHistory(native, { channelId: native.channelId }),
      [200],
    );

    expect(sent.status).toBe(502);
    expect(
      history.body.messages.filter((message) => {
        return message.author.bot === true;
      }),
    ).toStrictEqual([]);
  });

  it("integrations-discord-native-035 preserves a long fenced answer and suppresses all mention notifications", async () => {
    const native = await nativeAdmin();
    const mentioned = uniqueDiscordSnowflake();
    const code = Array.from({ length: 400 }, (_, index) => {
      return `const value${index} = ${index};\n`;
    }).join("");
    const source = `\`\`\`ts\n${code}\`\`\`\n@everyone <@${mentioned}>`;

    const sent = await accept(
      sendText(native, native.channelId, source),
      [200],
    );
    await accept(readHistory(native, { channelId: native.channelId }), [200]);

    const posted = native.world.posts.map((post) => {
      return postBodySchema.parse(post.body);
    });
    expect(sent.body.messages.length).toBeGreaterThan(1);
    for (const body of posted) {
      expect(body.content.length).toBeLessThanOrEqual(2000);
      expect(body.allowed_mentions).toStrictEqual({
        parse: [],
        replied_user: false,
      });
    }
    expect(
      posted
        .map((body) => {
          return stripFences(body.content);
        })
        .join(""),
    ).toBe(stripFences(source));
    for (const receipt of sent.body.messages) {
      expect(receipt.url.endsWith(`/${receipt.id}`)).toBeTruthy();
    }
  });

  it("integrations-discord-native-036 sends into an archived unlocked thread, which Discord reopens (private: false)", async () => {
    const native = await nativeAdmin();
    const thread = native.addThread(native.channelId, { archived: true });

    await accept(readHistory(native, { channelId: thread.id }), [200]);
    await accept(sendText(native, thread.id, "reopen"), [200]);

    expect(native.world.posts).toHaveLength(1);
  });

  it("integrations-discord-native-038 reads a locked thread and sends only when MANAGE_THREADS is held by neither principal", async () => {
    const native = await nativeAdmin();
    const thread = native.addThread(native.channelId, {
      archived: true,
      locked: true,
    });

    await accept(readHistory(native, { channelId: thread.id }), [200]);
    const sent = await accept(sendText(native, thread.id, "closed"), [403]);

    expect(sent.body.error.code).toBe("DISCORD_THREAD_CLOSED");
    expect(native.world.posts).toStrictEqual([]);
  });

  it("integrations-discord-native-042 reads a locked thread and sends only when MANAGE_THREADS is held by both principals", async () => {
    const native = await nativeAdmin();
    const { world } = native;
    const moderator = uniqueDiscordSnowflake();
    const botModerator = uniqueDiscordSnowflake();
    world.roles.push(
      {
        id: moderator,
        name: "moderator",
        permissions: String(Permission.manageThreads),
      },
      {
        id: botModerator,
        name: "bot moderator",
        permissions: String(Permission.manageThreads),
      },
    );
    world.members.set(world.discordUserId, {
      user: { id: world.discordUserId, username: "member" },
      roles: [moderator],
    });
    world.members.set(world.botUserId, {
      user: { id: world.botUserId, username: "Okou", bot: true },
      roles: [botModerator],
    });
    const thread = native.addThread(native.channelId, {
      archived: true,
      locked: true,
    });

    await accept(readHistory(native, { channelId: thread.id }), [200]);
    await accept(sendText(native, thread.id, "moderated"), [200]);

    expect(world.posts).toHaveLength(1);
  });

  it("integrations-discord-native-045 denies writes for a timed-out user while retaining readable history", async () => {
    const native = await nativeAdmin();
    const { world } = native;
    world.members.set(world.discordUserId, {
      user: { id: world.discordUserId, username: "member" },
      roles: [],
      communication_disabled_until: "2099-01-01T00:00:00.000Z",
    });

    await accept(readHistory(native, { channelId: native.channelId }), [200]);
    const sent = await accept(sendText(native, native.channelId, "hi"), [404]);

    expect(sent.body.error.code).toBe("NOT_FOUND");
  });

  it("integrations-discord-native-053 reports a provider rate-limit delay and preserves already-delivered chunks", async () => {
    const native = await nativeAdmin();
    native.world.rateLimitAfterPosts = 1;

    const sent = await accept(
      sendText(native, native.channelId, "a".repeat(4001)),
      [429],
    );

    const [first] = native.world.posts;
    expect(sent.body.error.retryAfterSeconds).toBe(60);
    expect(sent.body.error.message).toContain("60 seconds");
    expect(
      sent.body.error.deliveredMessages?.map((entry) => {
        return entry.id;
      }),
    ).toStrictEqual([first?.id]);
  });
});
