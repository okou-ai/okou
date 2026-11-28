import { randomInt, randomUUID } from "node:crypto";

import {
  integrationsTelegramContract,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { array, number, object, optional, string, union } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsTelegramRoutes } from "../integrations-telegram";
import { integrationsTelegramLinkRoutes } from "../integrations-telegram-link";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const memberships = createStore();

const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const APP_URL = "https://app.okou.ai";
const CLOCK_2026_10_15_12_00_00Z_MS = 1_792_065_600_000;
const CLOCK_2026_10_15_12_00_00Z_SECONDS = 1_792_065_600;

const inlineButtonSchema = object({
  text: string(),
  url: optional(string()),
});

const sentMessageSchema = object({
  chat_id: union([string(), number()]),
  text: string(),
  reply_parameters: optional(object({ message_id: number() })),
  reply_markup: optional(
    object({
      inline_keyboard: array(array(inlineButtonSchema)),
    }),
  ),
});

interface SentTelegramMessage {
  readonly chatId: string;
  readonly text: string;
  readonly replyToMessageId: number | undefined;
  readonly buttons: readonly {
    readonly text: string;
    readonly url: string | undefined;
  }[];
}

function configureOfficialBot(botNumericId = 9_876_543_210): void {
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", `${botNumericId}:${randomUUID()}`);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "official_okou_bot");
  mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", randomUUID());
}

function configuredWebhookSecret(): string {
  const secret = env("TELEGRAM_OFFICIAL_WEBHOOK_SECRET");
  if (!secret) {
    throw new Error("Expected TELEGRAM_OFFICIAL_WEBHOOK_SECRET to be set");
  }
  return secret;
}

function serveTelegramSendMessage(): SentTelegramMessage[] {
  const sent: SentTelegramMessage[] = [];
  server.use(
    http.post(
      "https://api.telegram.org/:bot/sendMessage",
      async ({ request }) => {
        const parsed = sentMessageSchema.parse(await request.json());
        const buttons = (parsed.reply_markup?.inline_keyboard ?? [])
          .flat()
          .map((button) => {
            return { text: button.text, url: button.url };
          });
        sent.push({
          chatId: String(parsed.chat_id),
          text: parsed.text,
          replyToMessageId: parsed.reply_parameters?.message_id,
          buttons,
        });
        return HttpResponse.json({
          ok: true,
          result: {
            message_id: sent.length,
            date: Math.floor(now() / 1000),
            chat: { id: Number(parsed.chat_id), type: "private" },
            text: parsed.text,
          },
        });
      },
    ),
  );
  return sent;
}

function telegramClient() {
  return setupApp({ context, routes: integrationsTelegramRoutes })(
    integrationsTelegramContract,
  );
}

function linkClient() {
  return setupApp({ context, routes: integrationsTelegramLinkRoutes })(
    integrationsTelegramContract,
  );
}

async function onboardedMember() {
  const member = {
    userId: `user_tg_${randomUUID()}`,
    orgId: `org_tg_${randomUUID()}`,
  };
  await memberships.set(
    seedOrgMembership$,
    { orgId: member.orgId, userId: member.userId, role: "member" },
    context.signal,
  );
  return member;
}

function signIn(member: { readonly userId: string; readonly orgId: string }) {
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    "org:member",
  );
  return SESSION;
}

function uniqueTelegramUserId(): number {
  return randomInt(1_000_000_000, 2_000_000_000);
}

