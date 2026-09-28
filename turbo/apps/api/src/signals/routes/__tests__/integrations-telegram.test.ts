import { createHash, createHmac, randomUUID } from "node:crypto";

import { integrationsTelegramBotListContract } from "@okouai/api-contracts/contracts/integrations";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  integrationsTelegramContract,
  type TelegramListResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { createStore } from "ccstate";
import { afterEach, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { buildTelegramBotAvatarUrl } from "../../external/telegram-avatar";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import {
  deleteTelegramFixture$,
  freezeTelegramFixture,
  makeTelegramFixtureBuilder,
  seedOrgDefaultAgent$,
  seedOfficialUserLink$,
  type TelegramFixture,
} from "./helpers/telegram";
import { integrationsTelegramRoutes } from "../integrations-telegram";

const TEST_APP_ROUTES = Object.freeze([...integrationsTelegramRoutes]);

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);

const OFFICIAL_BOT_TOKEN = "9876543210:fake-test-token";
const OFFICIAL_BOT_USERNAME = "official_okou_bot";
const OFFICIAL_WEBHOOK_SECRET = "official-test-webhook-secret";

function configureOfficialBotEnv(): void {
  mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
  mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", OFFICIAL_BOT_USERNAME);
  mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", OFFICIAL_WEBHOOK_SECRET);
}

function newTelegramBotId(): string {
  return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
}

function expectUnauthorized(body: unknown): void {
  expect(body).toStrictEqual({
    error: {
      message: "Not authenticated",
      code: "UNAUTHORIZED",
    },
  });
}

function mintOkouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly "telegram:read"[];
}): string {
  const nowSeconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou" as const,
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: args.capabilities,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
}

function telegramOauthHead(
  contentLength: string,
  observedOrigins: (string | null)[] = [],
) {
  return http.head("https://oauth.telegram.org/auth", ({ request }) => {
    const url = new URL(request.url);
    observedOrigins.push(url.searchParams.get("origin"));
    return new HttpResponse(null, {
      headers: { "content-length": contentLength },
    });
  });
}

interface TelegramAuthTestData {
  readonly id: number;
  readonly first_name: string;
  readonly username?: string;
  readonly auth_date: number;
  readonly hash: string;
}

function makeTelegramAuth(
  telegramUserId: number,
  username?: string,
  botToken = "test-bot-token",
): TelegramAuthTestData {
  const authDate = Math.floor(now() / 1000);
  const fields: Omit<TelegramAuthTestData, "hash"> = username
    ? {
        auth_date: authDate,
        id: telegramUserId,
        first_name: "Test",
        username,
      }
    : {
        auth_date: authDate,
        id: telegramUserId,
        first_name: "Test",
      };

  const checkString = Object.entries(fields)
    .sort(([a], [b]) => {
      return a.localeCompare(b);
    })
    .map(([key, value]) => {
      return `${key}=${value}`;
    })
    .join("\n");

  const secretKey = createHash("sha256").update(botToken).digest();
  const hash = createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  return { ...fields, hash };
}

function signConnectParams(args: {
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly timestamp: number;
  readonly botToken?: string;
  readonly telegramUsername?: string;
  readonly telegramDisplayName?: string;
}): string {
  let data = `${args.installationId}:${args.telegramUserId}:${args.timestamp}`;
  if (args.telegramUsername || args.telegramDisplayName) {
    data += `:${args.telegramUsername ?? ""}`;
  }
  if (args.telegramDisplayName) {
    data += `:${args.telegramDisplayName}`;
  }
  return createHmac("sha256", args.botToken ?? "test-bot-token")
    .update(data)
    .digest("hex");
}

async function listTelegramBots(
  token: string,
): Promise<TelegramListResponse["bots"]> {
  const client = setupApp({ context, routes: integrationsTelegramRoutes })(
    integrationsTelegramContract,
  );
  const response = await accept(
    client.list({ headers: { authorization: `Bearer ${token}` } }),
    [200],
  );
  return response.body.bots;
}

async function expectTelegramBotConnection(args: {
  readonly token: string;
  readonly botId: string;
  readonly telegramUserId: string;
  readonly telegramUsername: string | null;
  readonly telegramDisplayName: string | null;
}): Promise<void> {
  const bots = await listTelegramBots(args.token);
  expect(bots).toContainEqual(
    expect.objectContaining({
      id: args.botId,
      isConnected: true,
      connectedUser: {
        telegramUserId: args.telegramUserId,
        telegramUsername: args.telegramUsername,
        telegramDisplayName: args.telegramDisplayName,
      },
    }),
  );
}

