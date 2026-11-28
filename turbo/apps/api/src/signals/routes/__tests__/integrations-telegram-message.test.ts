import { randomInt, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  integrationsTelegramMessageContract,
  integrationsTelegramUploadCompleteContract,
  integrationsTelegramUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";
import {
  integrationsTelegramContract,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { number, object, string, union } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsTelegramRoutes } from "../integrations-telegram";
import { integrationsTelegramLinkRoutes } from "../integrations-telegram-link";
import { integrationsTelegramMessageRoutes } from "../integrations-telegram-message";
import { integrationsTelegramUploadCompleteRoutes } from "../integrations-telegram-upload-complete";
import { integrationsTelegramUploadInitRoutes } from "../integrations-telegram-upload-init";
import { telegramLoginAuth } from "./helpers/api-bdd-integrations";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const memberships = createStore();

const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const OFFICIAL_BOT_NUMERIC_ID = 9_876_543_210;
const SUPERGROUP_CHAT_ID = -1_001_234_567_890;
const NOT_LINKED_ERROR =
  "No Telegram account linked to the current user. Link Telegram first.";

const sendMessagePayloadSchema = object({
  chat_id: union([string(), number()]),
  text: string(),
});

const sendDocumentPayloadSchema = object({
  chat_id: union([string(), number()]),
  document: string(),
});

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

interface SentTelegramMessage {
  readonly chatId: string;
  readonly text: string;
}

interface SentTelegramDocument {
  readonly chatId: string;
  readonly document: string;
}

const app = setupApp({
  context,
  routes: [
    ...integrationsTelegramRoutes,
    ...integrationsTelegramLinkRoutes,
    ...integrationsTelegramMessageRoutes,
    ...integrationsTelegramUploadInitRoutes,
    ...integrationsTelegramUploadCompleteRoutes,
  ],
});

function configureOfficialBot(): void {
  mockEnv(
    "TELEGRAM_OFFICIAL_BOT_TOKEN",
    `${OFFICIAL_BOT_NUMERIC_ID}:${randomUUID()}`,
  );
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "official_okou_bot");
  mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", randomUUID());
}

