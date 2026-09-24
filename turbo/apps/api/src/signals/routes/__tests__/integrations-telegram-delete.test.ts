import { createHash, createHmac, randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { afterEach, describe, expect, it } from "vitest";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  integrationsTelegramContract,
} from "@okouai/api-contracts/contracts/integrations-telegram";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import {
  deleteTelegramFixture$,
  type TelegramFixture,
} from "./helpers/telegram";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { integrationsTelegramRoutes } from "../integrations-telegram";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const AUTH_HEADERS = { authorization: "Bearer clerk-session" } as const;
const OFFICIAL_BOT_TOKEN = "9876543210:official-test-token";
const OFFICIAL_BOT_USERNAME = "official_okou_bot";
const OFFICIAL_WEBHOOK_SECRET = "official-test-webhook-secret";

interface TelegramAuthTestData {
  readonly id: number;
  readonly first_name: string;
  readonly username?: string;
  readonly auth_date: number;
  readonly hash: string;
}

interface SeededBot extends TelegramFixture {
  readonly botId: string;
  readonly composeId: string;
  readonly ownerUserId: string;
}

describe("DELETE /api/integrations/telegram", () => {
  const fixtures: TelegramFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteTelegramFixture$, fixture, context.signal);
      }
    }
  });

  function newId(prefix: string): string {
    return `${prefix}_${randomUUID().slice(0, 8)}`;
  }

  function newTelegramBotId(): string {
    return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
  }

  function botTokenFor(botId: string): string {
    return `${botId}:test-bot-token`;
  }

  function configureOfficialBotEnv(): void {
    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", OFFICIAL_BOT_TOKEN);
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", OFFICIAL_BOT_USERNAME);
    mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", OFFICIAL_WEBHOOK_SECRET);
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

  function user(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly orgRole?: "org:admin" | "org:member";
  }): ApiTestUser {
    return {
      orgId: args.orgId,
      userId: args.userId,
      orgRole: args.orgRole ?? "org:admin",
      email: `${args.userId}@example.test`,
    };
  }

  function mockTelegramGetMe(): void {
    context.mocks.telegram.getMe.mockImplementation((token: unknown) => {
      const tokenText = typeof token === "string" ? token : "";
      const botId = tokenText.split(":", 1)[0] ?? newTelegramBotId();
      return Promise.resolve({
        id: Number(botId),
        is_bot: true,
        first_name: "Bot",
        username:
          botId === OFFICIAL_BOT_TOKEN.split(":", 1)[0]
            ? OFFICIAL_BOT_USERNAME
            : `bot_${botId}`,
      });
    });
  }

  async function createAgent(args: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<string> {
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(user(args), {
      displayName: newId("agent"),
      visibility: "private",
    });
    return agent.agentId;
  }

  async function createDefaultAgent(args: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<string> {
    bdd.acceptAgentStorageWrites();
    return await bdd.bootstrapLimitedFreeOnboarding(user(args), {
      displayName: newId("agent"),
    });
  }

  async function seedBot(
    args: {
      readonly orgId?: string;
      readonly ownerUserId?: string;
      readonly botId?: string;
    } = {},
  ): Promise<SeededBot> {
    const orgId = args.orgId ?? newId("org");
    const ownerUserId = args.ownerUserId ?? newId("user");
    const botId = args.botId ?? newTelegramBotId();
    const composeId = await createAgent({ orgId, userId: ownerUserId });
    mockTelegramGetMe();
    mocks.clerk.session(ownerUserId, orgId, "org:admin");

    await accept(
      client().register({
        headers: AUTH_HEADERS,
        body: {
          botToken: botTokenFor(botId),
          defaultAgentId: composeId,
        },
      }),
      [201],
    );

    const fixture = {
      orgId,
      composeIds: [composeId],
      telegramBotIds: [botId],
      userIds: [ownerUserId],
      botId,
      composeId,
      ownerUserId,
    };
    fixtures.push(fixture);
    return fixture;
  }

  function client() {
    return setupApp({ context, routes: integrationsTelegramRoutes })(
      integrationsTelegramContract,
    );
  }

  async function linkCustomBot(args: {
    readonly bot: SeededBot;
    readonly userId: string;
    readonly telegramUserId: string;
  }): Promise<void> {
    bdd.acceptAgentStorageWrites();
    mocks.clerk.session(args.userId, args.bot.orgId, "org:member");
    await accept(
      client().link({
        headers: AUTH_HEADERS,
        body: {
          telegramBotId: args.bot.botId,
          telegramAuth: makeTelegramAuth(
            Number(args.telegramUserId),
            `telegram_${args.telegramUserId}`,
            botTokenFor(args.bot.botId),
          ),
        },
      }),
      [200],
    );
  }

  async function linkOfficialBot(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly telegramUserId: string;
  }): Promise<void> {
    configureOfficialBotEnv();
    const composeId = await createDefaultAgent(args);
    fixtures.push({
      orgId: args.orgId,
      composeIds: [composeId],
      telegramBotIds: [],
      userIds: [args.userId],
    });
    bdd.acceptAgentStorageWrites();
    mocks.clerk.session(args.userId, args.orgId, "org:member");
    await accept(
      client().link({
        headers: AUTH_HEADERS,
        body: {
          telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
          telegramAuth: makeTelegramAuth(
            Number(args.telegramUserId),
            `official_${args.telegramUserId}`,
            OFFICIAL_BOT_TOKEN,
          ),
        },
      }),
      [200],
    );
  }

  async function connectedCustomBotIds(args: {
    readonly orgId: string;
    readonly userId: string;
  }): Promise<string[]> {
    mockTelegramGetMe();
    mocks.clerk.session(args.userId, args.orgId, "org:member");
    const response = await accept(
      client().list({ headers: AUTH_HEADERS }),
      [200],
    );
    return response.body.bots
      .filter((bot) => {
        return bot.id !== OFFICIAL_TELEGRAM_BOT_ID && bot.isConnected;
      })
      .map((bot) => {
        return bot.id;
      })
      .sort();
  }

  async function expectCustomBotHidden(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly botId: string;
  }): Promise<void> {
    mockTelegramGetMe();
    mocks.clerk.session(args.userId, args.orgId, "org:member");
    const list = await accept(client().list({ headers: AUTH_HEADERS }), [200]);
    expect(list.body.bots).not.toContainEqual(
      expect.objectContaining({ id: args.botId }),
    );
  }

  async function expectLinkStatus(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly botId: string;
    readonly linked: boolean;
  }): Promise<void> {
    configureOfficialBotEnv();
    mockTelegramGetMe();
    mocks.clerk.session(args.userId, args.orgId, "org:member");
    const response = await accept(
      client().getLinkStatus({
        query: { botId: args.botId },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    expect(response.body.linked).toBe(args.linked);
  }

  describe("DELETE /api/integrations/telegram/:botId", () => {
    it("returns 401 when unauthenticated", async () => {
      const response = await accept(
        client().disconnect({
          params: { botId: newId("bot") },
          headers: {},
        }),
        [401],
      );

      expect(response.body).toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });

    it("returns 404 for an unknown bot", async () => {
      mocks.clerk.session(newId("user"), newId("org"), "org:admin");

      const response = await accept(
        client().disconnect({
          params: { botId: newId("missing-bot") },
          headers: AUTH_HEADERS,
        }),
        [404],
      );

      expect(response.body).toStrictEqual({
        error: { message: "Telegram bot not found", code: "NOT_FOUND" },
      });
    });

    it("returns 404 for a bot in another org", async () => {
      const bot = await seedBot();
      mocks.clerk.session(bot.ownerUserId, newId("other-org"), "org:admin");

      const response = await accept(
        client().disconnect({
          params: { botId: bot.botId },
          headers: AUTH_HEADERS,
        }),
        [404],
      );

      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    it("deletes the installation for the owner and removes the webhook", async () => {
      const bot = await seedBot();
      mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

      const response = await client().disconnect({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledTimes(1);
      expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledWith(
        botTokenFor(bot.botId),
      );
      await expectCustomBotHidden({
        orgId: bot.orgId,
        userId: bot.ownerUserId,
        botId: bot.botId,
      });
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        "telegram:changed",
        null,
      );
    });

    it("deletes the installation for an org admin", async () => {
      const bot = await seedBot({ ownerUserId: newId("owner") });
      const adminUserId = newId("admin");
      mocks.clerk.session(adminUserId, bot.orgId, "org:admin");

      const response = await client().disconnect({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledTimes(1);
      await expectCustomBotHidden({
        orgId: bot.orgId,
        userId: adminUserId,
        botId: bot.botId,
      });
    });

    it("deletes the installation when webhook removal fails", async () => {
      const bot = await seedBot();
      mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:admin");
      context.mocks.telegram.deleteWebhook.mockRejectedValueOnce(
        new Error("Telegram unavailable"),
      );

      const response = await client().disconnect({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      expect(context.mocks.telegram.deleteWebhook).toHaveBeenCalledTimes(1);
      await expectCustomBotHidden({
        orgId: bot.orgId,
        userId: bot.ownerUserId,
        botId: bot.botId,
      });
    });

    it("removes the disconnected bot from external bot and link status", async () => {
      const bot = await seedBot();
      await linkCustomBot({
        bot,
        userId: bot.ownerUserId,
        telegramUserId: "99077",
      });
      await expectLinkStatus({
        orgId: bot.orgId,
        userId: bot.ownerUserId,
        botId: bot.botId,
        linked: true,
      });
      mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:admin");

      const response = await client().disconnect({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      await expectCustomBotHidden({
        orgId: bot.orgId,
        userId: bot.ownerUserId,
        botId: bot.botId,
      });
      await expectLinkStatus({
        orgId: bot.orgId,
        userId: bot.ownerUserId,
        botId: bot.botId,
        linked: false,
      });
    });
  });

  describe("DELETE /api/integrations/telegram/link", () => {
    it("returns 401 when unauthenticated", async () => {
      const response = await accept(
        client().unlink({ query: {}, headers: {} }),
        [401],
      );

      expect(response.body).toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });

    it("returns 404 when the user has no link", async () => {
      mocks.clerk.session(newId("user"), newId("org"), "org:member");

      const response = await accept(
        client().unlink({ query: {}, headers: AUTH_HEADERS }),
        [404],
      );

      expect(response.body).toStrictEqual({
        error: { message: "No linked Telegram account", code: "NOT_FOUND" },
      });
    });

    it("deletes the user's custom bot link", async () => {
      const bot = await seedBot();
      await linkCustomBot({
        bot,
        userId: bot.ownerUserId,
        telegramUserId: "99001",
      });
      mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

      const response = await client().unlink({
        query: {},
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      await expect(
        connectedCustomBotIds({
          orgId: bot.orgId,
          userId: bot.ownerUserId,
        }),
      ).resolves.toStrictEqual([]);
      await expectLinkStatus({
        orgId: bot.orgId,
        userId: bot.ownerUserId,
        botId: bot.botId,
        linked: false,
      });
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        "telegram:changed",
        null,
      );
    });

    it("deletes only the requested custom bot link when botId is provided", async () => {
      const orgId = newId("org");
      const userId = newId("user");
      const firstBot = await seedBot({ orgId, ownerUserId: userId });
      const secondBot = await seedBot({ orgId, ownerUserId: userId });
      await linkCustomBot({
        bot: firstBot,
        userId,
        telegramUserId: "99011",
      });
      await linkCustomBot({
        bot: secondBot,
        userId,
        telegramUserId: "99012",
      });
      mocks.clerk.session(userId, orgId, "org:member");

      const response = await client().unlink({
        query: { botId: firstBot.botId },
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      await expect(
        connectedCustomBotIds({ orgId, userId }),
      ).resolves.toStrictEqual([secondBot.botId]);
      await expectLinkStatus({
        orgId,
        userId,
        botId: firstBot.botId,
        linked: false,
      });
      await expectLinkStatus({
        orgId,
        userId,
        botId: secondBot.botId,
        linked: true,
      });
    });

    it("deletes only the official link when botId is official", async () => {
      const bot = await seedBot();
      await linkOfficialBot({
        orgId: bot.orgId,
        userId: bot.ownerUserId,
        telegramUserId: "99090",
      });
      await linkCustomBot({
        bot,
        userId: bot.ownerUserId,
        telegramUserId: "99091",
      });
      mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

      const response = await client().unlink({
        query: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      await expectLinkStatus({
        orgId: bot.orgId,
        userId: bot.ownerUserId,
        botId: OFFICIAL_TELEGRAM_BOT_ID,
        linked: false,
      });
      await expect(
        connectedCustomBotIds({
          orgId: bot.orgId,
          userId: bot.ownerUserId,
        }),
      ).resolves.toStrictEqual([bot.botId]);
    });

    it("does not delete custom links from another org", async () => {
      const userId = newId("user");
      const activeBot = await seedBot({ ownerUserId: userId });
      const otherBot = await seedBot({ ownerUserId: userId });
      await linkCustomBot({
        bot: activeBot,
        userId,
        telegramUserId: "99101",
      });
      await linkCustomBot({
        bot: otherBot,
        userId,
        telegramUserId: "99102",
      });
      mocks.clerk.session(userId, activeBot.orgId, "org:member");

      const response = await client().unlink({
        query: {},
        headers: AUTH_HEADERS,
      });

      expect(response.status).toBe(204);
      await expect(
        connectedCustomBotIds({ orgId: activeBot.orgId, userId }),
      ).resolves.toStrictEqual([]);
      await expect(
        connectedCustomBotIds({ orgId: otherBot.orgId, userId }),
      ).resolves.toStrictEqual([otherBot.botId]);
    });
  });
});
