import { randomInt, randomUUID } from "node:crypto";

import { integrationsTelegramDownloadFileContract } from "@okouai/api-contracts/contracts/integrations";
import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsTelegramRoutes } from "../integrations-telegram";
import { integrationsTelegramLinkRoutes } from "../integrations-telegram-link";
import type { ApiTestUser } from "./helpers/api-bdd";
import { telegramLoginAuth } from "./helpers/api-bdd-integrations";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const memberships = createStore();

const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const OFFICIAL_BOT_ID = "9876543210";
const LINKED_TEXT =
  "✅ Account linked.\nSend me a message to start chatting with Okou.";

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

interface TelegramSent {
  readonly bot: string;
  readonly body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The official Telegram bot is configured for this deployment. */
function officialBot(): void {
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", `${OFFICIAL_BOT_ID}:${randomUUID()}`);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "official_okou_bot");
  mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", randomUUID());
}

/** Telegram's Bot API answers sendMessage with the given status. */
function serveTelegramMessages(status: 200 | 403 = 200): TelegramSent[] {
  const sent: TelegramSent[] = [];
  server.use(
    http.post(
      "https://api.telegram.org/:bot/sendMessage",
      async ({ request, params }) => {
        const body: unknown = await request.json();
        const message = isRecord(body) ? body : {};
        sent.push({ bot: String(params.bot), body: message });
        if (status === 403) {
          return HttpResponse.json(
            {
              ok: false,
              error_code: 403,
              description: "Forbidden: Bot was blocked by the user",
            },
            { status: 403 },
          );
        }
        return HttpResponse.json({
          ok: true,
          result: {
            message_id: sent.length,
            date: Math.floor(now() / 1000),
            chat: { id: Number(message.chat_id), type: "private" },
            text: message.text,
          },
        });
      },
    ),
  );
  return sent;
}

async function onboardedMember(
  member: Member = {
    userId: `user_tg_${randomUUID()}`,
    orgId: `org_tg_${randomUUID()}`,
  },
): Promise<Member> {
  await memberships.set(
    seedOrgMembership$,
    { orgId: member.orgId, userId: member.userId, role: "member" },
    context.signal,
  );
  return member;
}

function signIn(member: Member): void {
  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    "org:member",
  );
}

function linkClient() {
  return setupApp({ context, routes: integrationsTelegramLinkRoutes })(
    integrationsTelegramContract,
  );
}

function telegramClient() {
  return setupApp({ context, routes: integrationsTelegramRoutes })(
    integrationsTelegramContract,
  );
}

function downloadClient() {
  return setupApp({ context, routes: integrationsTelegramRoutes })(
    integrationsTelegramDownloadFileContract,
  );
}

function toApiUser(member: Member): ApiTestUser {
  return {
    userId: member.userId,
    orgId: member.orgId,
    orgRole: "org:member",
    email: `${member.userId}@example.test`,
  };
}

async function okouTokenHeaders(member: Member): Promise<{
  readonly authorization: string;
}> {
  const { token } = await createRunsApi(context).createCliToken(
    toApiUser(member),
  );
  return { authorization: `Bearer ${token}` };
}

