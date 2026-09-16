import { privateIntegrationArtifact } from "./helpers/integration-output-artifacts";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";

import { integrationsTelegramMessageContract } from "@okouai/api-contracts/contracts/integrations";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { seedOrgMembership$ } from "./helpers/org-membership";
import {
  seedTelegramInstallation$,
  seedTelegramUserLink$,
} from "./helpers/telegram";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { integrationsTelegramMessageRoutes } from "../integrations-telegram-message";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const api = createRunsApi(context);

function uniqueBotId(): string {
  // 9-digit numeric matches parseTelegramBotId's /^\d+$/ check.
  return String(100_000_000 + Math.floor(Math.random() * 899_999_999));
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

async function linkTelegramUser(values: {
  readonly installationId: string;
  readonly userId: string;
  readonly telegramUserId: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}): Promise<void> {
  await store.set(seedTelegramUserLink$, values, context.signal);
}

interface TelegramMessageFixture {
  readonly orgId: string;
  readonly composeId: string;
  readonly telegramBotId: string;
  readonly userId: string;
  readonly runId: string;
}

/**
 * Seeds an org with a Telegram installation and a real run created through
 * the product agent + run APIs (agent label and selected model on the footer
 * both resolve from the run). Run admission needs org credits, granted via
 * the Stripe webhook product path. The provider-only branch records no
 * selected model; the model-policy branch records claude-sonnet-5. Neither
 * branch reads legacy Compose content.
 */
async function seedSendableContext(args: {
  readonly agentName?: string;
  readonly withOrgModelProvider?: boolean;
}): Promise<TelegramMessageFixture> {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Telegram message fixtures require an org-scoped actor");
  }
  const orgId = actor.orgId;
  const userId = actor.userId;

  // Seed the org/member cache so the auth pipeline's role lookup hits the
  // cache instead of trying to call out to Clerk.
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );

  bdd.acceptAgentStorageWrites();
  await api.grantProEntitlement(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: args.agentName,
    visibility: "private",
  });

  const telegramBotId = uniqueBotId();
  await store.set(
    seedTelegramInstallation$,
    {
      orgId,
      ownerUserId: userId,
      telegramBotId,
      agentName: args.agentName,
    },
    context.signal,
  );

  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  if (args.withOrgModelProvider) {
    await api.ensureOrgModelProvider(actor);
  } else {
    await api.createOrgModelProvider(actor, {
      type: "openrouter-api-key",
      secret: "test-openrouter-key",
    });
  }
  const run = await api.createRun(actor, {
    agentId: agent.agentId,
    prompt: "send telegram message",
    modelProvider: args.withOrgModelProvider
      ? "anthropic-api-key"
      : "openrouter-api-key",
  });

  // Product run creation authenticates through the Clerk session mocks;
  // restore the membership-list mock the Okou-token auth path relies on.
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );

  return {
    orgId,
    composeId: agent.agentId,
    telegramBotId,
    userId,
    runId: run.runId,
  };
}