describe("GET /api/integrations/telegram/bots", () => {
  const fixtures: TelegramFixture[] = [];

  beforeEach(() => {
    configureOfficialBotEnv();
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramBotListContract);

    const response = await accept(client.listBots({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the token has no active organization membership", async () => {
    expect.hasAssertions();
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });

    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const token = mintOkouToken({
      userId,
      orgId,
      capabilities: ["telegram:read"],
    });
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramBotListContract);

    const response = await accept(
      client.listBots({ headers: { authorization: `Bearer ${token}` } }),
      [401],
    );

    expectUnauthorized(response.body);
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    expect.hasAssertions();
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramBotListContract);

    const response = await accept(
      client.listBots({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expectUnauthorized(response.body);
  });

  it("returns the official bot for the active organization", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);

    const token = mintOkouToken({
      userId,
      orgId,
      capabilities: ["telegram:read"],
    });
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramBotListContract);

    const response = await accept(
      client.listBots({ headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    expect(response.body.bots).toHaveLength(1);
    expect(response.body.bots[0]).toMatchObject({
      id: OFFICIAL_TELEGRAM_BOT_ID,
      kind: "official",
      isOwner: false,
      official: { linkedTelegramUserId: null },
    });
  });
});

describe("GET /api/integrations/telegram", () => {
  const fixtures: TelegramFixture[] = [];

  beforeEach(() => {
    configureOfficialBotEnv();
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  it("returns the configured official bot for the active organization", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);

    const token = mintOkouToken({
      userId,
      orgId,
      capabilities: ["telegram:read"],
    });
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.list({ headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    expect(response.body.bots).toHaveLength(1);
    expect(response.body.bots[0]).toMatchObject({
      id: OFFICIAL_TELEGRAM_BOT_ID,
      kind: "official",
      username: OFFICIAL_BOT_USERNAME,
      avatarUrl: expect.stringContaining(
        `/api/integrations/telegram/${OFFICIAL_TELEGRAM_BOT_ID}/avatar?exp=`,
      ),
      isOwner: false,
      isConnected: false,
      connectedUser: null,
      tokenStatus: "valid",
      official: {
        configured: true,
        usesDefaultAgent: true,
        linkedTelegramUserId: null,
      },
    });
  });
});

describe("GET /api/integrations/telegram/link", () => {
  const fixtures: TelegramFixture[] = [];

  beforeEach(() => {
    configureOfficialBotEnv();
    server.use(telegramOauthHead("0"));
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  async function seedLinkContext(): Promise<{
    readonly token: string;
    readonly orgId: string;
    readonly userId: string;
  }> {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);
    return {
      token: mintOkouToken({
        userId,
        orgId,
        capabilities: ["telegram:read"],
      }),
      orgId,
      userId,
    };
  }

  it("returns 401 when no auth token is provided", async () => {
    expect.hasAssertions();
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.getLinkStatus({
        query: {},
        headers: {},
      }),
      [401],
    );

    expectUnauthorized(response.body);
  });

  it("returns linked false without installation when no link exists", async () => {
    const { token } = await seedLinkContext();
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.getLinkStatus({
        query: {},
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ linked: false });
  });

  it("returns official bot link status with the login bot id", async () => {
    const { token } = await seedLinkContext();
    mockEnv("APP_URL", "https://app.example.com");
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.getLinkStatus({
        query: {
          botId: OFFICIAL_TELEGRAM_BOT_ID,
          origin: "https://app.example.com/settings/telegram",
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      linked: false,
      installation: {
        id: OFFICIAL_TELEGRAM_BOT_ID,
        botUsername: OFFICIAL_BOT_USERNAME,
        loginBotId: "9876543210",
        domainConfigured: false,
      },
    });
  });

  it("returns linked false without installation for an unknown bot", async () => {
    const { token } = await seedLinkContext();
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.getLinkStatus({
        query: { botId: newTelegramBotId() },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ linked: false });
  });
});

describe("POST /api/integrations/telegram/link", () => {
  const fixtures: TelegramFixture[] = [];

  beforeEach(() => {
    configureOfficialBotEnv();
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  async function seedLinkContext(): Promise<{
    readonly token: string;
    readonly orgId: string;
    readonly userId: string;
  }> {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);
    fixtures.push(freezeTelegramFixture(makeTelegramFixtureBuilder(orgId)));
    mocks.clerk.session(userId, orgId);
    return {
      token: "clerk-session",
      orgId,
      userId,
    };
  }

  async function seedDefaultAgentForLink(
    orgId: string,
    userId: string,
  ): Promise<void> {
    const builder = makeTelegramFixtureBuilder(orgId);
    const agent = await store.set(
      seedOrgDefaultAgent$,
      { orgId, userId },
      context.signal,
    );
    builder.composeIds.push(agent.composeId);
    fixtures.push(freezeTelegramFixture(builder));
  }

  it("returns 401 when not authenticated", async () => {
    expect.hasAssertions();
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: {},
        body: { telegramBotId: "some-id" },
      }),
      [401],
    );

    expectUnauthorized(response.body);
  });

  it("returns 400 when telegramBotId is missing", async () => {
    const { token } = await seedLinkContext();
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {} as never,
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 409 when connecting the official bot before onboarding creates a default agent", async () => {
    const { token } = await seedLinkContext();
    const telegramUserId = Number(newTelegramBotId());
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);
    server.use(telegramOauthHead("0"));

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {
          telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
          telegramAuth: makeTelegramAuth(
            telegramUserId,
            "official_tg",
            OFFICIAL_BOT_TOKEN,
          ),
        },
      }),
      [409],
    );

    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.message).toBe(
      "Finish onboarding before connecting Telegram. Telegram needs a default agent for this workspace.",
    );

    const status = await accept(
      client.getLinkStatus({
        query: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(status.body.linked).toBeFalsy();
  });

  it("links the official bot account via Telegram Login Widget auth", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    await seedDefaultAgentForLink(orgId, userId);
    const telegramUserId = Number(newTelegramBotId());
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {
          telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
          telegramAuth: makeTelegramAuth(
            telegramUserId,
            "official_tg",
            OFFICIAL_BOT_TOKEN,
          ),
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      botUsername: OFFICIAL_BOT_USERNAME,
      telegramUserId: String(telegramUserId),
    });
    await expectTelegramBotConnection({
      token,
      botId: OFFICIAL_TELEGRAM_BOT_ID,
      telegramUserId: String(telegramUserId),
      telegramUsername: "official_tg",
      telegramDisplayName: "Test",
    });
  });

  it("connects the official Telegram bot with a signed payload", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    await seedDefaultAgentForLink(orgId, userId);
    const telegramUserId = "99015";
    const sentMessages: { readonly chat_id: string; readonly text: string }[] =
      [];
    server.use(
      http.post(
        `https://api.telegram.org/bot${OFFICIAL_BOT_TOKEN}/sendMessage`,
        async ({ request }) => {
          sentMessages.push(
            (await request.json()) as { chat_id: string; text: string },
          );
          return HttpResponse.json({
            ok: true,
            result: { message_id: 1, chat: { id: Number(telegramUserId) } },
          });
        },
      ),
    );
    const timestamp = Math.floor(now() / 1000);
    const app = createApp({
      signal: context.signal,
      routes: integrationsTelegramRoutes,
    });

    const response = await app.request(
      "https://api.okou.ai/api/integrations/telegram/link",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          origin: "https://app.okou.ai",
        },
        body: JSON.stringify({
          telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
          connectSignature: {
            telegramUserId,
            timestamp,
            signature: signConnectParams({
              installationId: OFFICIAL_TELEGRAM_BOT_ID,
              telegramUserId,
              timestamp,
              botToken: OFFICIAL_BOT_TOKEN,
            }),
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      botUsername: OFFICIAL_BOT_USERNAME,
      telegramUserId,
    });
    await flushWaitUntilForTest();
    expect(sentMessages).toStrictEqual([
      {
        chat_id: telegramUserId,
        parse_mode: "HTML",
        text: "✅ Account linked.\nSend me a message to start chatting with Okou.",
      },
    ]);
  });

  it("returns 409 when an official Telegram user is already linked in another org", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    await seedDefaultAgentForLink(orgId, userId);
    const otherOrgId = `org_${randomUUID()}`;
    fixtures.push(
      freezeTelegramFixture(makeTelegramFixtureBuilder(otherOrgId)),
    );
    const telegramUserId = Number(newTelegramBotId());
    await store.set(
      seedOfficialUserLink$,
      {
        orgId: otherOrgId,
        userId: `user_${randomUUID()}`,
        telegramUserId: String(telegramUserId),
      },
      context.signal,
    );
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const body = {
      telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
      telegramAuth: makeTelegramAuth(
        telegramUserId,
        "official_tg",
        OFFICIAL_BOT_TOKEN,
      ),
    };
    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body,
      }),
      [409],
    );

    expect(response.body.error).toStrictEqual({
      code: "CONFLICT",
      message: `This Telegram account is already connected to another Okou organization through the official Telegram bot @${OFFICIAL_BOT_USERNAME}. Disconnect it before connecting a different account.`,
    });
  });
});