describe("POST /api/telegram/webhook/:telegramBotId", () => {
  it("integrations-telegram-post-006 validates the webhook secret", async () => {
    configureOfficialBot();
    await onboardedMember();

    const response = await accept(
      telegramClient().webhook({
        params: { telegramBotId: OFFICIAL_TELEGRAM_BOT_ID },
        body: {},
        extraHeaders: {
          "x-telegram-bot-api-secret-token": "wrong-secret",
        },
      }),
      [401],
    );

    expect(response.body).toBe("Unauthorized");
  });

  it("integrations-telegram-post-004 keeps group Connect private with bot username official_okou_bot", async () => {
    configureOfficialBot();
    const sent = serveTelegramSendMessage();
    const senderId = uniqueTelegramUserId();

    await accept(
      telegramClient().webhook({
        params: { telegramBotId: OFFICIAL_TELEGRAM_BOT_ID },
        body: {
          update_id: randomInt(1, 1_000_000_000),
          message: {
            message_id: 197,
            date: Math.floor(now() / 1000),
            chat: { id: -40_197, type: "supergroup", title: "Ops Group" },
            from: { id: senderId, is_bot: false, first_name: "Alice" },
            text: "/connect",
            entities: [{ type: "bot_command", offset: 0, length: 8 }],
          },
        },
        extraHeaders: {
          "x-telegram-bot-api-secret-token": configuredWebhookSecret(),
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(sent).toHaveLength(1);
    const [reply] = sent;
    if (!reply) {
      throw new Error("Expected one Telegram group connect message");
    }
    expect(reply.chatId).toBe("-40197");
    expect(reply.replyToMessageId).toBe(197);
    expect(reply.text).not.toContain("https://app.");
    expect(reply.buttons).toStrictEqual([
      {
        text: "Connect",
        url: "https://t.me/official_okou_bot?start=connect",
      },
    ]);
  });

  it("integrations-telegram-post-033 does not prompt unlinked official group replies to another bot but prompts replies to the official bot", async () => {
    configureOfficialBot(987_654);
    const sent = serveTelegramSendMessage();
    const senderId = uniqueTelegramUserId();
    const groupId = -10_099_121;

    await accept(
      telegramClient().webhook({
        params: { telegramBotId: OFFICIAL_TELEGRAM_BOT_ID },
        body: {
          update_id: randomInt(1, 1_000_000_000),
          message: {
            message_id: 1211,
            date: Math.floor(now() / 1000),
            chat: { id: groupId, type: "supergroup", title: "Release Group" },
            from: { id: senderId, is_bot: false, first_name: "Bob" },
            text: "replying to another bot",
            reply_to_message: {
              message_id: 1200,
              date: Math.floor(now() / 1000) - 10,
              chat: { id: groupId, type: "supergroup", title: "Release Group" },
              from: {
                id: 555_123,
                is_bot: true,
                username: "other_bot",
                first_name: "Other",
              },
              text: "hello from another bot",
            },
          },
        },
        extraHeaders: {
          "x-telegram-bot-api-secret-token": configuredWebhookSecret(),
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(sent).toHaveLength(0);

    mockEnv("APP_URL", APP_URL);
    await accept(
      telegramClient().webhook({
        params: { telegramBotId: OFFICIAL_TELEGRAM_BOT_ID },
        body: {
          update_id: randomInt(1, 1_000_000_000),
          message: {
            message_id: 1212,
            date: Math.floor(now() / 1000),
            chat: { id: groupId, type: "supergroup", title: "Release Group" },
            from: { id: senderId, is_bot: false, first_name: "Bob" },
            text: "replying to the official bot",
            reply_to_message: {
              message_id: 1201,
              date: Math.floor(now() / 1000) - 5,
              chat: { id: groupId, type: "supergroup", title: "Release Group" },
              from: {
                id: 987_654,
                is_bot: true,
                username: "provider_renamed_bot",
                first_name: "Provider Renamed",
              },
              text: "official bot message",
            },
          },
        },
        extraHeaders: {
          "x-telegram-bot-api-secret-token": configuredWebhookSecret(),
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(sent).toHaveLength(1);
    const [reply] = sent;
    if (!reply) {
      throw new Error("Expected one Telegram prompt reply");
    }
    expect(reply.text).toContain("connect your account");
    expect(reply.text).toContain("Okou");
    expect(reply.replyToMessageId).toBe(1212);
    expect(reply.buttons).toStrictEqual([
      {
        text: "Connect",
        url: "https://t.me/official_okou_bot?start=connect",
      },
    ]);
  });

  it("integrations-telegram-post-001 binds the canonical private Connect link with normalized username and display name", async () => {
    configureOfficialBot();
    mockEnv("APP_URL", APP_URL);
    mockNow(CLOCK_2026_10_15_12_00_00Z_MS);
    const sent = serveTelegramSendMessage();
    const member = await onboardedMember();
    const senderId = uniqueTelegramUserId();

    await accept(
      telegramClient().webhook({
        params: { telegramBotId: OFFICIAL_TELEGRAM_BOT_ID },
        body: {
          update_id: randomInt(1, 1_000_000_000),
          message: {
            message_id: 101,
            date: CLOCK_2026_10_15_12_00_00Z_SECONDS,
            chat: { id: senderId, type: "private" },
            from: {
              id: senderId,
              is_bot: false,
              username: "  @alice_connect  ",
              first_name: "  Alice   &  ",
              last_name: "  王  ",
            },
            text: "/connect",
            entities: [{ type: "bot_command", offset: 0, length: 8 }],
          },
        },
        extraHeaders: {
          "x-telegram-bot-api-secret-token": configuredWebhookSecret(),
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(sent).toHaveLength(1);
    const [connectMessage] = sent;
    if (!connectMessage) {
      throw new Error("Expected one private Telegram Connect message");
    }
    expect(connectMessage.chatId).toBe(String(senderId));
    expect(connectMessage.buttons).toHaveLength(1);
    const [connectButton] = connectMessage.buttons;
    if (!connectButton?.url) {
      throw new Error("Expected a Connect button with URL");
    }
    expect(connectButton.text).toBe("Connect");

    const connectUrl = new URL(connectButton.url);
    expect(connectUrl.origin).toBe(APP_URL);
    expect(connectUrl.pathname).toBe("/settings/telegram");
    expect([...connectUrl.searchParams.keys()].sort()).toStrictEqual([
      "bot",
      "sig",
      "tgDisplayName",
      "tgUser",
      "tgUserName",
      "ts",
    ]);
    expect(connectUrl.searchParams.get("bot")).toBe(OFFICIAL_TELEGRAM_BOT_ID);
    expect(connectUrl.searchParams.get("tgUser")).toBe(String(senderId));
    expect(connectUrl.searchParams.get("ts")).toBe(
      String(CLOCK_2026_10_15_12_00_00Z_SECONDS),
    );
    const sig = connectUrl.searchParams.get("sig") ?? "";
    expect(sig).toMatch(/^[0-9a-f]{64}$/u);
    expect(connectUrl.searchParams.get("tgUserName")).toBe("alice_connect");
    expect(connectUrl.searchParams.get("tgDisplayName")).toBe("Alice & 王");

    const beforeList = await accept(
      telegramClient().list({ headers: signIn(member) }),
      [200],
    );
    const beforeOfficial = beforeList.body.bots.find((bot) => {
      return bot.id === OFFICIAL_TELEGRAM_BOT_ID;
    });
    expect(beforeOfficial).toMatchObject({
      isConnected: false,
      connectedUser: null,
    });

    const linked = await accept(
      linkClient().link({
        headers: signIn(member),
        body: {
          telegramBotId: connectUrl.searchParams.get("bot") ?? "",
          connectSignature: {
            telegramUserId: connectUrl.searchParams.get("tgUser") ?? "",
            timestamp: Number(connectUrl.searchParams.get("ts")),
            signature: sig,
            telegramUsername:
              connectUrl.searchParams.get("tgUserName") ?? undefined,
            telegramDisplayName:
              connectUrl.searchParams.get("tgDisplayName") ?? undefined,
          },
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(linked.body).toStrictEqual({
      telegramUserId: String(senderId),
      botUsername: "official_okou_bot",
    });

    const status = await accept(
      telegramClient().getLinkStatus({
        headers: signIn(member),
        query: { botId: OFFICIAL_TELEGRAM_BOT_ID },
      }),
      [200],
    );
    expect(status.body).toStrictEqual({
      linked: true,
      telegramUserId: String(senderId),
      botUsername: "official_okou_bot",
    });

    const afterList = await accept(
      telegramClient().list({ headers: signIn(member) }),
      [200],
    );
    const afterOfficial = afterList.body.bots.find((bot) => {
      return bot.id === OFFICIAL_TELEGRAM_BOT_ID;
    });
    expect(afterOfficial).toMatchObject({
      isConnected: true,
      connectedUser: {
        telegramUserId: String(senderId),
        telegramUsername: "alice_connect",
        telegramDisplayName: "Alice & 王",
      },
      official: {
        configured: true,
        linkedTelegramUserId: String(senderId),
      },
    });
  });
});