function configuredBotToken(): string {
  const token = env("TELEGRAM_OFFICIAL_BOT_TOKEN");
  if (!token) {
    throw new Error("Expected TELEGRAM_OFFICIAL_BOT_TOKEN to be configured");
  }
  return token;
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

function signIn(member: Member) {
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

function serveTelegramMessages(messageId = 1): SentTelegramMessage[] {
  const sent: SentTelegramMessage[] = [];
  server.use(
    http.head("https://oauth.telegram.org/auth", () => {
      return new HttpResponse(null, { status: 200 });
    }),
    http.post(
      "https://api.telegram.org/:bot/sendMessage",
      async ({ request }) => {
        const parsed = sendMessagePayloadSchema.parse(await request.json());
        sent.push({
          chatId: String(parsed.chat_id),
          text: parsed.text,
        });
        return HttpResponse.json({
          ok: true,
          result: {
            message_id: messageId,
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

async function linkOfficialTelegram(
  member: Member,
  telegramUserId: number,
): Promise<void> {
  await accept(
    app(integrationsTelegramContract).link({
      headers: signIn(member),
      body: {
        telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
        telegramAuth: telegramLoginAuth(configuredBotToken(), {
          id: telegramUserId,
          first_name: "Telegram",
          username: "official_member",
        }),
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

describe("official Telegram self delivery", () => {
  it("integrations-telegram-message-016 does not use an official link belonging to another org", async () => {
    configureOfficialBot();
    serveTelegramMessages();
    const userId = `user_tg_${randomUUID()}`;
    const firstOrg: Member = { userId, orgId: `org_tg_${randomUUID()}` };
    const otherOrg: Member = { userId, orgId: `org_tg_${randomUUID()}` };
    await onboardedMember(firstOrg);
    await onboardedMember(otherOrg);
    await linkOfficialTelegram(otherOrg, uniqueTelegramUserId());

    const response = await accept(
      app(integrationsTelegramMessageContract).sendMessage({
        headers: signIn(firstOrg),
        body: {
          botId: OFFICIAL_TELEGRAM_BOT_ID,
          chatId: "me",
          text: "Hello self",
        },
      }),
      [404],
    );

    expect(response.body.error).toStrictEqual({
      message: NOT_LINKED_ERROR,
      code: "NOT_FOUND",
    });
  });

  it("integrations-telegram-message-015 resolves chatId 'me' through the caller's official link in the current org", async () => {
    configureOfficialBot();
    const sent = serveTelegramMessages(324);
    const member = await onboardedMember();
    const telegramUserId = uniqueTelegramUserId();
    await linkOfficialTelegram(member, telegramUserId);
    const offset = sent.length;

    const response = await accept(
      app(integrationsTelegramMessageContract).sendMessage({
        headers: signIn(member),
        body: {
          botId: OFFICIAL_TELEGRAM_BOT_ID,
          chatId: "me",
          text: "Hello self",
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      ok: true,
      messageId: 324,
      chatId: String(telegramUserId),
    });
    const delivered = sent.slice(offset);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.chatId).toBe(String(telegramUserId));
    expect(delivered[0]?.text).toContain("Hello self");
  });

  it("integrations-telegram-message-013 rejects an unlinked public actor without sending through another actor's link", async () => {
    configureOfficialBot();
    const sent = serveTelegramMessages();
    const memberA = await onboardedMember();
    const memberB = await onboardedMember();
    const telegramUserA = uniqueTelegramUserId();
    await linkOfficialTelegram(memberA, telegramUserA);
    const offset = sent.length;

    const linkStatus = await accept(
      app(integrationsTelegramContract).getLinkStatus({
        headers: signIn(memberB),
        query: { botId: OFFICIAL_TELEGRAM_BOT_ID },
      }),
      [200],
    );
    expect(linkStatus.body.linked).toBeFalsy();

    const response = await accept(
      app(integrationsTelegramMessageContract).sendMessage({
        headers: signIn(memberB),
        body: {
          botId: OFFICIAL_TELEGRAM_BOT_ID,
          chatId: "me",
          text: "Hello B",
        },
      }),
      [404],
    );

    expect(response.body.error).toStrictEqual({
      message: NOT_LINKED_ERROR,
      code: "NOT_FOUND",
    });
    expect(sent.slice(offset)).toStrictEqual([]);
  });

  it("integrations-telegram-message-007 checks both Telegram principals before sending: shared", async () => {
    configureOfficialBot();
    const sent = serveTelegramMessages(701);
    const member = await onboardedMember();
    const telegramUserId = uniqueTelegramUserId();
    await linkOfficialTelegram(member, telegramUserId);
    const offset = sent.length;

    server.use(
      http.get("https://api.telegram.org/:bot/getChat", () => {
        return HttpResponse.json({
          ok: true,
          result: {
            id: SUPERGROUP_CHAT_ID,
            type: "supergroup",
            permissions: { can_send_messages: true },
          },
        });
      }),
      http.get("https://api.telegram.org/:bot/getChatMember", ({ request }) => {
        const userId = Number(new URL(request.url).searchParams.get("user_id"));
        return HttpResponse.json({
          ok: true,
          result: {
            user: { id: userId },
            status: "member",
            can_send_messages: true,
          },
        });
      }),
    );

    await accept(
      app(integrationsTelegramMessageContract).sendMessage({
        headers: signIn(member),
        body: {
          botId: OFFICIAL_TELEGRAM_BOT_ID,
          chatId: "@requested_chat",
          text: "authorized group message",
        },
      }),
      [200],
    );

    const delivered = sent.slice(offset);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.chatId).toBe(String(SUPERGROUP_CHAT_ID));
  });

  it("integrations-telegram-message-008 checks both Telegram principals before sending: missing user", async () => {
    configureOfficialBot();
    const sent = serveTelegramMessages();
    const member = await onboardedMember();
    const telegramUserId = uniqueTelegramUserId();
    await linkOfficialTelegram(member, telegramUserId);
    const offset = sent.length;

    server.use(
      http.get("https://api.telegram.org/:bot/getChat", () => {
        return HttpResponse.json({
          ok: true,
          result: {
            id: SUPERGROUP_CHAT_ID,
            type: "supergroup",
            permissions: { can_send_messages: true },
          },
        });
      }),
      http.get("https://api.telegram.org/:bot/getChatMember", ({ request }) => {
        const requestedUserId = Number(
          new URL(request.url).searchParams.get("user_id"),
        );
        return HttpResponse.json({
          ok: true,
          result:
            requestedUserId === telegramUserId
              ? { user: { id: requestedUserId }, status: "left" }
              : {
                  user: { id: requestedUserId },
                  status: "member",
                  can_send_messages: true,
                },
        });
      }),
    );

    await accept(
      app(integrationsTelegramMessageContract).sendMessage({
        headers: signIn(member),
        body: {
          botId: OFFICIAL_TELEGRAM_BOT_ID,
          chatId: "@requested_chat",
          text: "authorized group message",
        },
      }),
      [404],
    );

    expect(sent.slice(offset)).toStrictEqual([]);
  });

  it("integrations-telegram-message-010 checks both Telegram principals before sending: restricted user", async () => {
    configureOfficialBot();
    const sent = serveTelegramMessages();
    const member = await onboardedMember();
    const telegramUserId = uniqueTelegramUserId();
    await linkOfficialTelegram(member, telegramUserId);
    const offset = sent.length;

    server.use(
      http.get("https://api.telegram.org/:bot/getChat", () => {
        return HttpResponse.json({
          ok: true,
          result: {
            id: SUPERGROUP_CHAT_ID,
            type: "supergroup",
            permissions: { can_send_messages: true },
          },
        });
      }),
      http.get("https://api.telegram.org/:bot/getChatMember", ({ request }) => {
        const requestedUserId = Number(
          new URL(request.url).searchParams.get("user_id"),
        );
        return HttpResponse.json({
          ok: true,
          result:
            requestedUserId === telegramUserId
              ? {
                  user: { id: requestedUserId },
                  status: "restricted",
                  is_member: true,
                  can_send_messages: false,
                }
              : {
                  user: { id: requestedUserId },
                  status: "member",
                  can_send_messages: true,
                },
        });
      }),
    );

    await accept(
      app(integrationsTelegramMessageContract).sendMessage({
        headers: signIn(member),
        body: {
          botId: OFFICIAL_TELEGRAM_BOT_ID,
          chatId: "@requested_chat",
          text: "authorized group message",
        },
      }),
      [404],
    );

    expect(sent.slice(offset)).toStrictEqual([]);
  });

  it("integrations-telegram-message-012 checks both Telegram principals before sending: other private chat", async () => {
    configureOfficialBot();
    const sent = serveTelegramMessages(702);
    const member = await onboardedMember();
    const telegramUserId = uniqueTelegramUserId();
    const otherPrivateChatId = telegramUserId + 1;
    await linkOfficialTelegram(member, telegramUserId);
    const offset = sent.length;

    server.use(
      http.get("https://api.telegram.org/:bot/getChat", () => {
        return HttpResponse.json({
          ok: true,
          result: {
            id: otherPrivateChatId,
            type: "private",
          },
        });
      }),
    );

    await accept(
      app(integrationsTelegramMessageContract).sendMessage({
        headers: signIn(member),
        body: {
          botId: OFFICIAL_TELEGRAM_BOT_ID,
          chatId: "@requested_chat",
          text: "authorized group message",
        },
      }),
      [200],
    );

    const delivered = sent.slice(offset);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.chatId).toBe(String(otherPrivateChatId));
  });

  it("integrations-telegram-message-017 authorizes Telegram file delivery to own DM", async () => {
    configureOfficialBot();
    serveTelegramMessages();
    const member = await onboardedMember();
    const telegramUserId = uniqueTelegramUserId();
    await linkOfficialTelegram(member, telegramUserId);

    const uploadUrl = `https://r2.okou.test/uploads/${randomUUID()}/report.pdf`;
    const downloadUrl = `https://r2.okou.test/downloads/${randomUUID()}/report.pdf`;
    let uploadedBytes = 0;

    context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
      const name = (
        command as { readonly constructor: { readonly name: string } }
      ).constructor.name;
      return Promise.resolve(
        name === "PutObjectCommand" ? uploadUrl : downloadUrl,
      );
    });
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const { constructor, input } = command as {
        readonly constructor: { readonly name: string };
        readonly input?: { readonly Key?: string };
      };
      if (constructor.name === "HeadObjectCommand") {
        return Promise.resolve({
          ContentLength: uploadedBytes,
          ContentType: "application/pdf",
        });
      }
      if (constructor.name === "GetObjectCommand") {
        if (!input?.Key?.startsWith("private-artifacts/")) {
          return Promise.reject(
            Object.assign(new Error("Missing object"), { name: "NoSuchKey" }),
          );
        }
        return Promise.resolve({
          ContentLength: uploadedBytes,
          ContentType: "application/pdf",
          Body: Readable.from([Buffer.alloc(Math.max(1, uploadedBytes), 0x61)]),
        });
      }
      if (constructor.name === "PutObjectCommand") {
        return Promise.resolve({ ETag: '"etag-1"' });
      }
      return Promise.resolve({});
    });

    const sentDocuments: SentTelegramDocument[] = [];
    server.use(
      http.put(uploadUrl, async ({ request }) => {
        const buffer = await request.arrayBuffer();
        uploadedBytes = buffer.byteLength;
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(
        "https://api.telegram.org/:bot/sendDocument",
        async ({ request }) => {
          const parsed = sendDocumentPayloadSchema.parse(await request.json());
          sentDocuments.push({
            chatId: String(parsed.chat_id),
            document: parsed.document,
          });
          return HttpResponse.json({
            ok: true,
            result: {
              message_id: 322,
              date: Math.floor(now() / 1000),
              chat: { id: Number(parsed.chat_id), type: "private" },
              document: {
                file_id: "tg-doc-322",
                file_name: "report.pdf",
                mime_type: "application/pdf",
                file_size: 1234,
              },
            },
          });
        },
      ),
    );

    const initialized = await accept(
      app(integrationsTelegramUploadInitContract).init({
        headers: signIn(member),
        body: {
          filename: "report.pdf",
          contentType: "application/pdf",
          length: 1234,
        },
      }),
      [200],
    );

    const putResponse = await fetch(initialized.body.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": "application/pdf",
        ...initialized.body.uploadHeaders,
      },
      body: new Uint8Array(1234),
    });
    expect(putResponse.status).toBe(200);

    const completed = await accept(
      app(integrationsTelegramUploadCompleteContract).complete({
        headers: signIn(member),
        body: {
          uploadId: initialized.body.uploadId,
          botId: OFFICIAL_TELEGRAM_BOT_ID,
          chatId: "me",
          contentType: "application/pdf",
        },
      }),
      [200],
    );

    expect(completed.body.messageId).toBe(322);
    expect(completed.body.chatId).toBe(String(telegramUserId));
    expect(sentDocuments).toHaveLength(1);
    expect(sentDocuments[0]?.chatId).toBe(String(telegramUserId));
  });
});