describe("GET /api/integrations/telegram/:botId/avatar", () => {
  const fixtures: TelegramFixture[] = [];

  beforeEach(() => {
    configureOfficialBotEnv();
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  function requestPathFromSignedUrl(url: string): string {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  }

  async function seedAvatarAuthContext(): Promise<{
    readonly orgId: string;
    readonly userId: string;
    readonly token: string;
  }> {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);

    return {
      orgId,
      userId,
      token: mintOkouToken({
        userId,
        orgId,
        capabilities: ["telegram:read"],
      }),
    };
  }

  function mockTelegramAvatarDownload(args: {
    readonly fileBytes: Buffer;
    readonly botToken?: string;
  }): void {
    const botToken = args.botToken ?? "test-bot-token";
    context.mocks.telegram.getUserProfilePhotos.mockResolvedValue([
      [
        {
          file_id: "small-avatar",
          width: 64,
          height: 64,
        },
        {
          file_id: "large-avatar",
          width: 320,
          height: 320,
          file_size: args.fileBytes.length,
        },
      ],
    ]);
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "large-avatar",
      file_size: args.fileBytes.length,
      file_path: "photos/avatar.jpg",
    });
    server.use(
      http.get(
        `https://api.telegram.org/file/bot${botToken}/photos/avatar.jpg`,
        () => {
          return new HttpResponse(args.fileBytes, {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
              "content-length": String(args.fileBytes.length),
            },
          });
        },
      ),
    );
  }

  it("returns 404 when the bot is not visible in the active org", async () => {
    const { token } = await seedAvatarAuthContext();
    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const response = await app.request(
      "/api/integrations/telegram/missing-bot/avatar",
      { headers: { authorization: `Bearer ${token}` } },
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toStrictEqual({
      error: {
        message: "Telegram bot not found",
        code: "NOT_FOUND",
      },
    });
  });

  it("streams the signed official Telegram bot avatar from the configured token", async () => {
    const fileBytes = Buffer.from("official telegram avatar bytes");
    mockTelegramAvatarDownload({
      botToken: OFFICIAL_BOT_TOKEN,
      fileBytes,
    });

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const response = await app.request(
      requestPathFromSignedUrl(
        buildTelegramBotAvatarUrl(OFFICIAL_TELEGRAM_BOT_ID),
      ),
    );

    expect(response.status).toBe(200);
    expect(context.mocks.telegram.getUserProfilePhotos).toHaveBeenCalledWith(
      OFFICIAL_BOT_TOKEN,
      9_876_543_210,
      1,
    );
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBeTruthy();
  });
});

