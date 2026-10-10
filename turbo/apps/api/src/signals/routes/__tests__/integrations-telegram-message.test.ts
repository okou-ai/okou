import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";

import {
  integrationsTelegramMessageContract,
  integrationsTelegramUploadCompleteContract,
  integrationsTelegramUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createPublicTelegramActor } from "./helpers/public-telegram-actor";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { integrationsTelegramUploadInitRoutes } from "../integrations-telegram-upload-init";
import { createRouteMocks } from "./helpers/route-test";
import { integrationsTelegramMessageRoutes } from "../integrations-telegram-message";
import { integrationsTelegramUploadCompleteRoutes } from "../integrations-telegram-upload-complete";

const context = testContext();
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

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["telegram:write"],
    iat: seconds,
    exp: seconds + 60,
  });
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
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });

    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const token = okouToken({ userId, orgId, runId: "run-1" });

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
    const runId = `run_${randomUUID()}`;
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
          authorization: `Bearer ${okouToken({ userId, orgId, runId })}`,
        },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Telegram bot not found", code: "NOT_FOUND" },
    });
  });
});

describe("official Telegram self delivery", () => {
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