async function deliverWebhookMessage(message: Record<string, unknown>) {
  await accept(
    telegramClient().webhook({
      params: { telegramBotId: "official" },
      body: {
        update_id: randomInt(1, 1_000_000_000),
        message,
      },
      extraHeaders: {
        "x-telegram-bot-api-secret-token": configured(
          "TELEGRAM_OFFICIAL_WEBHOOK_SECRET",
        ),
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

function mockSupergroupMembership(args: {
  readonly chatId: number;
  readonly userId: number;
  readonly userStatus: "member" | "left";
}): void {
  const token = configured("TELEGRAM_OFFICIAL_BOT_TOKEN");
  server.use(
    http.get(`https://api.telegram.org/bot${token}/getChat`, ({ request }) => {
      const chatId = new URL(request.url).searchParams.get("chat_id");
      if (chatId !== String(args.chatId)) {
        return HttpResponse.json(
          { ok: false, error_code: 404, description: "Chat not found" },
          { status: 404 },
        );
      }
      return HttpResponse.json({
        ok: true,
        result: { id: args.chatId, type: "supergroup" },
      });
    }),
    http.get(
      `https://api.telegram.org/bot${token}/getChatMember`,
      ({ request }) => {
        const params = new URL(request.url).searchParams;
        const userId = Number(params.get("user_id"));
        const status =
          userId === args.userId ? args.userStatus : ("member" as const);
        return HttpResponse.json({
          ok: true,
          result: {
            user: { id: userId },
            status,
          },
        });
      },
    ),
  );
}

function telegramUserId(): number {
  return randomInt(1_000_000_000, 2_000_000_000);
}

/** A value the test configured for the route, read back from the environment. */
function configured(
  name: "TELEGRAM_OFFICIAL_BOT_TOKEN" | "TELEGRAM_OFFICIAL_WEBHOOK_SECRET",
): string {
  const value = env(name);
  if (!value) {
    throw new Error(`Expected ${name} to be configured`);
  }
  return value;
}

async function linkWithLoginWidget(member: Member, id: number) {
  signIn(member);
  return await linkClient().link({
    headers: SESSION,
    body: {
      telegramBotId: "official",
      telegramAuth: telegramLoginAuth(
        configured("TELEGRAM_OFFICIAL_BOT_TOKEN"),
        {
          id,
          first_name: "Test",
          username: "official_tg",
        },
      ),
    },
  });
}

async function listOfficialBot(member: Member) {
  signIn(member);
  const response = await accept(
    telegramClient().list({ headers: SESSION }),
    [200],
  );
  const official = response.body.bots.find((bot) => {
    return bot.id === "official";
  });
  if (!official) {
    throw new Error("Expected the official Telegram bot in the list");
  }
  return official;
}

/** The Telegram user asks the official bot to connect in a private chat. */
async function requestConnectLink(id: number): Promise<URL> {
  const sent = serveTelegramMessages();
  await accept(
    telegramClient().webhook({
      params: { telegramBotId: "official" },
      body: {
        update_id: randomInt(1, 1_000_000_000),
        message: {
          message_id: 1,
          date: Math.floor(now() / 1000),
          chat: { id, type: "private" },
          from: { id, is_bot: false, first_name: "Test" },
          text: "/connect",
          entities: [{ type: "bot_command", offset: 0, length: 8 }],
        },
      },
      extraHeaders: {
        "x-telegram-bot-api-secret-token": configured(
          "TELEGRAM_OFFICIAL_WEBHOOK_SECRET",
        ),
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  const markup = sent[0]?.body.reply_markup;
  const keyboard = isRecord(markup) ? markup.inline_keyboard : null;
  const row: unknown = Array.isArray(keyboard) ? keyboard[0] : null;
  const button: unknown = Array.isArray(row) ? row[0] : null;
  if (!isRecord(button) || typeof button.url !== "string") {
    throw new Error("Expected a Telegram connect button");
  }
  return new URL(button.url);
}

function connectSignatureOf(link: URL) {
  return {
    telegramUserId: link.searchParams.get("tgUser") ?? "",
    timestamp: Number(link.searchParams.get("ts")),
    signature: link.searchParams.get("sig") ?? "",
    telegramDisplayName: link.searchParams.get("tgDisplayName") ?? undefined,
  };
}

describe("POST /api/integrations/telegram/link", () => {
  it("integrations-telegram-010 rejects an invalid Login Widget hash", async () => {
    officialBot();
    const member = await onboardedMember();
    signIn(member);

    const response = await accept(
      linkClient().link({
        headers: SESSION,
        body: {
          telegramBotId: "official",
          telegramAuth: {
            id: telegramUserId(),
            first_name: "Test",
            username: "official_tg",
            auth_date: Math.floor(now() / 1000),
            hash: "invalid_hash",
          },
        },
      }),
      [400],
    );

    expect(response.body.error.message).toBe("Invalid Telegram authorization");
  });

  it("integrations-telegram-006 links through the Login Widget and welcomes the user", async () => {
    officialBot();
    const sent = serveTelegramMessages();
    const member = await onboardedMember();
    const id = telegramUserId();

    const response = await accept(linkWithLoginWidget(member, id), [200]);
    await flushWaitUntilForTest();
    const official = await listOfficialBot(member);

    expect(response.body).toStrictEqual({
      botUsername: "official_okou_bot",
      telegramUserId: String(id),
    });
    expect(
      sent.map((message) => {
        return message.body;
      }),
    ).toStrictEqual([
      { chat_id: String(id), text: LINKED_TEXT, parse_mode: "HTML" },
    ]);
    expect(official).toMatchObject({
      isConnected: true,
      connectedUser: {
        telegramUserId: String(id),
        telegramUsername: "official_tg",
        telegramDisplayName: "Test",
      },
    });
  });

  it("integrations-telegram-007 still links when Telegram rejects the welcome message", async () => {
    officialBot();
    const sent = serveTelegramMessages(403);
    const member = await onboardedMember();
    const id = telegramUserId();

    const response = await accept(linkWithLoginWidget(member, id), [200]);
    await flushWaitUntilForTest();
    const official = await listOfficialBot(member);

    expect(response.body).toStrictEqual({
      botUsername: "official_okou_bot",
      telegramUserId: String(id),
    });
    expect(
      sent.map((message) => {
        return message.body;
      }),
    ).toStrictEqual([
      { chat_id: String(id), text: LINKED_TEXT, parse_mode: "HTML" },
    ]);
    expect(official).toMatchObject({
      isConnected: true,
      connectedUser: {
        telegramUsername: "official_tg",
        telegramDisplayName: "Test",
      },
    });
  });

  it("integrations-telegram-008 connects with a connect link signed by the official bot", async () => {
    officialBot();
    const member = await onboardedMember();
    const id = telegramUserId();
    const connectLink = await requestConnectLink(id);
    const sent = serveTelegramMessages();
    signIn(member);

    const response = await accept(
      linkClient().link({
        headers: SESSION,
        body: {
          telegramBotId: "official",
          connectSignature: connectSignatureOf(connectLink),
        },
        extraHeaders: { origin: "https://app.okou.ai" },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(response.body).toStrictEqual({
      botUsername: "official_okou_bot",
      telegramUserId: String(id),
    });
    expect(
      sent.map((message) => {
        return message.body;
      }),
    ).toStrictEqual([
      { chat_id: String(id), text: LINKED_TEXT, parse_mode: "HTML" },
    ]);
  });

  it("integrations-telegram-012 rejects a connect link older than ten minutes", async () => {
    officialBot();
    const member = await onboardedMember();
    const issuedAt = now();
    mockNow(issuedAt);
    const connectLink = await requestConnectLink(telegramUserId());
    mockNow(issuedAt + 601 * 1000);
    signIn(member);

    const response = await accept(
      linkClient().link({
        headers: SESSION,
        body: {
          telegramBotId: "official",
          connectSignature: connectSignatureOf(connectLink),
        },
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "Invalid or expired connect link",
    );
  });

  it("integrations-telegram-009 refuses a Telegram user linked by another organization", async () => {
    officialBot();
    serveTelegramMessages();
    const member = await onboardedMember();
    const otherMember = await onboardedMember();
    const id = telegramUserId();
    await accept(linkWithLoginWidget(otherMember, id), [200]);
    await flushWaitUntilForTest();

    const response = await accept(linkWithLoginWidget(member, id), [409]);

    expect(response.body).toStrictEqual({
      error: {
        code: "CONFLICT",
        message:
          "This Telegram account is already connected to another Okou organization through the official Telegram bot @official_okou_bot. Disconnect it before connecting a different account.",
      },
    });
  });

  it("integrations-telegram-014 returns 404 when there is no official account to unlink", async () => {
    officialBot();
    const member = await onboardedMember();
    signIn(member);

    const response = await accept(
      telegramClient().unlink({
        headers: SESSION,
        query: { botId: "official" },
        body: undefined,
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "No linked Telegram account", code: "NOT_FOUND" },
    });
  });

  it("integrations-telegram-015 unlinks the official account only in the active organization", async () => {
    officialBot();
    serveTelegramMessages();
    server.use(
      http.head("https://oauth.telegram.org/auth", () => {
        return new HttpResponse(null, {
          status: 200,
          headers: { "content-length": "5000" },
        });
      }),
    );
    const first = await onboardedMember();
    const second = await onboardedMember({
      userId: first.userId,
      orgId: `org_tg_${randomUUID()}`,
    });
    await accept(linkWithLoginWidget(first, telegramUserId()), [200]);
    await accept(linkWithLoginWidget(second, telegramUserId()), [200]);
    await flushWaitUntilForTest();
    signIn(first);

    await accept(
      telegramClient().unlink({
        headers: SESSION,
        query: { botId: "official" },
        body: undefined,
      }),
      [204],
    );
    const statuses = [];
    for (const member of [first, second]) {
      signIn(member);
      const status = await accept(
        telegramClient().getLinkStatus({
          headers: SESSION,
          query: { botId: "official" },
        }),
        [200],
      );
      statuses.push(status.body.linked);
    }

    expect(statuses).toStrictEqual([false, true]);
  });
});

describe("GET /api/integrations/telegram/:botId/avatar", () => {
  it("integrations-telegram-016 streams the signed official bot avatar", async () => {
    officialBot();
    const token = configured("TELEGRAM_OFFICIAL_BOT_TOKEN");
    const avatarBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    context.mocks.telegram.getUserProfilePhotos.mockResolvedValue([
      [
        { file_id: "avatar-small", width: 160, height: 160 },
        { file_id: "avatar-large", width: 640, height: 640 },
      ],
    ]);
    context.mocks.telegram.getFile.mockImplementation((_token, fileId) => {
      return Promise.resolve({
        file_id: fileId,
        file_path: `photos/${String(fileId)}.jpg`,
      });
    });
    server.use(
      http.get(
        "https://api.telegram.org/file/:bot/photos/:fileName",
        ({ params }) => {
          if (
            params.bot !== `bot${token}` ||
            params.fileName !== "avatar-large.jpg"
          ) {
            return new HttpResponse(null, { status: 404 });
          }
          return new HttpResponse(avatarBytes, {
            headers: { "content-type": "image/jpeg" },
          });
        },
      ),
    );
    const member = await onboardedMember();
    const official = await listOfficialBot(member);
    const avatarUrl = new URL(official.avatarUrl ?? "", "https://app.okou.ai");

    const response = await accept(
      telegramClient().avatar({
        params: { botId: "official" },
        query: {
          exp: avatarUrl.searchParams.get("exp") ?? undefined,
          sig: avatarUrl.searchParams.get("sig") ?? undefined,
        },
      }),
      [200],
    );

    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    if (!(response.body instanceof Blob)) {
      throw new Error("Expected the avatar bytes");
    }
    expect(new Uint8Array(await response.body.arrayBuffer())).toStrictEqual(
      avatarBytes,
    );
    expect(
      context.mocks.telegram.getUserProfilePhotos.mock.calls,
    ).toStrictEqual([[token, Number(OFFICIAL_BOT_ID), 1]]);
  });

  it("integrations-telegram-017 returns the avatar placeholder when the official bot has no avatar", async () => {
    officialBot();
    context.mocks.telegram.getUserProfilePhotos.mockResolvedValue([]);
    const member = await onboardedMember();
    const headers = await okouTokenHeaders(member);

    const response = await accept(
      telegramClient().avatar({
        headers,
        params: { botId: "official" },
        query: {},
      }),
      [200],
    );

    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    if (!(response.body instanceof Blob)) {
      throw new Error("Expected the fallback avatar SVG");
    }
    await expect(response.body.text()).resolves.toContain(
      "Telegram bot avatar fallback",
    );
  });
});

describe("GET /api/integrations/telegram", () => {
  it("integrations-telegram-001 returns the configured official bot for the active organization", async () => {
    officialBot();
    const member = await onboardedMember();
    const headers = await okouTokenHeaders(member);

    const response = await accept(telegramClient().list({ headers }), [200]);

    expect(response.body.bots).toHaveLength(1);
    const official = response.body.bots[0];
    if (!official) {
      throw new Error("Expected the official Telegram bot");
    }
    const avatarUrl = new URL(official.avatarUrl ?? "", "https://app.okou.ai");
    expect(avatarUrl.pathname).toBe(
      "/api/integrations/telegram/official/avatar",
    );
    expect(avatarUrl.searchParams.get("exp")).toMatch(/^\d+$/u);
    expect(avatarUrl.searchParams.get("sig")).toBeTruthy();
    expect(official).toMatchObject({
      id: "official",
      kind: "official",
      username: "official_okou_bot",
      isOwner: false,
      isConnected: false,
      connectedUser: null,
      tokenStatus: "valid",
      official: {
        configured: true,
        linkedTelegramUserId: null,
      },
    });
  });
});

describe("GET /api/integrations/telegram/download-file", () => {
  it("integrations-telegram-019 returns 401 when the token has no active organization membership", async () => {
    officialBot();
    const member = await onboardedMember();
    const headers = await okouTokenHeaders(member);
    await memberships.set(deleteOrgMembership$, member, context.signal);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });

    const response = await accept(
      downloadClient().download({
        headers,
        query: { file_id: "tg-file-1", bot_id: "tg-bot" },
      }),
      [401],
    );

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("integrations-telegram-021 streams files for the official Telegram bot", async () => {
    officialBot();
    serveTelegramMessages();
    const token = configured("TELEGRAM_OFFICIAL_BOT_TOKEN");
    const member = await onboardedMember();
    const tgUserId = telegramUserId();
    const chatId = -1_001_000_000_000 - randomInt(1, 999_999);
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);

    await accept(linkWithLoginWidget(member, tgUserId), [200]);
    await flushWaitUntilForTest();
    await deliverWebhookMessage({
      message_id: 101,
      date: Math.floor(now() / 1000),
      chat: { id: chatId, type: "supergroup" },
      from: { id: tgUserId, is_bot: false, first_name: "Reader" },
      document: {
        file_id: "tg-official",
        file_unique_id: `unique-${randomUUID()}`,
        file_name: "official.jpg",
        mime_type: "image/jpeg",
        file_size: imageBytes.byteLength,
      },
    });

    mockSupergroupMembership({
      chatId,
      userId: tgUserId,
      userStatus: "member",
    });
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-official",
      file_path: "photos/official.jpg",
      file_size: imageBytes.byteLength,
    });
    server.use(
      http.get(
        `https://api.telegram.org/file/bot${token}/photos/official.jpg`,
        () => {
          return new HttpResponse(imageBytes, {
            headers: { "content-type": "image/jpeg" },
          });
        },
      ),
    );
    const headers = await okouTokenHeaders(member);

    const response = await accept(
      downloadClient().download({
        headers,
        query: { file_id: "tg-official", bot_id: "official" },
      }),
      [200],
    );

    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-file-name")).toBe("official.jpg");
    if (!(response.body instanceof Blob)) {
      throw new Error("Expected the Telegram file bytes");
    }
    expect(new Uint8Array(await response.body.arrayBuffer())).toStrictEqual(
      imageBytes,
    );
    expect(context.mocks.telegram.getFile.mock.calls).toStrictEqual([
      [token, "tg-official"],
    ]);
  });

  it("integrations-telegram-022 does not read an old account's recorded private files through the new account's binding", async () => {
    officialBot();
    serveTelegramMessages();
    const token = configured("TELEGRAM_OFFICIAL_BOT_TOKEN");
    const member = await onboardedMember();
    const firstId = telegramUserId();
    const secondId = telegramUserId();
    const getChatCalls: string[] = [];

    server.use(
      http.post(`https://api.telegram.org/bot${token}/sendChatAction`, () => {
        return HttpResponse.json({ ok: true, result: true });
      }),
      http.get(
        `https://api.telegram.org/file/bot${token}/docs/private.txt`,
        () => {
          return new HttpResponse("data", {
            headers: { "content-type": "text/plain" },
          });
        },
      ),
    );
    context.mocks.s3.send.mockResolvedValue({ ETag: '"fixture-etag"' });
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "previous-private-attachment",
      file_path: "docs/private.txt",
      file_size: 4,
    });

    await accept(linkWithLoginWidget(member, firstId), [200]);
    await flushWaitUntilForTest();
    await deliverWebhookMessage({
      message_id: 201,
      date: Math.floor(now() / 1000),
      chat: { id: firstId, type: "private" },
      from: { id: firstId, is_bot: false, first_name: "First" },
      document: {
        file_id: "previous-private-attachment",
        file_unique_id: `unique-${randomUUID()}`,
        file_name: "private.txt",
        mime_type: "text/plain",
        file_size: 4,
      },
    });

    signIn(member);
    await accept(
      telegramClient().unlink({
        headers: SESSION,
        query: { botId: "official" },
        body: undefined,
      }),
      [204],
    );
    await accept(linkWithLoginWidget(member, secondId), [200]);
    await flushWaitUntilForTest();

    context.mocks.telegram.getFile.mockClear();
    server.use(
      http.get(
        `https://api.telegram.org/bot${token}/getChat`,
        ({ request }) => {
          const requested =
            new URL(request.url).searchParams.get("chat_id") ?? "";
          getChatCalls.push(requested);
          return HttpResponse.json({
            ok: true,
            result: { id: Number(requested), type: "private" },
          });
        },
      ),
    );
    const headers = await okouTokenHeaders(member);

    const response = await accept(
      downloadClient().download({
        headers,
        query: {
          file_id: "previous-private-attachment",
          bot_id: "official",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(getChatCalls).toStrictEqual([String(firstId)]);
    expect(context.mocks.telegram.getFile).not.toHaveBeenCalled();
  });

  it("integrations-telegram-023 denies unrecorded bot-global files and files from a chat the caller left", async () => {
    officialBot();
    serveTelegramMessages();
    const member = await onboardedMember();
    const tgUserId = telegramUserId();
    const chatId = -1_001_000_000_000 - randomInt(1, 999_999);

    await accept(linkWithLoginWidget(member, tgUserId), [200]);
    await flushWaitUntilForTest();
    await deliverWebhookMessage({
      message_id: 301,
      date: Math.floor(now() / 1000),
      chat: { id: chatId, type: "supergroup" },
      from: { id: tgUserId, is_bot: false, first_name: "Reader" },
      document: {
        file_id: "owned-attachment",
        file_unique_id: `unique-${randomUUID()}`,
        file_name: "notes.txt",
        mime_type: "text/plain",
        file_size: 10,
      },
    });
    mockSupergroupMembership({ chatId, userId: tgUserId, userStatus: "left" });
    const headers = await okouTokenHeaders(member);

    const unrecorded = await accept(
      downloadClient().download({
        headers,
        query: { file_id: "another-users-attachment", bot_id: "official" },
      }),
      [404],
    );
    const leftChat = await accept(
      downloadClient().download({
        headers,
        query: { file_id: "owned-attachment", bot_id: "official" },
      }),
      [404],
    );

    expect(unrecorded.body.error.code).toBe("NOT_FOUND");
    expect(leftChat.body.error.code).toBe("NOT_FOUND");
    expect(context.mocks.telegram.getFile).not.toHaveBeenCalled();
  });

  it("integrations-telegram-025 returns 413 when Telegram reports a file over the proxy limit", async () => {
    officialBot();
    serveTelegramMessages();
    const member = await onboardedMember();
    const tgUserId = telegramUserId();
    const chatId = -1_001_000_000_000 - randomInt(1, 999_999);

    await accept(linkWithLoginWidget(member, tgUserId), [200]);
    await flushWaitUntilForTest();
    await deliverWebhookMessage({
      message_id: 401,
      date: Math.floor(now() / 1000),
      chat: { id: chatId, type: "supergroup" },
      from: { id: tgUserId, is_bot: false, first_name: "Reader" },
      document: {
        file_id: "tg-file-big",
        file_unique_id: `unique-${randomUUID()}`,
        file_name: "archive.bin",
        mime_type: "application/octet-stream",
        file_size: 200 * 1024 * 1024,
      },
    });
    mockSupergroupMembership({
      chatId,
      userId: tgUserId,
      userStatus: "member",
    });
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-file-big",
      file_path: "docs/archive.bin",
      file_size: 200 * 1024 * 1024,
    });
    const headers = await okouTokenHeaders(member);

    const response = await accept(
      downloadClient().download({
        headers,
        query: { file_id: "tg-file-big", bot_id: "official" },
      }),
      [413],
    );

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.body).toStrictEqual({
      error: {
        message: "File exceeds maximum size of 104857600 bytes",
        code: "PAYLOAD_TOO_LARGE",
      },
    });
  });
});