describe("GET /api/integrations/telegram/auth-callback", () => {
  it("returns the Telegram auth bridge html", async () => {
    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });

    const response = await app.request(
      "/api/integrations/telegram/auth-callback",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<title>Telegram Auth</title>");
    expect(html).toContain(
      'new URLSearchParams(window.location.hash.replace(/^#/, ""))',
    );
    expect(html).toContain('var targetOrigin = "http://localhost:3002";');
    expect(html).toContain(
      '["id","first_name","last_name","username","photo_url","auth_date","hash"]',
    );
    expect(html).toContain('{ type: "telegram-auth", data: data }');
    expect(html).toContain("window.close()");
  });

  it("accepts only a trusted Telegram auth callback target origin", async () => {
    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });

    const trusted = await app.request(
      "/api/integrations/telegram/auth-callback?targetOrigin=https%3A%2F%2Fapp.okou.ai",
    );
    expect(trusted.status).toBe(200);
    await expect(trusted.text()).resolves.toContain(
      'var targetOrigin = "https://app.okou.ai";',
    );

    const untrusted = await app.request(
      "/api/integrations/telegram/auth-callback?targetOrigin=https%3A%2F%2Fevil.example",
    );
    expect(untrusted.status).toBe(400);
    await expect(untrusted.text()).resolves.toBe("Invalid target origin");
  });
});

