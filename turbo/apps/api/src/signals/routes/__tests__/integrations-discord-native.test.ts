import { randomBytes, randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { integrationsDiscordReadContract } from "@okouai/api-contracts/contracts/integrations-discord-read";
import { integrationsDiscordMessageContract } from "@okouai/api-contracts/contracts/integrations-discord-message";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import type {
  DiscordChannel,
  DiscordMessage,
  DiscordRole,
} from "../../external/discord-client";
import { integrationsDiscordReadRoutes } from "../integrations-discord-read";
import { integrationsDiscordMessageRoutes } from "../integrations-discord-message";
import { integrationsDiscordRoutes } from "../integrations-discord";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { mockDiscordMemberships, seedDiscordFixture } from "./helpers/discord";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const API = "https://discord.com/api/v10";
const VIEW = 1n << 10n;
const SEND = 1n << 11n;
const READ = 1n << 16n;
const THREAD_SEND = 1n << 38n;
const BASE_PERMISSIONS = String(VIEW | SEND | READ | THREAD_SEND | (1n << 15n));

function snowflake() {
  return (
    100_000_000_000_000_000n + BigInt(`0x${randomBytes(7).toString("hex")}`)
  ).toString();
}

async function fixture(
  options: {
    enabled?: boolean;
    capabilities?: readonly Capability[];
    messageContent?: boolean;
  } = {},
) {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const guildId = snowflake();
  const discordUserId = snowflake();
  const botUserId = snowflake();
  const channelId = snowflake();
  const threadId = snowflake();
  const userRoleId = snowflake();
  const extraRoleId = snowflake();
  const botRoleId = snowflake();
  const store = createStore();
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  mockEnv("DISCORD_BOT_TOKEN", "discord-test-token");
  mockEnv("DISCORD_APPLICATION_ID", botUserId);
  mockEnv("DISCORD_PUBLIC_KEY", "ab".repeat(32));
  mockEnv("DISCORD_GATEWAY_SECRET", "discord-gateway-test-secret-at-least-32");
  mockEnv(
    "DISCORD_MESSAGE_CONTENT_ENABLED",
    (options.messageContent ?? true) ? "true" : "false",
  );
  await updateFeatureSwitchesForUser(
    context,
    { orgId, userId, orgRole: "org:admin" },
    { [FeatureSwitchKey.DiscordIntegration]: options.enabled ?? true },
  );
  mockDiscordMemberships(context, [{ orgId, userId }]);
  await seedDiscordFixture(context, {
    orgId,
    userId,
    guildId,
    guildName: "Test guild",
    discordUserId,
    botUserId,
  });
  const seconds = Math.floor(now() / 1000);
  const headers = {
    authorization: `Bearer ${signSandboxJwtForTests({ scope: "okou", orgId, userId, runId: randomUUID(), capabilities: options.capabilities ?? ["discord:read", "discord:write"], iat: seconds, exp: seconds + 3600 })}`,
  };
  const author = { id: discordUserId, username: "sender" };
  const botAuthor = { id: botUserId, username: "Okou", bot: true };
  const channels = new Map<string, DiscordChannel>([
    [
      channelId,
      {
        id: channelId,
        guild_id: guildId,
        type: 0,
        name: "general",
        permission_overwrites: [],
      },
    ],
  ]);
  const roles: DiscordRole[] = [
    { id: guildId, name: "@everyone", permissions: BASE_PERMISSIONS },
    { id: userRoleId, name: "user", permissions: "0" },
    { id: extraRoleId, name: "extra", permissions: "0" },
    { id: botRoleId, name: "bot", permissions: "0" },
  ];
  const threadMembers = new Set([discordUserId, botUserId]);
  const messages = new Map<string, DiscordMessage[]>();
  const sentBodies: {
    content: string;
    allowed_mentions: { parse: string[]; replied_user: boolean };
  }[] = [];
  const state = {
    userTimedOut: false,
    botTimedOut: false,
    userMember: true,
    botMember: true,
  };
  const message = (
    id = snowflake(),
    destination = channelId,
    content = "hello",
  ): DiscordMessage => {
    return {
      id,
      channel_id: destination,
      author,
      content,
      timestamp: "2026-09-24T00:00:00.000Z",
      attachments: [],
    };
  };
  messages.set(channelId, [message()]);
  server.use(
    http.get(`${API}/users/@me`, () => {
      return HttpResponse.json(botAuthor);
    }),
    http.get(`${API}/guilds/${guildId}`, () => {
      return HttpResponse.json({
        id: guildId,
        name: "Test guild",
        owner_id: snowflake(),
      });
    }),
    http.get(`${API}/guilds/${guildId}/roles`, () => {
      return HttpResponse.json(roles);
    }),
    http.get(`${API}/guilds/${guildId}/members/:id`, ({ params }) => {
      const isUser = params.id === discordUserId;
      if ((isUser && !state.userMember) || (!isUser && !state.botMember)) {
        return HttpResponse.json({ code: 10_007 }, { status: 404 });
      }
      return HttpResponse.json({
        user: isUser ? author : botAuthor,
        roles: isUser ? [userRoleId, extraRoleId] : [botRoleId],
        communication_disabled_until: (
          isUser ? state.userTimedOut : state.botTimedOut
        )
          ? "2099-01-01T00:00:00Z"
          : null,
      });
    }),
    http.get(`${API}/guilds/${guildId}/channels`, () => {
      return HttpResponse.json([...channels.values()]);
    }),
    http.get(`${API}/channels/:channelId`, ({ params }) => {
      const channel = channels.get(String(params.channelId));
      return channel
        ? HttpResponse.json(channel)
        : HttpResponse.json({ code: 10_003 }, { status: 404 });
    }),
    http.get(
      `${API}/channels/:channelId/thread-members/:userId`,
      ({ params }) => {
        return threadMembers.has(String(params.userId))
          ? HttpResponse.json({
              id: params.channelId,
              user_id: params.userId,
              join_timestamp: "2026-09-24T00:00:00Z",
              flags: 0,
            })
          : HttpResponse.json({ code: 10_007 }, { status: 404 });
      },
    ),
    http.get(`${API}/channels/:channelId/messages/:messageId`, ({ params }) => {
      const found = messages.get(String(params.channelId))?.find((entry) => {
        return entry.id === params.messageId;
      });
      return found
        ? HttpResponse.json(found)
        : HttpResponse.json({ code: 10_008 }, { status: 404 });
    }),
    http.get(`${API}/channels/:channelId/messages`, ({ request, params }) => {
      const query = new URL(request.url).searchParams;
      const before = query.get("before");
      const entries = (messages.get(String(params.channelId)) ?? [])
        .filter((entry) => {
          return before === null || BigInt(entry.id) < BigInt(before);
        })
        .sort((a, b) => {
          return BigInt(a.id) > BigInt(b.id) ? -1 : 1;
        });
      return HttpResponse.json(entries.slice(0, Number(query.get("limit"))));
    }),
    http.post(
      `${API}/channels/:channelId/messages`,
      async ({ request, params }) => {
        const body = z
          .object({
            content: z.string(),
            allowed_mentions: z.object({
              parse: z.array(z.string()),
              replied_user: z.boolean(),
            }),
          })
          .parse(await request.json());
        sentBodies.push(body);
        const entry = {
          ...message(snowflake(), String(params.channelId), body.content),
          author: botAuthor,
        };
        const entries = messages.get(entry.channel_id) ?? [];
        entries.push(entry);
        messages.set(entry.channel_id, entries);
        return HttpResponse.json(entry);
      },
    ),
  );
  return {
    orgId,
    userId,
    guildId,
    discordUserId,
    botUserId,
    channelId,
    threadId,
    userRoleId,
    extraRoleId,
    botRoleId,
    headers,
    channels,
    roles,
    threadMembers,
    messages,
    sentBodies,
    state,
    message,
    read: setupApp({ context, routes: integrationsDiscordReadRoutes })(
      integrationsDiscordReadContract,
    ),
    write: setupApp({ context, routes: integrationsDiscordMessageRoutes })(
      integrationsDiscordMessageContract,
    ),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function addThread(
  f: Fixture,
  options: { private?: boolean; archived?: boolean; locked?: boolean } = {},
) {
  const channel: DiscordChannel = {
    id: f.threadId,
    guild_id: f.guildId,
    parent_id: f.channelId,
    type: options.private ? 12 : 11,
    name: "thread",
    thread_metadata: {
      archived: options.archived ?? false,
      locked: options.locked ?? false,
      auto_archive_duration: 60,
      archive_timestamp: "2026-09-24T00:00:00Z",
    },
  };
  f.channels.set(f.threadId, channel);
  f.messages.set(f.threadId, [
    f.message(snowflake(), f.threadId, "thread message"),
  ]);
  return channel;
}

function history(f: Fixture, channelId = f.channelId) {
  return f.read.history({
    headers: f.headers,
    query: { channelId, limit: 50 },
  });
}

function send(f: Fixture, channelId = f.channelId, text = "hello") {
  return f.write.sendMessage({ headers: f.headers, body: { channelId, text } });
}

describe("Discord native authorization and reads", () => {
  it("returns exact snowflake pagination and source links", async () => {
    const f = await fixture();
    f.messages.set(f.channelId, [
      f.message("18446744073709551614"),
      f.message("18446744073709551613"),
      f.message("18446744073709551612"),
    ]);
    const first = await accept(
      f.read.history({
        headers: f.headers,
        query: { channelId: f.channelId, limit: 2 },
      }),
      [200],
    );
    expect(first.body.nextBefore).toBe("18446744073709551613");
    expect(
      first.body.messages.map((entry) => {
        return entry.id;
      }),
    ).toStrictEqual(["18446744073709551614", "18446744073709551613"]);
    expect(first.body.messages[0]?.url).toBe(
      `https://discord.com/channels/${f.guildId}/${f.channelId}/18446744073709551614`,
    );
    const second = await accept(
      f.read.history({
        headers: f.headers,
        query: {
          channelId: f.channelId,
          limit: 2,
          before: first.body.nextBefore!,
        },
      }),
      [200],
    );
    expect(
      second.body.messages.map((entry) => {
        return entry.id;
      }),
    ).toStrictEqual(["18446744073709551612"]);
    expect(second.body.nextBefore).toBeNull();
  });

  it("marks ordinary guild content as limited without affecting bot DM identity", async () => {
    const f = await fixture({ messageContent: false });
    expect((await accept(history(f), [200])).body.contextMode).toBe(
      "mentions_only",
    );
    f.channels.set(f.channelId, {
      id: f.channelId,
      type: 1,
      recipients: [{ id: f.discordUserId, username: "sender" }],
    });
    const dm = await accept(history(f), [200]);
    expect(dm.body.contextMode).toBe("full");
    expect(dm.body.messages[0]?.url).toContain("/channels/@me/");
  });

  it.each([
    "different-guild",
    "other-user-dm",
    "group-dm",
    "missing-user",
    "missing-bot",
  ] as const)(
    "denies %s without exposing message contents",
    async (scenario) => {
      const f = await fixture();
      if (scenario === "different-guild") {
        f.channels.set(f.channelId, {
          id: f.channelId,
          type: 0,
          guild_id: snowflake(),
          name: "private",
          permission_overwrites: [],
        });
      }
      if (scenario === "other-user-dm") {
        f.channels.set(f.channelId, {
          id: f.channelId,
          type: 1,
          recipients: [{ id: snowflake(), username: "someone else" }],
        });
      }
      if (scenario === "group-dm") {
        f.channels.set(f.channelId, {
          id: f.channelId,
          type: 3,
          recipients: [{ id: f.discordUserId, username: "sender" }],
        });
      }
      if (scenario === "missing-user") {
        f.state.userMember = false;
      }
      if (scenario === "missing-bot") {
        f.state.botMember = false;
      }
      const response = await accept(history(f), [404]);
      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(response.body).not.toHaveProperty("messages");
      expect((await accept(send(f), [404])).body.error.code).toBe("NOT_FOUND");
    },
  );

  it("denies an explicit different guild selector and another organization token", async () => {
    const f = await fixture();
    await accept(
      f.read.history({
        headers: f.headers,
        query: { guildId: snowflake(), channelId: f.channelId, limit: 50 },
      }),
      [404],
    );
    const other = await fixture();
    const denied = await accept(
      f.read.history({
        headers: other.headers,
        query: { channelId: f.channelId, guildId: f.guildId, limit: 50 },
      }),
      [404],
    );
    expect(denied.body.error.code).toBe("NOT_FOUND");
  });

  it("applies everyone, aggregated role, and member overwrite precedence", async () => {
    const f = await fixture();
    const channel = f.channels.get(f.channelId)!;
    channel.permission_overwrites = [
      { id: f.guildId, type: 0, deny: String(VIEW), allow: "0" },
      { id: f.userRoleId, type: 0, deny: String(VIEW), allow: "0" },
      { id: f.extraRoleId, type: 0, deny: "0", allow: String(VIEW) },
      { id: f.botRoleId, type: 0, deny: "0", allow: String(VIEW) },
    ];
    expect((await accept(history(f), [200])).body.messages).toHaveLength(1);
    channel.permission_overwrites.push({
      id: f.discordUserId,
      type: 1,
      deny: String(VIEW),
      allow: "0",
    });
    await accept(history(f), [404]);
    channel.permission_overwrites[4] = {
      id: f.discordUserId,
      type: 1,
      deny: "0",
      allow: String(VIEW),
    };
    expect((await accept(history(f), [200])).body.messages).toHaveLength(1);
  });

  it("lists only mutually visible message channels and requires history permission to read", async () => {
    const f = await fixture();
    const hidden = snowflake();
    f.channels.set(hidden, {
      id: hidden,
      guild_id: f.guildId,
      type: 0,
      name: "hidden",
      permission_overwrites: [
        { id: f.botUserId, type: 1, deny: String(VIEW), allow: "0" },
      ],
    });
    const listed = await accept(
      f.read.listChannels({ headers: f.headers, query: {} }),
      [200],
    );
    expect(
      listed.body.channels.map((channel) => {
        return channel.id;
      }),
    ).toStrictEqual([f.channelId]);
    f.channels.get(f.channelId)!.permission_overwrites = [
      { id: f.discordUserId, type: 1, deny: String(READ), allow: "0" },
    ];
    await accept(history(f), [404]);
  });

  it.each(["user", "bot"] as const)(
    "requires private thread membership for the %s",
    async (party) => {
      const f = await fixture();
      addThread(f, { private: true });
      f.threadMembers.delete(party === "user" ? f.discordUserId : f.botUserId);
      expect(
        (await accept(history(f, f.threadId), [404])).body.error.code,
      ).toBe("NOT_FOUND");
      expect((await accept(send(f, f.threadId), [404])).body.error.code).toBe(
        "NOT_FOUND",
      );
    },
  );

  it("reads a private thread with both memberships and inherits parent overwrites", async () => {
    const f = await fixture();
    addThread(f, { private: true });
    expect(
      (await accept(history(f, f.threadId), [200])).body.messages[0]?.content,
    ).toBe("thread message");
    f.channels.get(f.channelId)!.permission_overwrites = [
      { id: f.discordUserId, type: 1, deny: String(VIEW), allow: "0" },
    ];
    expect((await accept(history(f, f.threadId), [404])).body.error.code).toBe(
      "NOT_FOUND",
    );
  });

  it("reads native thread replies and refuses to treat an ordinary reply as a thread", async () => {
    const f = await fixture();
    const thread = addThread(f);
    const parent = { ...f.message(f.threadId), thread, flags: 32 };
    f.messages.set(f.channelId, [parent]);
    const response = await accept(
      f.read.replies({
        headers: f.headers,
        query: { channelId: f.channelId, messageId: parent.id, limit: 50 },
      }),
      [200],
    );
    expect(response.body.threadId).toBe(f.threadId);
    expect(response.body.messages[0]?.content).toBe("thread message");
    f.messages.set(f.channelId, [
      {
        ...f.message(parent.id),
        message_reference: { message_id: snowflake() },
      },
    ]);
    await accept(
      f.read.replies({
        headers: f.headers,
        query: { channelId: f.channelId, messageId: parent.id, limit: 50 },
      }),
      [404],
    );
  });

  it("enforces default-off and token capabilities for reads and writes", async () => {
    const f = await fixture({ enabled: false });
    await accept(history(f), [403]);
    await accept(send(f), [403]);
    const limited = await fixture({ capabilities: ["slack:read"] });
    expect(
      (await accept(history(limited), [403])).body.error.message,
    ).toContain("discord:read");
    expect((await accept(send(limited), [403])).body.error.message).toContain(
      "discord:write",
    );
  });

  it("revokes native access after disconnect without reusing a previously verified binding", async () => {
    const f = await fixture();
    await accept(history(f), [200]);
    createRouteMocks(context).clerk.session(f.userId, f.orgId, "org:admin");
    await accept(
      setupApp({ context, routes: integrationsDiscordRoutes })(
        integrationsDiscordContract,
      ).disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: { action: "disconnect" },
      }),
      [200],
    );
    await accept(history(f), [404]);
    expect((await accept(send(f), [404])).body.error.code).toBe("NOT_FOUND");
  });
});

describe("Discord native sends and transport failures", () => {
  it("preserves a long fenced answer and suppresses all mention notifications", async () => {
    const f = await fixture();
    const source =
      "```ts\n" +
      "const value = 1;\n".repeat(400) +
      "```\n@everyone <@123456789012345678>";
    const result = await accept(send(f, f.channelId, source), [200]);
    expect(result.body.messages.length).toBeGreaterThan(1);
    const read = await accept(history(f), [200]);
    const byId = new Map(
      read.body.messages.map((entry) => {
        return [entry.id, entry];
      }),
    );
    const chunks = result.body.messages.map((receipt) => {
      return byId.get(receipt.id)?.content ?? "";
    });
    expect(
      chunks.every((chunk) => {
        return chunk.length <= 2000;
      }),
    ).toBeTruthy();
    expect(chunks.join("").replaceAll(/```ts\n|```\n?/g, "")).toBe(
      source.replaceAll(/```ts\n|```\n?/g, ""),
    );
    expect(
      f.sentBodies.every((body) => {
        return (
          body.allowed_mentions.parse.length === 0 &&
          body.allowed_mentions.replied_user === false
        );
      }),
    ).toBeTruthy();
    expect(
      result.body.messages.every((entry) => {
        return entry.url.endsWith(`/${entry.id}`);
      }),
    ).toBeTruthy();
  });

  it.each(["archived", "locked"] as const)(
    "reads but refuses sending into %s threads",
    async (state) => {
      const f = await fixture();
      addThread(f, { [state]: true });
      await accept(history(f, f.threadId), [200]);
      expect((await accept(send(f, f.threadId), [403])).body.error.code).toBe(
        "DISCORD_THREAD_CLOSED",
      );
    },
  );

  it.each(["user", "bot"] as const)(
    "denies writes for a timed-out %s while retaining readable history",
    async (party) => {
      const f = await fixture();
      if (party === "user") {
        f.state.userTimedOut = true;
      } else {
        f.state.botTimedOut = true;
      }
      await accept(history(f), [200]);
      expect((await accept(send(f), [404])).body.error.code).toBe("NOT_FOUND");
    },
  );

  it("requires SEND_MESSAGES_IN_THREADS rather than parent SEND_MESSAGES", async () => {
    const f = await fixture();
    addThread(f);
    f.channels.get(f.channelId)!.permission_overwrites = [
      { id: f.discordUserId, type: 1, deny: String(SEND), allow: "0" },
    ];
    await accept(send(f, f.threadId), [200]);
    f.channels.get(f.channelId)!.permission_overwrites = [
      { id: f.discordUserId, type: 1, deny: String(THREAD_SEND), allow: "0" },
    ];
    expect((await accept(send(f, f.threadId), [404])).body.error.code).toBe(
      "NOT_FOUND",
    );
  });

  it("retries only an explicit short 429 and returns a complete message receipt", async () => {
    const f = await fixture();
    server.use(
      http.post(
        `${API}/channels/${f.channelId}/messages`,
        () => {
          return HttpResponse.json(
            { retry_after: 0, global: true },
            { status: 429 },
          );
        },
        { once: true },
      ),
    );
    const result = await accept(send(f), [200]);
    expect(result.body.messages).toHaveLength(1);
    expect(
      (await accept(history(f), [200])).body.messages.filter((entry) => {
        return entry.author.bot;
      }),
    ).toHaveLength(1);
  });

  it.each(["binding", "feature", "channel"] as const)(
    "rechecks %s access after a rate limit before resending",
    async (revoked) => {
      const f = await fixture();
      server.use(
        http.post(
          `${API}/channels/${f.channelId}/messages`,
          async () => {
            if (revoked === "binding") {
              createRouteMocks(context).clerk.session(
                f.userId,
                f.orgId,
                "org:admin",
              );
              await accept(
                setupApp({ context, routes: integrationsDiscordRoutes })(
                  integrationsDiscordContract,
                ).disconnect({
                  headers: { authorization: "Bearer clerk-session" },
                  query: { action: "disconnect" },
                }),
                [200],
              );
            } else if (revoked === "feature") {
              await updateFeatureSwitchesForUser(
                context,
                { orgId: f.orgId, userId: f.userId, orgRole: "org:admin" },
                { [FeatureSwitchKey.DiscordIntegration]: false },
              );
            } else {
              f.channels.get(f.channelId)!.permission_overwrites = [
                {
                  id: f.discordUserId,
                  type: 1,
                  deny: String(SEND),
                  allow: "0",
                },
              ];
            }
            return HttpResponse.json(
              { retry_after: 0, global: false },
              { status: 429 },
            );
          },
          { once: true },
        ),
      );
      const response = await accept(send(f), [403, 404]);
      expect(response.body.error.deliveredMessages).toStrictEqual([]);
      expect(f.sentBodies).toStrictEqual([]);
    },
  );

  it("surfaces read rate limits without replaying an authorized content request", async () => {
    const f = await fixture();
    server.use(
      http.get(
        `${API}/channels/${f.channelId}/messages`,
        () => {
          return HttpResponse.json(
            { retry_after: 0, global: false },
            { status: 429 },
          );
        },
        { once: true },
      ),
    );
    const limited = await accept(history(f), [429]);
    expect(limited.body.error.retryAfterSeconds).toBe(0);
    await accept(history(f), [200]);
  });

  it("reports a provider rate-limit delay and preserves already-delivered chunks", async () => {
    const f = await fixture();
    const first = f.message(snowflake(), f.channelId, "first");
    server.use(
      http.post(`${API}/channels/${f.channelId}/messages`, () => {
        return HttpResponse.json(
          { retry_after: 60, global: false },
          { status: 429 },
        );
      }),
    );
    server.use(
      http.post(
        `${API}/channels/${f.channelId}/messages`,
        () => {
          return HttpResponse.json(first);
        },
        { once: true },
      ),
    );
    const result = await accept(send(f, f.channelId, "x".repeat(4001)), [429]);
    expect(result.body.error.retryAfterSeconds).toBe(60);
    expect(result.body.error.message).toContain("60 seconds");
    expect(
      result.body.error.deliveredMessages?.map((entry) => {
        return entry.id;
      }),
    ).toStrictEqual([first.id]);
  });

  it("surfaces a provider server failure without resending an uncertain write", async () => {
    const f = await fixture();
    server.use(
      http.post(
        `${API}/channels/${f.channelId}/messages`,
        () => {
          return HttpResponse.json({ message: "uncertain" }, { status: 500 });
        },
        { once: true },
      ),
    );
    await accept(send(f), [502]);
    const read = await accept(history(f), [200]);
    expect(
      read.body.messages.filter((entry) => {
        return entry.author.bot;
      }),
    ).toStrictEqual([]);
  });
});
