import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  integrationsTelegramMessageContract,
  integrationsTelegramUploadCompleteContract,
  integrationsTelegramUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";
import {
  integrationsTelegramContract,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "@okouai/api-contracts/contracts/integrations-telegram";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, optionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { integrationsTelegramRoutes } from "../integrations-telegram";
import { integrationsTelegramMessageRoutes } from "../integrations-telegram-message";
import { integrationsTelegramUploadCompleteRoutes } from "../integrations-telegram-upload-complete";
import { integrationsTelegramUploadInitRoutes } from "../integrations-telegram-upload-init";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createPublicTelegramActor } from "./helpers/public-telegram-actor";
import { createRouteMocks } from "./helpers/route-test";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

const context = testContext();
const credentials = createClaimedRunCredentials(context);
const store = createStore();
const mocks = createRouteMocks(context);

function uniqueBotId(): string {
  // 9-digit numeric matches parseTelegramBotId's /^\d+$/ check.
  return String(100_000_000 + Math.floor(Math.random() * 899_999_999));
}

const OFFICIAL_BOT_TOKEN = "987654:official-bot-token";

function officialSender() {
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "official_okou_bot");
  return {
    ...createPublicTelegramActor(context),
    telegramUserId: uniqueBotId(),
  };
}

describe("POST /api/integrations/telegram/message", () => {
  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({
      context,
      routes: integrationsTelegramMessageRoutes,
    })(integrationsTelegramMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          botId: "tg-bot",
          chatId: "-100",
          text: "hi",
        },
        headers: {},
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the token has no active organization membership", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const token = await credentials.okouToken({ userId, orgId });
    await credentials.removeMember({ userId, orgId });

    const client = setupApp({
      context,
      routes: integrationsTelegramMessageRoutes,
    })(integrationsTelegramMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          botId: "tg-bot",
          chatId: "-100",
          text: "hi",
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({
      context,
      routes: integrationsTelegramMessageRoutes,
    })(integrationsTelegramMessageContract);

    const response = await accept(
      client.sendMessage({
        body: {
          botId: "tg-bot",
          chatId: "-100",
          text: "hi",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 404 when the bot id is not owned by the org", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );

    const client = setupApp({
      context,
      routes: integrationsTelegramMessageRoutes,
    })(integrationsTelegramMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          botId: uniqueBotId(),
          chatId: "-1001234567890",
          text: "hello",
        },
        headers: {
          authorization: `Bearer ${await credentials.okouToken({ userId, orgId })}`,
        },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Telegram bot not found", code: "NOT_FOUND" },
    });
  });
});

function publicMessageActors() {
  const firstTelegramId = randomInt(1, 2 ** 48) * 2;
  const telegramIds = [firstTelegramId, firstTelegramId + 1] as const;
  expect(telegramIds.every(Number.isSafeInteger)).toBeTruthy();
  expect(telegramIds[0]).not.toBe(telegramIds[1]);
  const appUrl = "https://telegram-message.test";
  const telegramPosts: string[] = [];
  mockEnv("APP_URL", appUrl);
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "official_okou_bot");
  mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", "official-message-test-secret");
  const apiBase =
    optionalEnv("TELEGRAM_API_URL") || "https://api.telegram.org/bot";
  server.use(
    http.head("https://oauth.telegram.org/auth", ({ request }) => {
      const query = new URL(request.url).searchParams;
      expect(query.get("bot_id")).toBe("987654");
      expect(query.get("origin")).toBe(new URL(appUrl).origin);
      return new HttpResponse(null, { headers: { "content-length": "0" } });
    }),
    http.post(
      `${apiBase}${OFFICIAL_BOT_TOKEN}/sendMessage`,
      async ({ request }) => {
        const body = z
          .object({ chat_id: z.string() })
          .parse(await request.json());
        telegramPosts.push(body.chat_id);
        return HttpResponse.json({
          ok: true,
          result: {
            message_id: 100 + telegramPosts.length,
            chat: { id: Number(body.chat_id) },
          },
        });
      },
    ),
  );
  const a = {
    ...createPublicTelegramActor(context),
    telegramUserId: String(telegramIds[0]),
  };
  const b = {
    ...createPublicTelegramActor(context),
    telegramUserId: String(telegramIds[1]),
  };
  expect(a.userId).not.toBe(b.userId);
  expect(a.orgId).not.toBe(b.orgId);
  return { a, b, telegramPosts };
}