describe("POST /api/integrations/telegram/message", () => {
  it("snapshots private Telegram links before HTML formatting and preserves reply targets", async () => {
    const fixture = await seedSendableContext({ agentName: "Artifact sender" });
    const artifact = await privateIntegrationArtifact(context, {
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "org:admin",
      email: `${fixture.userId}@example.test`,
    });
    let sent: Record<string, unknown> | undefined;
    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        async ({ request }) => {
          sent = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            ok: true,
            result: {
              message_id: 321,
              chat: { id: -100_123 },
              text: sent.text,
            },
          });
        },
      ),
    );
    const client = setupApp({
      context,
      routes: integrationsTelegramMessageRoutes,
    })(integrationsTelegramMessageContract);
    await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${okouToken(fixture)}` },
        body: {
          botId: fixture.telegramBotId,
          chatId: "-100123",
          replyToMessageId: 42,
          messageThreadId: 7,
          text: `[Report](${artifact.url})`,
        },
      }),
      [200],
    );
    const delivered = await artifact.expectDelivered(String(sent?.text));
    expect(sent).toMatchObject({
      chat_id: "-100123",
      reply_parameters: { message_id: 42 },
      message_thread_id: 7,
      parse_mode: "HTML",
    });
    expect(sent?.text).toContain(`<a href="${delivered}">Report</a>`);
  });

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

  it("sends a Telegram message and appends the audit footer", async () => {
    const fixture = await seedSendableContext({
      agentName: "my-assistant",
      withOrgModelProvider: true,
    });
    await linkTelegramUser({
      installationId: fixture.telegramBotId,
      userId: fixture.userId,
      telegramUserId: "777000",
      telegramUsername: "ada_telegram",
      telegramDisplayName: "Ada Lovelace",
    });

    let telegramBody: Record<string, unknown> | undefined;
    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        async ({ request }) => {
          telegramBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            ok: true,
            result: {
              message_id: 321,
              chat: { id: -1_001_234_567_890 },
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
      client.sendMessage({
        body: {
          botId: fixture.telegramBotId,
          chatId: "-1001234567890",
          text: "Hello **world**",
          replyToMessageId: 42,
          messageThreadId: 7,
        },
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: fixture.runId,
          })}`,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      ok: true,
      messageId: 321,
      chatId: "-1001234567890",
    });

    expect(telegramBody).toMatchObject({
      chat_id: "-1001234567890",
      parse_mode: "HTML",
      reply_parameters: { message_id: 42 },
      message_thread_id: 7,
    });
    const sentText = String(telegramBody?.text);
    expect(sentText).toContain("Hello <b>world</b>");
    expect(sentText).toContain(
      '<i>Sent via my-assistant · Triggered by <a href="tg://user?id=777000">@ada_telegram</a> · Claude Sonnet 5</i>',
    );
  });

  it("falls back to Telegram display name in the footer when username is absent", async () => {
    const fixture = await seedSendableContext({});
    await linkTelegramUser({
      installationId: fixture.telegramBotId,
      userId: fixture.userId,
      telegramUserId: "777001",
      telegramUsername: null,
      telegramDisplayName: "Ada Lovelace",
    });

    let telegramBody: Record<string, unknown> | undefined;
    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        async ({ request }) => {
          telegramBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            ok: true,
            result: {
              message_id: 322,
              chat: { id: -1_001_234_567_890 },
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
      client.sendMessage({
        body: {
          botId: fixture.telegramBotId,
          chatId: "-1001234567890",
          text: "Hello",
        },
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: fixture.runId,
          })}`,
        },
      }),
      [200],
    );
    expect(response.body.ok).toBeTruthy();

    const sentText = String(telegramBody?.text);
    expect(sentText).toContain(
      'Triggered by <a href="tg://user?id=777001">Ada Lovelace</a>',
    );
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

  it("returns 400 when Telegram rejects sendMessage with a 4xx", async () => {
    const fixture = await seedSendableContext({});

    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        () => {
          return HttpResponse.json(
            {
              ok: false,
              description: "Bad Request: chat not found",
            },
            { status: 400 },
          );
        },
      ),
    );

    const client = setupApp({
      context,
      routes: integrationsTelegramMessageRoutes,
    })(integrationsTelegramMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          botId: fixture.telegramBotId,
          chatId: "-1001234567890",
          text: "hello",
        },
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: fixture.runId,
          })}`,
        },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("TELEGRAM_ERROR");
    expect(response.body.error.message).toContain("chat not found");
  });

  it("returns 502 when Telegram returns a 5xx (api defensive mapping)", async () => {
    const fixture = await seedSendableContext({});

    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        () => {
          return HttpResponse.json(
            {
              ok: false,
              description: "Service Unavailable",
            },
            { status: 503 },
          );
        },
      ),
    );

    const client = setupApp({
      context,
      routes: integrationsTelegramMessageRoutes,
    })(integrationsTelegramMessageContract);
    const response = await accept(
      client.sendMessage({
        body: {
          botId: fixture.telegramBotId,
          chatId: "-1001234567890",
          text: "hello",
        },
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: fixture.runId,
          })}`,
        },
      }),
      [502],
    );
    expect(response.body.error.code).toBe("TELEGRAM_ERROR");
    expect(response.body.error.message).toContain("Service Unavailable");
  });
});
