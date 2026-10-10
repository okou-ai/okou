import { revokedChatEventIds } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { integrationsDiscordMessageContract } from "@okouai/api-contracts/contracts/integrations-discord-message";
import { integrationsDiscordReadContract } from "@okouai/api-contracts/contracts/integrations-discord-read";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { DiscordMessage } from "../../external/discord-client";
import { integrationsDiscordMessageRoutes } from "../integrations-discord-message";
import { integrationsDiscordReadRoutes } from "../integrations-discord-read";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import {
  removePublicDiscordBinding,
  mockDiscordApplication,
  uniqueDiscordSnowflake,
} from "./helpers/discord";
import {
  discordChatThreads,
  discordMessageForTest,
  mockDiscordProvider,
  postDiscordMessage,
  setupConnectedDiscordActor,
  type ConnectedDiscordActor,
} from "./helpers/discord-fixture";
import { deleteFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";

const context = testContext();
const runsApi = createRunsApi(context);
const API = "https://discord.com/api/v10";
const VIEW = 1n << 10n;
const SEND = 1n << 11n;
const READ = 1n << 16n;
const THREAD_SEND = 1n << 38n;
const track = createFixtureTracker<ConnectedDiscordActor>(async (actor) => {
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

async function claimMessage(
  actor: ConnectedDiscordActor,
  message: ReturnType<typeof discordMessageForTest>,
) {
  await postDiscordMessage(context, message);
  await flushWaitUntilForTest();
  const [thread] = await discordChatThreads(context, actor);
  if (!thread) {
    throw new Error("Expected a publicly admitted Discord thread");
  }
  const [input] = currentInputs(await events(actor, thread.id));
  if (!input?.runId) {
    throw new Error("Expected a publicly admitted Run");
  }
  await runsApi.heartbeatRunner(actor.runnerGroup);
  return {
    runId: input.runId,
    claim: await runsApi.claimRunnerJob(input.runId),
  };
}

function botReplyBefore(
  actor: ConnectedDiscordActor,
  provider: ReturnType<typeof mockDiscordProvider>,
  next: ReturnType<typeof discordMessageForTest>,
  content: string,
) {
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

const sendBodySchema = z.object({
  content: z.string(),
  message_reference: z
    .object({
      message_id: z.string(),
      fail_if_not_exists: z.boolean(),
    })
    .optional(),
  allowed_mentions: z.object({
    parse: z.array(z.string()),
    replied_user: z.boolean(),
  }),
});

/** Product OAuth installation/member linking precedes all native scenarios. */
async function nativeFixture() {
  const actor = await connected();
  const provider = mockDiscordProvider(actor);
  mockDiscordApplication(1 << 18);
  provider.state.everyonePermissions = String(VIEW | SEND | READ | THREAD_SEND);
  const { token } = await runsApi.createCliToken(actor.actor);
  const headers = { authorization: `Bearer ${token}` };
  const messages = new Map<string, DiscordMessage[]>();
  const sentBodies: z.infer<typeof sendBodySchema>[] = [];
  const message = (
    id = uniqueDiscordSnowflake(),
    channelId = provider.guildChannelId,
    content = "hello",
  ): DiscordMessage => {
    return discordMessageForTest(actor, { id, channelId, content });
  };
  messages.set(provider.guildChannelId, [message()]);
  server.use(
    http.get(`${API}/channels/:channelId/messages/:messageId`, ({ params }) => {
      const found = messages.get(String(params.channelId))?.find((entry) => {
        return entry.id === params.messageId;
      });
      return found
        ? HttpResponse.json(found)
        : HttpResponse.json({ code: 10_008 }, { status: 404 });
    }),
    http.get(`${API}/channels/:channelId/messages`, ({ params, request }) => {
      const query = new URL(request.url).searchParams;
      const before = query.get("before");
      const entries = (messages.get(String(params.channelId)) ?? [])
        .filter((entry) => {
          return before === null || BigInt(entry.id) < BigInt(before);
        })
        .sort((left, right) => {
          return BigInt(left.id) > BigInt(right.id) ? -1 : 1;
        });
      return HttpResponse.json(entries.slice(0, Number(query.get("limit"))));
    }),
    http.post(
      `${API}/channels/:channelId/messages`,
      async ({ params, request }) => {
        const body = sendBodySchema.parse(await request.json());
        const channelId = String(params.channelId);
        if (
          body.message_reference &&
          !messages.get(channelId)?.some((entry) => {
            return entry.id === body.message_reference?.message_id;
          })
        ) {
          return HttpResponse.json({ code: 10_008 }, { status: 404 });
        }
        sentBodies.push(body);
        const entry = {
          ...message(uniqueDiscordSnowflake(), channelId, body.content),
          author: { id: actor.botUserId, username: "Okou", bot: true },
          ...(body.message_reference
            ? { message_reference: body.message_reference }
            : {}),
        };
        const entries = messages.get(channelId) ?? [];
        entries.push(entry);
        messages.set(channelId, entries);
        return HttpResponse.json(entry);
      },
    ),
  );
  return {
    ...actor,
    channelId: provider.guildChannelId,
    channels: provider.channels,
    messages,
    sentBodies,
    message,
    headers,
    write: setupApp({ context, routes: integrationsDiscordMessageRoutes })(
      integrationsDiscordMessageContract,
    ),
    read: setupApp({ context, routes: integrationsDiscordReadRoutes })(
      integrationsDiscordReadContract,
    ),
  };
}

function history(fixture: Awaited<ReturnType<typeof nativeFixture>>) {
  return fixture.read.history({
    headers: fixture.headers,
    query: { channelId: fixture.channelId, limit: 100 },
  });
}

function send(fixture: Awaited<ReturnType<typeof nativeFixture>>) {
  return fixture.write.sendMessage({
    headers: fixture.headers,
    body: { channelId: fixture.channelId, text: "ordinary write" },
  });
}

describe("Discord context parity through public OAuth bindings", () => {
  it("combines parent context, the thread starter, an older quoted message and attachment-only history within one bounded snapshot", async () => {
    const actor = await connected();
    const provider = mockDiscordProvider(actor);
    mockDiscordApplication(1 << 18);
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
    mockDiscordApplication(1 << 18);
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
    mockDiscordApplication(1 << 18);
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
    const { claim } = await claimMessage(
      actor,
      discordMessageForTest(actor, {
        channelId: provider.guildChannelId,
        content: `<@${actor.botUserId}> start a task`,
      }),
    );
    const token = claim.platformEnvironment.OKOU_TOKEN;
    if (!token) {
      throw new Error(
        "Expected the actual Runner claim's native integration token",
      );
    }
    const headers = { authorization: `Bearer ${token}` };
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
});

describe("Discord reply parity through public OAuth bindings", () => {
  it("references the same-channel message only on the first long-message chunk", async () => {
    const f = await nativeFixture();
    const root = f.message("18446744073709551610");
    f.messages.set(f.channelId, [root]);
    const text = "x".repeat(4001);
    const response = await accept(
      f.write.sendMessage({
        headers: f.headers,
        body: { channelId: f.channelId, replyToMessageId: root.id, text },
      }),
      [200],
    );
    expect(response.body.messages).toHaveLength(3);
    const page = await accept(history(f), [200]);
    const delivered = response.body.messages.map((receipt) => {
      return page.body.messages.find((entry) => {
        return entry.id === receipt.id;
      });
    });
    expect(delivered[0]?.replyTo).toStrictEqual({ messageId: root.id });
    expect(
      delivered.slice(1).every((entry) => {
        return entry?.replyTo === undefined;
      }),
    ).toBeTruthy();
    expect(
      delivered
        .map((entry) => {
          return entry?.content;
        })
        .join(""),
    ).toBe(text);
    expect(
      f.sentBodies.every((body) => {
        return (
          body.allowed_mentions.parse.length === 0 &&
          !body.allowed_mentions.replied_user
        );
      }),
    ).toBeTruthy();
  });

  it.each(["deleted", "other-channel"] as const)(
    "does not deliver a reply to a %s message",
    async (location) => {
      const f = await nativeFixture();
      const target = f.message(
        uniqueDiscordSnowflake(),
        uniqueDiscordSnowflake(),
        "Not in the destination",
      );
      if (location === "other-channel") {
        f.messages.set(target.channel_id, [target]);
      }
      const denied = await accept(
        f.write.sendMessage({
          headers: f.headers,
          body: {
            channelId: f.channelId,
            replyToMessageId: target.id,
            text: "Reply",
          },
        }),
        [404],
      );
      expect(denied.body.error.deliveredMessages).toStrictEqual([]);
      expect(
        (await accept(history(f), [200])).body.messages.every((entry) => {
          return !entry.author.bot;
        }),
      ).toBeTruthy();
    },
  );

  it("revalidates write access after reading a reply target", async () => {
    const f = await nativeFixture();
    const root = f.messages.get(f.channelId)?.[0];
    const channel = f.channels.get(f.channelId);
    if (!root || !channel) {
      throw new Error("Expected a reference target and destination channel");
    }
    server.use(
      http.get(`${API}/channels/${f.channelId}/messages/${root.id}`, () => {
        channel.permission_overwrites = [
          { id: f.discordUserId, type: 1, deny: String(SEND), allow: "0" },
        ];
        return HttpResponse.json(root);
      }),
    );
    const denied = await accept(
      f.write.sendMessage({
        headers: f.headers,
        body: {
          channelId: f.channelId,
          replyToMessageId: root.id,
          text: "Do not deliver after write access is revoked",
        },
      }),
      [404],
    );
    expect(channel.permission_overwrites).toContainEqual({
      id: f.discordUserId,
      type: 1,
      deny: String(SEND),
      allow: "0",
    });
    expect(denied.body.error.code).toBe("NOT_FOUND");
    expect(denied.body.error.deliveredMessages).toStrictEqual([]);
    expect(f.sentBodies).toStrictEqual([]);
  });

  it("requires shared history access for a guild reply without restricting ordinary writes", async () => {
    const f = await nativeFixture();
    const root = f.messages.get(f.channelId)?.[0];
    if (!root) {
      throw new Error("Expected a reference target");
    }
    const channel = f.channels.get(f.channelId);
    if (!channel) {
      throw new Error("Expected the authorized channel");
    }
    channel.permission_overwrites = [
      { id: f.discordUserId, type: 1, deny: String(READ), allow: "0" },
    ];
    const denied = await accept(
      f.write.sendMessage({
        headers: f.headers,
        body: {
          channelId: f.channelId,
          replyToMessageId: root.id,
          text: "Reply",
        },
      }),
      [404],
    );
    expect(denied.body.error.deliveredMessages).toStrictEqual([]);
    const written = await accept(send(f), [200]);
    expect(written.body.messages).toHaveLength(1);
  });

  it("references the sender's own bot DM without reading its content", async () => {
    const f = await nativeFixture();
    const dmId = uniqueDiscordSnowflake();
    f.channels.set(dmId, {
      id: dmId,
      type: 1,
      recipients: [{ id: f.discordUserId, username: "sender" }],
    });
    const root = f.message(
      uniqueDiscordSnowflake(),
      dmId,
      "Private DM content",
    );
    f.messages.set(dmId, [root]);
    server.use(
      http.get(`${API}/channels/${dmId}/messages/:messageId`, () => {
        return HttpResponse.json(
          { message: "DM reads are forbidden" },
          { status: 500 },
        );
      }),
    );
    const response = await accept(
      f.write.sendMessage({
        headers: f.headers,
        body: {
          channelId: dmId,
          replyToMessageId: root.id,
          text: "Own DM reply",
        },
      }),
      [200],
    );
    expect(response.body.messages[0]?.channelId).toBe(dmId);
    expect(JSON.stringify(response.body)).not.toContain(root.content);
    expect(f.sentBodies[0]?.message_reference?.message_id).toBe(root.id);
  });
});