describe("GET /api/integrations/telegram/download-file", () => {
  const fixtures: TelegramFixture[] = [];
  const downloadPath = "/api/integrations/telegram/download-file";

  beforeEach(() => {
    configureOfficialBotEnv();
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  function requestDownload(args: {
    readonly search: string;
    readonly token?: string;
    readonly authorization?: string;
  }): Response | Promise<Response> {
    const headers: Record<string, string> = {};
    if (args.token) {
      headers.authorization = `Bearer ${args.token}`;
    }
    if (args.authorization) {
      headers.authorization = args.authorization;
    }
    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    return app.request(`${downloadPath}${args.search}`, { headers });
  }

  async function seedReadToken(): Promise<string> {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);
    return mintOkouToken({
      userId,
      orgId,
      capabilities: ["telegram:read"],
    });
  }

  function expectJson(response: Response): Promise<unknown> {
    expect(response.headers.get("content-type")).toContain("application/json");
    return response.json();
  }

  it("returns 401 when no auth token is provided", async () => {
    const response = await requestDownload({
      search: "?file_id=tg-file-1&bot_id=tg-bot",
    });

    expect(response.status).toBe(401);
    expectUnauthorized(await expectJson(response));
  });

  it("returns 401 when the token has no active organization membership", async () => {
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });

    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const token = mintOkouToken({
      userId,
      orgId,
      capabilities: ["telegram:read"],
    });

    const response = await requestDownload({
      search: "?file_id=tg-file-1&bot_id=tg-bot",
      token,
    });

    expect(response.status).toBe(401);
    expectUnauthorized(await expectJson(response));
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const response = await requestDownload({
      search: "?file_id=tg-file-1&bot_id=tg-bot",
      authorization: "Bearer clerk-session",
    });

    expect(response.status).toBe(401);
    expectUnauthorized(await expectJson(response));
  });

  it("returns 400 when file_id query param is missing", async () => {
    const token = await seedReadToken();

    const response = await requestDownload({
      search: "?bot_id=tg-bot",
      token,
    });

    expect(response.status).toBe(400);
    const body = await expectJson(response);
    expect(body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(JSON.stringify(body)).toContain("file_id");
  });

  it("returns 400 when bot_id query param is missing", async () => {
    const token = await seedReadToken();

    const response = await requestDownload({
      search: "?file_id=tg-file-1",
      token,
    });

    expect(response.status).toBe(400);
    const body = await expectJson(response);
    expect(body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(JSON.stringify(body)).toContain("bot_id");
  });

  it("returns 404 for an unsupported bot id", async () => {
    const token = await seedReadToken();

    const response = await requestDownload({
      search: "?file_id=tg-missing&bot_id=unknown-bot",
      token,
    });

    expect(response.status).toBe(404);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: { message: "Telegram bot not found", code: "NOT_FOUND" },
    });
  });

  it("streams files for the official Telegram bot", async () => {
    const token = await seedReadToken();
    const fileBytes = Buffer.from("official telegram bytes");
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-official",
      file_size: fileBytes.length,
      file_path: "photos/official.jpg",
    });
    server.use(
      http.get(
        `https://api.telegram.org/file/bot${OFFICIAL_BOT_TOKEN}/photos/official.jpg`,
        () => {
          return new HttpResponse(fileBytes, {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
              "content-length": String(fileBytes.length),
            },
          });
        },
      ),
    );

    const response = await requestDownload({
      search: `?file_id=tg-official&bot_id=${OFFICIAL_TELEGRAM_BOT_ID}`,
      token,
    });

    expect(response.status).toBe(200);
    expect(context.mocks.telegram.getFile).toHaveBeenCalledWith(
      OFFICIAL_BOT_TOKEN,
      "tg-official",
    );
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-file-name")).toBe("official.jpg");
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBeTruthy();
  });
});
