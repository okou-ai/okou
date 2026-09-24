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
import {
  deleteTelegramFixture$,
  freezeTelegramFixture,
  makeTelegramFixtureBuilder,
  seedOrgDefaultAgent$,
  seedOfficialUserLink$,
  seedTelegramInstallation$,
  seedTelegramUserLink$,
  type TelegramFixture,
} from "./helpers/telegram";
import { createRouteMocks } from "./helpers/route-test";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { integrationsTelegramRoutes } from "../integrations-telegram";

const TEST_APP_ROUTES = Object.freeze([...integrationsTelegramRoutes]);

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const storages = createStoragesBddApi(context);

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
  if (args.botId !== OFFICIAL_TELEGRAM_BOT_ID) {
    context.mocks.telegram.getMe.mockResolvedValue({
      id: Number(args.botId),
      is_bot: true,
      first_name: "Bot",
      username: `bot_${args.botId}`,
    });
  }
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

  it("lists the official bot and custom Telegram bots in the active org", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;

    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);

    const ownerBotId = newTelegramBotId();
    const orgBotId = newTelegramBotId();
    const otherOrgBotId = newTelegramBotId();

    context.mocks.telegram.getMe.mockResolvedValue({
      id: Number(ownerBotId),
      is_bot: true,
      first_name: "Bot",
      username: "x",
    });

    const builderA = makeTelegramFixtureBuilder(orgId);
    const builderB = makeTelegramFixtureBuilder(otherOrgId);

    const ownerInstall = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId: ownerBotId },
      context.signal,
    );
    builderA.composeIds.push(ownerInstall.composeId);
    builderA.telegramBotIds.push(ownerInstall.telegramBotId);
    await store.set(
      seedTelegramUserLink$,
      {
        installationId: ownerInstall.telegramBotId,
        telegramUserId: "tg-owner",
        telegramUsername: "owner_tg",
        telegramDisplayName: "Owner Telegram",
        userId: userId,
      },
      context.signal,
    );

    const orgInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId,
        ownerUserId: `user_${randomUUID()}`,
        telegramBotId: orgBotId,
      },
      context.signal,
    );
    builderA.composeIds.push(orgInstall.composeId);
    builderA.telegramBotIds.push(orgInstall.telegramBotId);

    const otherOrgInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId: otherOrgId,
        ownerUserId: userId,
        telegramBotId: otherOrgBotId,
      },
      context.signal,
    );
    builderB.composeIds.push(otherOrgInstall.composeId);
    builderB.telegramBotIds.push(otherOrgInstall.telegramBotId);

    fixtures.push(freezeTelegramFixture(builderA));
    fixtures.push(freezeTelegramFixture(builderB));

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

    expect(response.body.bots).toHaveLength(3);
    expect(response.body.bots).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: OFFICIAL_TELEGRAM_BOT_ID,
          kind: "official",
          isOwner: false,
          official: expect.objectContaining({
            linkedTelegramUserId: null,
          }),
        }),
        expect.objectContaining({
          id: ownerBotId,
          username: `bot_${ownerBotId}`,
          isOwner: true,
          isConnected: true,
          connectedUser: {
            telegramUserId: "tg-owner",
            telegramUsername: "owner_tg",
            telegramDisplayName: "Owner Telegram",
          },
          tokenStatus: "valid",
          agent: expect.objectContaining({ id: ownerInstall.composeId }),
        }),
        expect.objectContaining({
          id: orgBotId,
          isOwner: false,
          isConnected: false,
        }),
      ]),
    );
    expect(
      response.body.bots.some((bot) => {
        return bot.id === otherOrgBotId;
      }),
    ).toBeFalsy();
  });

  it("returns the official bot when the active org has no custom Telegram bots", async () => {
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

  it("returns the configured official bot when the active org has no custom Telegram bots", async () => {
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

  it("includes connected official and non-owner custom Telegram user profiles", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const customBotId = newTelegramBotId();

    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);

    context.mocks.telegram.getMe.mockResolvedValue({
      id: Number(customBotId),
      is_bot: true,
      first_name: "Bot",
      username: "x",
    });

    const builder = makeTelegramFixtureBuilder(orgId);
    const customInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId,
        ownerUserId: `user_${randomUUID()}`,
        telegramBotId: customBotId,
      },
      context.signal,
    );
    builder.composeIds.push(customInstall.composeId);
    builder.telegramBotIds.push(customInstall.telegramBotId);
    await store.set(
      seedOfficialUserLink$,
      {
        orgId,
        userId,
        telegramUserId: "tg-official-user",
        telegramUsername: "official_ada",
        telegramDisplayName: "Official Ada",
      },
      context.signal,
    );
    await store.set(
      seedTelegramUserLink$,
      {
        installationId: customInstall.telegramBotId,
        telegramUserId: "tg-custom-user",
        telegramUsername: "custom_ada",
        telegramDisplayName: "Custom Ada",
        userId: userId,
      },
      context.signal,
    );
    fixtures.push(freezeTelegramFixture(builder));

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

    expect(response.body.bots).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: OFFICIAL_TELEGRAM_BOT_ID,
          kind: "official",
          isConnected: true,
          connectedUser: {
            telegramUserId: "tg-official-user",
            telegramUsername: "official_ada",
            telegramDisplayName: "Official Ada",
          },
          official: expect.objectContaining({
            linkedTelegramUserId: "tg-official-user",
          }),
        }),
        expect.objectContaining({
          id: customBotId,
          isOwner: false,
          isConnected: true,
          connectedUser: {
            telegramUserId: "tg-custom-user",
            telegramUsername: "custom_ada",
            telegramDisplayName: "Custom Ada",
          },
        }),
      ]),
    );
  });

  it("marks a custom bot token invalid when Telegram returns a different bot id", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const botId = newTelegramBotId();

    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);

    context.mocks.telegram.getMe.mockResolvedValue({
      id: Number(botId) + 1,
      is_bot: true,
      first_name: "Bot",
      username: "mismatched_bot",
    });

    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId: botId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));

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

    expect(response.body.bots).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: botId,
          tokenStatus: "invalid",
        }),
      ]),
    );
  });

  it("lists official and active-org custom bots with link status", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;

    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);

    const linkedBotId = newTelegramBotId();
    const unlinkedBotId = newTelegramBotId();
    const otherOrgBotId = newTelegramBotId();

    context.mocks.telegram.getMe.mockImplementation((token: unknown) => {
      const botId =
        token === "test-bot-token"
          ? linkedBotId
          : String(token).split(":", 1)[0];
      return Promise.resolve({
        id: Number(botId),
        is_bot: true,
        first_name: "Bot",
        username: "x",
      });
    });

    const builderA = makeTelegramFixtureBuilder(orgId);
    const builderB = makeTelegramFixtureBuilder(otherOrgId);

    const linkedInstall = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId: linkedBotId },
      context.signal,
    );
    builderA.composeIds.push(linkedInstall.composeId);
    builderA.telegramBotIds.push(linkedInstall.telegramBotId);
    await store.set(
      seedTelegramUserLink$,
      {
        installationId: linkedInstall.telegramBotId,
        telegramUserId: "tg-linked-user",
        userId: userId,
      },
      context.signal,
    );

    const unlinkedInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId,
        ownerUserId: `user_${randomUUID()}`,
        telegramBotId: unlinkedBotId,
      },
      context.signal,
    );
    builderA.composeIds.push(unlinkedInstall.composeId);
    builderA.telegramBotIds.push(unlinkedInstall.telegramBotId);

    const otherOrgInstall = await store.set(
      seedTelegramInstallation$,
      {
        orgId: otherOrgId,
        ownerUserId: userId,
        telegramBotId: otherOrgBotId,
      },
      context.signal,
    );
    builderB.composeIds.push(otherOrgInstall.composeId);
    builderB.telegramBotIds.push(otherOrgInstall.telegramBotId);

    fixtures.push(freezeTelegramFixture(builderA));
    fixtures.push(freezeTelegramFixture(builderB));

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

    expect(response.body.bots).toHaveLength(3);
    expect(response.body.bots).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: OFFICIAL_TELEGRAM_BOT_ID,
          kind: "official",
        }),
        expect.objectContaining({
          id: linkedBotId,
          isOwner: true,
          isConnected: true,
          avatarUrl: expect.stringContaining(
            `/api/integrations/telegram/${linkedBotId}/avatar?exp=`,
          ),
        }),
        expect.objectContaining({
          id: unlinkedBotId,
          isOwner: false,
          isConnected: false,
        }),
      ]),
    );
    expect(
      response.body.bots.some((bot) => {
        return bot.id === otherOrgBotId;
      }),
    ).toBeFalsy();
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

  it("returns linked true with the latest custom bot link", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const telegramBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    await store.set(
      seedTelegramUserLink$,
      {
        installationId: telegramBotId,
        telegramUserId: "tg-linked-user",
        userId: userId,
      },
      context.signal,
    );
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

    expect(response.body).toStrictEqual({
      linked: true,
      telegramUserId: "tg-linked-user",
      botUsername: `bot_${telegramBotId}`,
    });
  });

  it("scopes linked status to the requested bot", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const linkedBotId = newTelegramBotId();
    const unlinkedBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);

    for (const botId of [linkedBotId, unlinkedBotId]) {
      const installation = await store.set(
        seedTelegramInstallation$,
        { orgId, ownerUserId: userId, telegramBotId: botId },
        context.signal,
      );
      builder.composeIds.push(installation.composeId);
      builder.telegramBotIds.push(installation.telegramBotId);
    }
    fixtures.push(freezeTelegramFixture(builder));
    await store.set(
      seedTelegramUserLink$,
      {
        installationId: linkedBotId,
        telegramUserId: "tg-linked-user",
        userId: userId,
      },
      context.signal,
    );

    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);
    const linkedResponse = await accept(
      client.getLinkStatus({
        query: { botId: linkedBotId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    const unlinkedResponse = await accept(
      client.getLinkStatus({
        query: { botId: unlinkedBotId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(linkedResponse.body).toMatchObject({
      linked: true,
      telegramUserId: "tg-linked-user",
      botUsername: `bot_${linkedBotId}`,
    });
    expect(unlinkedResponse.body).toStrictEqual({
      linked: false,
      installation: {
        id: unlinkedBotId,
        botUsername: `bot_${unlinkedBotId}`,
        loginBotId: unlinkedBotId,
        domainConfigured: false,
      },
    });
  });

  it("returns installation info for an unlinked custom bot with origin-scoped domain status", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const telegramBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    mockEnv("APP_URL", "https://app.example.com");
    const observedOrigins: (string | null)[] = [];
    server.use(telegramOauthHead("2048", observedOrigins));
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.getLinkStatus({
        query: {
          botId: telegramBotId,
          origin: "https://app.example.com/some/path",
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      linked: false,
      installation: {
        id: telegramBotId,
        botUsername: `bot_${telegramBotId}`,
        loginBotId: telegramBotId,
        domainConfigured: true,
      },
    });
    expect(observedOrigins).toStrictEqual(["https://app.example.com"]);
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

  it("returns 403 when the requested bot belongs to another org", async () => {
    const { token } = await seedLinkContext();
    const otherOrgId = `org_${randomUUID()}`;
    const otherBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(otherOrgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      {
        orgId: otherOrgId,
        ownerUserId: `user_${randomUUID()}`,
        telegramBotId: otherBotId,
      },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.getLinkStatus({
        query: { botId: otherBotId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
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

  it("returns 404 when the custom bot installation does not exist", async () => {
    const { token } = await seedLinkContext();
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {
          telegramBotId: newTelegramBotId(),
          telegramAuth: makeTelegramAuth(99_001, "missing_bot"),
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("links a custom bot account without provisioning artifact storage", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const telegramBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {
          telegramBotId,
          telegramAuth: makeTelegramAuth(99_002, "custom_tg"),
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      botUsername: `bot_${telegramBotId}`,
      telegramUserId: "99002",
    });

    const status = await accept(
      client.getLinkStatus({
        query: { botId: telegramBotId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(status.body).toMatchObject({
      linked: true,
      telegramUserId: "99002",
      botUsername: `bot_${telegramBotId}`,
    });
    await expect(
      storages.listStorages(
        {
          userId,
          orgId,
          orgRole: "org:admin",
          email: `${userId}@example.test`,
        },
        "user",
      ),
    ).resolves.toStrictEqual([]);
    await expectTelegramBotConnection({
      token,
      botId: telegramBotId,
      telegramUserId: "99002",
      telegramUsername: "custom_tg",
      telegramDisplayName: "Test",
    });
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

  it("returns 409 when a Telegram user is already linked to another user for the same bot", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const telegramBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    await store.set(
      seedTelegramUserLink$,
      {
        installationId: telegramBotId,
        telegramUserId: "99004",
        userId: `user_${randomUUID()}`,
      },
      context.signal,
    );
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const body = {
      telegramBotId,
      telegramAuth: makeTelegramAuth(99_004, "taken_tg"),
    };
    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body,
      }),
      [409],
    );

    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.message).toContain(
      "already connected to another Okou account",
    );
  });

  it("returns 409 when the internal user is already linked to another Telegram user for the same bot", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const telegramBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    await store.set(
      seedTelegramUserLink$,
      {
        installationId: telegramBotId,
        telegramUserId: "99009",
        userId: userId,
      },
      context.signal,
    );
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {
          telegramBotId,
          telegramAuth: makeTelegramAuth(99_010, "replacement_tg"),
        },
      }),
      [409],
    );

    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.message).toContain(
      "already connected to another Telegram account",
    );
    await expectTelegramBotConnection({
      token,
      botId: telegramBotId,
      telegramUserId: "99009",
      telegramUsername: null,
      telegramDisplayName: null,
    });
  });

  it("allows the same Telegram user to connect through a different custom bot", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const firstBotId = newTelegramBotId();
    const secondBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);

    for (const botId of [firstBotId, secondBotId]) {
      const installation = await store.set(
        seedTelegramInstallation$,
        { orgId, ownerUserId: userId, telegramBotId: botId },
        context.signal,
      );
      builder.composeIds.push(installation.composeId);
      builder.telegramBotIds.push(installation.telegramBotId);
    }
    fixtures.push(freezeTelegramFixture(builder));
    await store.set(
      seedTelegramUserLink$,
      {
        installationId: firstBotId,
        telegramUserId: "99011",
        userId: `user_${randomUUID()}`,
      },
      context.signal,
    );
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {
          telegramBotId: secondBotId,
          telegramAuth: makeTelegramAuth(99_011, "shared_tg"),
        },
      }),
      [200],
    );

    expect(response.body.telegramUserId).toBe("99011");
    await expectTelegramBotConnection({
      token,
      botId: secondBotId,
      telegramUserId: "99011",
      telegramUsername: "shared_tg",
      telegramDisplayName: "Test",
    });
  });

  it("treats reconnecting the same Telegram user to the same internal user as idempotent", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const telegramBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    await store.set(
      seedTelegramUserLink$,
      {
        installationId: telegramBotId,
        telegramUserId: "99012",
        userId: userId,
      },
      context.signal,
    );
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {
          telegramBotId,
          telegramAuth: makeTelegramAuth(99_012, "same_tg"),
        },
      }),
      [200],
    );

    expect(response.body.telegramUserId).toBe("99012");
    await expectTelegramBotConnection({
      token,
      botId: telegramBotId,
      telegramUserId: "99012",
      telegramUsername: "same_tg",
      telegramDisplayName: "Test",
    });
  });

  it("links a custom bot account via a valid connectSignature and sends confirmation", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const telegramBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    const sentMessages: {
      readonly chat_id: string;
      readonly text: string;
    }[] = [];
    server.use(
      http.post(
        "https://api.telegram.org/bottest-bot-token/sendMessage",
        async ({ request }) => {
          sentMessages.push(
            (await request.json()) as { chat_id: string; text: string },
          );
          return HttpResponse.json({
            ok: true,
            result: { message_id: 1, chat: { id: 99_005 } },
          });
        },
      ),
    );
    const timestamp = Math.floor(now() / 1000);
    const telegramUserId = "99005";
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {
          telegramBotId,
          connectSignature: {
            telegramUserId,
            telegramUsername: "connect_tg",
            telegramDisplayName: "Connect User",
            timestamp,
            signature: signConnectParams({
              installationId: telegramBotId,
              telegramUserId,
              timestamp,
              telegramUsername: "connect_tg",
              telegramDisplayName: "Connect User",
            }),
          },
        },
      }),
      [200],
    );

    expect(response.body.telegramUserId).toBe(telegramUserId);
    await flushWaitUntilForTest();
    expect(sentMessages).toStrictEqual([
      {
        chat_id: telegramUserId,
        parse_mode: "HTML",
        text: "✅ Account linked.\nSend me a message to start chatting with your agent.",
      },
    ]);
    await expectTelegramBotConnection({
      token,
      botId: telegramBotId,
      telegramUserId,
      telegramUsername: "connect_tg",
      telegramDisplayName: "Connect User",
    });
  });

  it("returns 403 when connecting a custom bot from another org", async () => {
    const { token } = await seedLinkContext();
    const otherOrgId = `org_${randomUUID()}`;
    const otherBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(otherOrgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      {
        orgId: otherOrgId,
        ownerUserId: `user_${randomUUID()}`,
        telegramBotId: otherBotId,
      },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {
          telegramBotId: otherBotId,
          telegramAuth: makeTelegramAuth(99_006),
        },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 for invalid telegramAuth hash", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const telegramBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {
          telegramBotId,
          telegramAuth: {
            id: 99_007,
            first_name: "Test",
            auth_date: Math.floor(now() / 1000),
            hash: "invalid_hash",
          },
        },
      }),
      [400],
    );

    expect(response.body.error.message).toBe("Invalid Telegram authorization");
  });

  it("returns 400 for invalid connectSignature", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const telegramBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {
          telegramBotId,
          connectSignature: {
            telegramUserId: "99013",
            timestamp: Math.floor(now() / 1000),
            signature: "a".repeat(64),
          },
        },
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "Invalid or expired connect link",
    );
  });

  it("returns 400 for expired connectSignature", async () => {
    const { token, orgId, userId } = await seedLinkContext();
    const telegramBotId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    const timestamp = Math.floor(now() / 1000) - 601;
    const telegramUserId = "99008";
    const client = setupApp({
      context,
      routes: integrationsTelegramRoutes,
    })(integrationsTelegramContract);

    const response = await accept(
      client.link({
        headers: { authorization: `Bearer ${token}` },
        body: {
          telegramBotId,
          connectSignature: {
            telegramUserId,
            timestamp,
            signature: signConnectParams({
              installationId: telegramBotId,
              telegramUserId,
              timestamp,
            }),
          },
        },
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "Invalid or expired connect link",
    );
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

  async function seedAvatarInstallationContext(
    botId: string = newTelegramBotId(),
  ): Promise<{
    readonly orgId: string;
    readonly userId: string;
    readonly token: string;
    readonly botId: string;
  }> {
    const auth = await seedAvatarAuthContext();
    const builder = makeTelegramFixtureBuilder(auth.orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId: auth.orgId, ownerUserId: auth.userId, telegramBotId: botId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    return { ...auth, botId };
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

  it("streams an authenticated custom bot avatar from the active org", async () => {
    const { botId, token } = await seedAvatarInstallationContext();
    const fileBytes = Buffer.from("authenticated telegram avatar bytes");
    mockTelegramAvatarDownload({
      fileBytes,
    });

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const response = await app.request(
      `/api/integrations/telegram/${botId}/avatar`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    expect(context.mocks.telegram.getUserProfilePhotos).toHaveBeenCalledWith(
      "test-bot-token",
      Number(botId),
      1,
    );
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBeTruthy();
  });

  it("streams a signed custom bot avatar without auth", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);

    const botId = newTelegramBotId();
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId: botId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));

    const fileBytes = Buffer.from("telegram avatar bytes");
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
          file_size: fileBytes.length,
        },
      ],
    ]);
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "large-avatar",
      file_size: fileBytes.length,
      file_path: "photos/avatar.jpg",
    });
    server.use(
      http.get(
        "https://api.telegram.org/file/bottest-bot-token/photos/avatar.jpg",
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

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const response = await app.request(
      requestPathFromSignedUrl(buildTelegramBotAvatarUrl(botId)),
    );

    expect(response.status).toBe(200);
    expect(context.mocks.telegram.getUserProfilePhotos).toHaveBeenCalledWith(
      "test-bot-token",
      Number(botId),
      1,
    );
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBeTruthy();
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

  it("returns fallback svg when Telegram has no avatar", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);

    const botId = "tg-bot-no-avatar";
    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId: userId, telegramBotId: botId },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));
    const token = mintOkouToken({
      userId,
      orgId,
      capabilities: ["telegram:read"],
    });
    context.mocks.telegram.getUserProfilePhotos.mockResolvedValue([]);

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const response = await app.request(
      `/api/integrations/telegram/${botId}/avatar`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    await expect(response.text()).resolves.toContain(
      "Telegram bot avatar fallback",
    );
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

  async function seedDownloadContext(): Promise<{
    readonly token: string;
    readonly botId: string;
  }> {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await store.set(seedOrgMembership$, { orgId, userId }, context.signal);

    const builder = makeTelegramFixtureBuilder(orgId);
    const installation = await store.set(
      seedTelegramInstallation$,
      {
        orgId,
        ownerUserId: userId,
        telegramBotId: newTelegramBotId(),
      },
      context.signal,
    );
    builder.composeIds.push(installation.composeId);
    builder.telegramBotIds.push(installation.telegramBotId);
    fixtures.push(freezeTelegramFixture(builder));

    return {
      token: mintOkouToken({
        userId,
        orgId,
        capabilities: ["telegram:read"],
      }),
      botId: installation.telegramBotId,
    };
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

  it("returns 404 when the custom bot id is not known in the org", async () => {
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

  it("streams files for a custom Telegram bot", async () => {
    const { token, botId } = await seedDownloadContext();
    const fileBytes = Buffer.from("custom telegram bytes");
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-custom",
      file_size: fileBytes.length,
      file_path: "photos/custom.jpg",
    });
    server.use(
      http.get(
        "https://api.telegram.org/file/bottest-bot-token/photos/custom.jpg",
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
      search: `?file_id=tg-custom&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(200);
    expect(context.mocks.telegram.getFile).toHaveBeenCalledWith(
      "test-bot-token",
      "tg-custom",
    );
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-file-mimetype")).toBe("image/jpeg");
    expect(response.headers.get("x-file-name")).toBe("custom.jpg");
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBeTruthy();
  });

  it("returns 404 when Telegram file metadata has no downloadable path", async () => {
    const { token, botId } = await seedDownloadContext();
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-no-path",
    });

    const response = await requestDownload({
      search: `?file_id=tg-no-path&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(404);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: {
        message: "Telegram file does not have a downloadable path",
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 413 when Telegram reports a file over the proxy limit", async () => {
    const { token, botId } = await seedDownloadContext();
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-file-big",
      file_size: 200 * 1024 * 1024,
      file_path: "documents/big.bin",
    });

    const response = await requestDownload({
      search: `?file_id=tg-file-big&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(413);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: {
        message: "File exceeds maximum size of 104857600 bytes",
        code: "PAYLOAD_TOO_LARGE",
      },
    });
  });

  it("returns 413 when download content-length exceeds the proxy limit", async () => {
    const { token, botId } = await seedDownloadContext();
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-huge-response",
      file_path: "documents/huge-response.bin",
    });
    server.use(
      http.get(
        "https://api.telegram.org/file/bottest-bot-token/documents/huge-response.bin",
        () => {
          return new HttpResponse(Buffer.from("not actually huge"), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(200 * 1024 * 1024),
            },
          });
        },
      ),
    );

    const response = await requestDownload({
      search: `?file_id=tg-huge-response&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(413);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: {
        message: "File exceeds maximum size of 104857600 bytes",
        code: "PAYLOAD_TOO_LARGE",
      },
    });
  });

  it("returns 502 when Telegram returns HTML for a file download", async () => {
    const { token, botId } = await seedDownloadContext();
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-html",
      file_path: "documents/html.bin",
    });
    server.use(
      http.get(
        "https://api.telegram.org/file/bottest-bot-token/documents/html.bin",
        () => {
          return new HttpResponse("<html></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        },
      ),
    );

    const response = await requestDownload({
      search: `?file_id=tg-html&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(502);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: {
        message: "Telegram returned an unexpected response",
        code: "BAD_GATEWAY",
      },
    });
  });

  it("returns 502 when Telegram file download returns a non-OK response", async () => {
    const { token, botId } = await seedDownloadContext();
    context.mocks.telegram.getFile.mockResolvedValue({
      file_id: "tg-download-fail",
      file_path: "documents/fail.bin",
    });
    server.use(
      http.get(
        "https://api.telegram.org/file/bottest-bot-token/documents/fail.bin",
        () => {
          return new HttpResponse("unavailable", { status: 503 });
        },
      ),
    );

    const response = await requestDownload({
      search: `?file_id=tg-download-fail&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(502);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: {
        message: "Failed to download file from Telegram: 503",
        code: "BAD_GATEWAY",
      },
    });
  });

  it("returns a generic 502 body when Telegram file lookup throws", async () => {
    const { token, botId } = await seedDownloadContext();
    context.mocks.telegram.getFile.mockRejectedValue(
      new Error("upstream detail"),
    );

    const response = await requestDownload({
      search: `?file_id=tg-throws&bot_id=${botId}`,
      token,
    });

    expect(response.status).toBe(502);
    await expect(expectJson(response)).resolves.toStrictEqual({
      error: {
        message: "Failed to download file from Telegram",
        code: "BAD_GATEWAY",
      },
    });
  });
});