describe("official Telegram self delivery", () => {
  it("rejects an unlinked public actor without sending through another actor's link", async () => {
    const { a, b, telegramPosts } = publicMessageActors();
    await a.onboard();
    await b.onboard();
    await a.link(a.telegramUserId);
    const statusClient = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);
    const messageClient = setupApp({
      context,
      routes: integrationsTelegramMessageRoutes,
    })(integrationsTelegramMessageContract);

    await b.run(async () => {
      b.session();
      const status = await accept(
        statusClient.getLinkStatus({
          headers: { authorization: "Bearer clerk-session" },
          query: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        }),
        [200],
      );
      expect(status.body).toMatchObject({ linked: false });
      b.session();
      const response = await accept(
        messageClient.sendMessage({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            botId: OFFICIAL_TELEGRAM_BOT_ID,
            chatId: "me",
            text: "Hello B",
          },
        }),
        [404],
      );
      expect(response.body).toStrictEqual({
        error: {
          message:
            "No Telegram account linked to the current user. Link Telegram first.",
          code: "NOT_FOUND",
        },
      });
      expect(telegramPosts).toStrictEqual([]);
    });
  });

  it("resolves serial public self messages for distinct actors in A-B-A order", async () => {
    const { a, b, telegramPosts } = publicMessageActors();
    const telegramA = a.telegramUserId;
    const telegramB = b.telegramUserId;
    await a.onboard();
    await b.onboard();
    await a.link(telegramA);
    await b.link(telegramB);
    const client = setupApp({
      context,
      routes: integrationsTelegramMessageRoutes,
    })(integrationsTelegramMessageContract);
    const requests = [
      { actor: a, telegramUserId: telegramA, messageId: 101 },
      { actor: b, telegramUserId: telegramB, messageId: 102 },
      { actor: a, telegramUserId: telegramA, messageId: 103 },
    ];
    for (const { actor, telegramUserId, messageId } of requests) {
      await actor.run(async () => {
        actor.session();
        const response = await accept(
          client.sendMessage({
            headers: { authorization: "Bearer clerk-session" },
            body: {
              botId: OFFICIAL_TELEGRAM_BOT_ID,
              chatId: "me",
              text: "Hello self",
            },
          }),
          [200],
        );
        expect(Number.isInteger(response.body.messageId)).toBeTruthy();
        expect(response.body).toStrictEqual({
          ok: true,
          messageId,
          chatId: telegramUserId,
        });
      });
    }
    expect(telegramPosts).toStrictEqual([telegramA, telegramB, telegramA]);
  });

  it("resolves chatId 'me' through the caller's official link in the current org", async () => {
    const sender = officialSender();
    await sender.run(async () => {
      await sender.onboard();
      await sender.link(sender.telegramUserId);
      let telegramBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          `https://api.telegram.org/bot${OFFICIAL_BOT_TOKEN}/sendMessage`,
          async ({ request }) => {
            telegramBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              ok: true,
              result: {
                message_id: 324,
                chat: { id: Number(sender.telegramUserId) },
                text: telegramBody.text,
              },
            });
          },
        ),
      );
      const client = setupApp({
        context,
        routes: integrationsTelegramMessageRoutes,
      })(integrationsTelegramMessageContract);
      const response = await accept(
        sender.run(async () => {
          return await client.sendMessage({
            body: {
              botId: OFFICIAL_TELEGRAM_BOT_ID,
              chatId: "me",
              text: "Hello self",
            },
            headers: { authorization: "Bearer clerk-session" },
          });
        }),
        [200],
      );
      expect(response.body).toStrictEqual({
        ok: true,
        messageId: 324,
        chatId: sender.telegramUserId,
      });
      expect(telegramBody).toMatchObject({ chat_id: sender.telegramUserId });
    });
  });

  it("does not use an official link belonging to another org", async () => {
    const sender = officialSender();
    await sender.run(async () => {
      const other = createPublicTelegramActor(context, {
        userId: sender.userId,
      });
      await other.onboard();
      await other.link(sender.telegramUserId);
      for (const membership of [sender, other]) {
        await store.set(seedOrgMembership$, membership, context.signal);
      }
      sender.session();
      const client = setupApp({
        context,
        routes: integrationsTelegramMessageRoutes,
      })(integrationsTelegramMessageContract);
      const response = await accept(
        sender.run(async () => {
          return await client.sendMessage({
            body: {
              botId: OFFICIAL_TELEGRAM_BOT_ID,
              chatId: "me",
              text: "Hello self",
            },
            headers: { authorization: "Bearer clerk-session" },
          });
        }),
        [404],
      );
      expect(response.body).toStrictEqual({
        error: {
          message:
            "No Telegram account linked to the current user. Link Telegram first.",
          code: "NOT_FOUND",
        },
      });
    });
  });

  it("delivers an uploaded file to the caller's linked private chat", async () => {
    const sender = officialSender();
    await sender.run(async () => {
      await sender.onboard();
      await sender.link(sender.telegramUserId);
      installSharedThreadStorage(context);
      const initialized = await accept(
        sender.run(async () => {
          return await setupApp({
            context,
            routes: integrationsTelegramUploadInitRoutes,
          })(integrationsTelegramUploadInitContract).init({
            headers: { authorization: "Bearer clerk-session" },
            body: {
              filename: "report.pdf",
              contentType: "application/pdf",
              length: 1234,
            },
          });
        }),
        [200],
      );
      const { uploadId } = initialized.body;
      expect(
        (
          await sender.run(async () => {
            return await fetch(initialized.body.uploadUrl, {
              method: "PUT",
              headers: initialized.body.uploadHeaders,
              body: Buffer.alloc(1234),
            });
          })
        ).status,
      ).toBe(200);
      let telegramBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          `https://api.telegram.org/bot${OFFICIAL_BOT_TOKEN}/sendDocument`,
          async ({ request }) => {
            telegramBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              ok: true,
              result: {
                message_id: 322,
                chat: { id: Number(sender.telegramUserId) },
              },
            });
          },
        ),
      );
      const client = setupApp({
        context,
        routes: integrationsTelegramUploadCompleteRoutes,
      })(integrationsTelegramUploadCompleteContract);
      const response = await accept(
        sender.run(async () => {
          return await client.complete({
            body: {
              uploadId,
              botId: OFFICIAL_TELEGRAM_BOT_ID,
              chatId: "me",
              contentType: "application/pdf",
            },
            headers: { authorization: "Bearer clerk-session" },
          });
        }),
        [200],
      );
      expect(telegramBody).toMatchObject({ chat_id: sender.telegramUserId });
      expect(response.body).toMatchObject({
        messageId: 322,
        chatId: sender.telegramUserId,
      });
    });
  });

  it("rejects self uploads without an official Telegram link", async () => {
    officialSender();
    const client = setupApp({
      context,
      routes: integrationsTelegramUploadCompleteRoutes,
    })(integrationsTelegramUploadCompleteContract);
    const response = await accept(
      client.complete({
        body: {
          uploadId: randomUUID(),
          botId: OFFICIAL_TELEGRAM_BOT_ID,
          chatId: "me",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: {
        message:
          "No Telegram account linked to the current user. Link Telegram first.",
        code: "NOT_FOUND",
      },
    });
  });
});
