import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  type TelegramBot,
  integrationsTelegramContract,
} from "@okouai/api-contracts/contracts/integrations-telegram";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  deleteTelegramFixture$,
  seedTelegramInstallation$,
  type TelegramFixture,
} from "./helpers/telegram";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import { server } from "../../../mocks/server";
import { integrationsTelegramRoutes } from "../integrations-telegram";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const AUTH_HEADERS = { authorization: "Bearer clerk-session" } as const;

interface MutableTelegramFixture {
  readonly orgId: string;
  readonly composeIds: string[];
  readonly telegramBotIds: string[];
  readonly userIds: string[];
}

interface SeededBot {
  readonly botId: string;
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly composeId: string;
  readonly fixture: MutableTelegramFixture;
}

describe("PATCH /api/integrations/telegram/:botId", () => {
  const fixtures: MutableTelegramFixture[] = [];

  beforeEach(() => {
    context.mocks.telegram.getMe.mockResolvedValue({
      id: 1,
      is_bot: true,
      first_name: "Bot",
      username: "x",
    });
    server.use(
      http.head("https://oauth.telegram.org/auth", () => {
        return new HttpResponse(null, { status: 200 });
      }),
    );
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(
          deleteTelegramFixture$,
          fixture satisfies TelegramFixture,
          context.signal,
        );
      }
    }
  });

  function client() {
    return setupApp({ context, routes: integrationsTelegramRoutes })(
      integrationsTelegramContract,
    );
  }

  function newId(prefix: string): string {
    return `${prefix}_${randomUUID().slice(0, 8)}`;
  }

  function newTelegramBotId(): string {
    return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
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
    const installation = await store.set(
      seedTelegramInstallation$,
      { orgId, ownerUserId, telegramBotId: botId },
      context.signal,
    );
    const fixture: MutableTelegramFixture = {
      orgId,
      composeIds: [installation.composeId],
      telegramBotIds: [botId],
      userIds: [ownerUserId],
    };
    fixtures.push(fixture);
    return {
      botId,
      orgId,
      ownerUserId,
      composeId: installation.composeId,
      fixture,
    };
  }

  async function seedCompose(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly trackWith?: MutableTelegramFixture;
  }): Promise<{ readonly composeId: string }> {
    const actor: ApiTestUser = {
      userId: args.userId,
      orgId: args.orgId,
      orgRole: "org:admin",
      email: `${args.userId}@example.test`,
    };
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: newId("agent"),
      visibility: "private",
    });

    if (args.trackWith) {
      args.trackWith.composeIds.push(agent.agentId);
    } else {
      fixtures.push({
        orgId: args.orgId,
        composeIds: [agent.agentId],
        telegramBotIds: [],
        userIds: [args.userId],
      });
    }

    return { composeId: agent.agentId };
  }

  function expectAgentSummary(
    agent: TelegramBot["agent"],
    agentId: string,
  ): NonNullable<TelegramBot["agent"]> {
    expect(agent).toStrictEqual({ id: agentId, name: expect.any(String) });
    if (!agent) {
      throw new Error(`Expected Telegram bot agent ${agentId}`);
    }
    return agent;
  }

  async function readBot(botId: string): Promise<TelegramBot> {
    const response = await accept(
      client().list({ headers: AUTH_HEADERS }),
      [200],
    );
    const bot = response.body.bots.find((item) => {
      return item.id === botId;
    });
    expect(bot).toBeDefined();
    if (!bot) {
      throw new Error(`Expected Telegram bot ${botId}`);
    }
    return bot;
  }

  async function expectBotAgent(args: {
    readonly botId: string;
    readonly agentId: string;
    readonly agentName: string;
  }): Promise<void> {
    const bot = await readBot(args.botId);
    expect(bot.agent).toStrictEqual({
      id: args.agentId,
      name: args.agentName,
    });
  }

  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      client().updateBot({
        params: { botId: newTelegramBotId() },
        headers: {},
        body: { defaultAgentId: newId("agent") },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 when defaultAgentId is missing for a custom bot", async () => {
    const bot = await seedBot();
    mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: {},
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { message: "defaultAgentId is required", code: "BAD_REQUEST" },
    });
  });

  it("updates the default agent for an org admin", async () => {
    const bot = await seedBot({ ownerUserId: newId("owner") });
    const adminUserId = newId("admin");
    const nextAgent = await seedCompose({
      orgId: bot.orgId,
      userId: adminUserId,
      trackWith: bot.fixture,
    });
    mocks.clerk.session(adminUserId, bot.orgId, "org:admin");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: nextAgent.composeId },
      }),
      [200],
    );

    const agent = expectAgentSummary(response.body.agent, nextAgent.composeId);
    expect(response.body.id).toBe(bot.botId);
    expect(response.body.isOwner).toBeFalsy();
    await expectBotAgent({
      botId: bot.botId,
      agentId: nextAgent.composeId,
      agentName: agent.name,
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "telegram:changed",
      null,
    );
  });

  it("updates the default agent for the owner", async () => {
    const bot = await seedBot();
    const nextAgent = await seedCompose({
      orgId: bot.orgId,
      userId: bot.ownerUserId,
      trackWith: bot.fixture,
    });
    mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: nextAgent.composeId },
      }),
      [200],
    );

    const agent = expectAgentSummary(response.body.agent, nextAgent.composeId);
    expect(response.body.isOwner).toBeTruthy();
    await expectBotAgent({
      botId: bot.botId,
      agentId: nextAgent.composeId,
      agentName: agent.name,
    });
  });

  it("returns 403 when defaultAgentId belongs to another org", async () => {
    const bot = await seedBot();
    const otherOrgAgent = await seedCompose({
      orgId: newId("org"),
      userId: bot.ownerUserId,
    });
    mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: otherOrgAgent.composeId },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Telegram bots can only be connected to agents in the bot's organization",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 404 when the custom bot is not visible in the active org", async () => {
    const bot = await seedBot();
    const otherOrgId = newId("org");
    const otherOrgAgent = await seedCompose({
      orgId: otherOrgId,
      userId: bot.ownerUserId,
    });
    mocks.clerk.session(bot.ownerUserId, otherOrgId, "org:admin");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: otherOrgAgent.composeId },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");
    await expectBotAgent({
      botId: bot.botId,
      agentId: bot.composeId,
      agentName: `agent-${bot.composeId.slice(0, 8)}`,
    });
  });

  it("returns 404 when the custom bot default agent is missing", async () => {
    const bot = await seedBot();
    mocks.clerk.session(bot.ownerUserId, bot.orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: bot.botId },
        headers: AUTH_HEADERS,
        body: { defaultAgentId: randomUUID() },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
  });

  it("updates the official bot agent preference for the current user and org", async () => {
    const orgId = newId("org");
    const userId = newId("user");
    const selectedAgent = await seedCompose({ orgId, userId });
    mocks.clerk.session(userId, orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: selectedAgent.composeId },
      }),
      [200],
    );

    const agent = expectAgentSummary(
      response.body.agent,
      selectedAgent.composeId,
    );
    expect(response.body.official?.usesDefaultAgent).toBeFalsy();
    const bot = await readBot(OFFICIAL_TELEGRAM_BOT_ID);
    expect(bot.agent).toStrictEqual(agent);
    expect(bot.official?.usesDefaultAgent).toBeFalsy();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "telegram:changed",
      null,
    );
  });

  it("clears the official bot agent preference when selectedAgentId is null", async () => {
    const orgId = newId("org");
    const userId = newId("user");
    const selectedAgent = await seedCompose({ orgId, userId });
    mocks.clerk.session(userId, orgId, "org:member");

    await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: selectedAgent.composeId },
      }),
      [200],
    );

    const response = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: null },
      }),
      [200],
    );

    expect(response.body.official?.usesDefaultAgent).toBeTruthy();
    expect(response.body.agent).toBeNull();
    const bot = await readBot(OFFICIAL_TELEGRAM_BOT_ID);
    expect(bot.agent).toBeNull();
    expect(bot.official?.usesDefaultAgent).toBeTruthy();
  });

  it("returns 400 when selectedAgentId is missing for the official bot", async () => {
    mocks.clerk.session(newId("user"), newId("org"), "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: {},
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { message: "selectedAgentId is required", code: "BAD_REQUEST" },
    });
  });

  it("returns 404 when the official bot selected agent is missing", async () => {
    mocks.clerk.session(newId("user"), newId("org"), "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: randomUUID() },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
  });

  it("returns 403 when the official bot selected agent belongs to another org", async () => {
    const orgId = newId("org");
    const userId = newId("user");
    const otherOrgAgent = await seedCompose({
      orgId: newId("org"),
      userId,
    });
    mocks.clerk.session(userId, orgId, "org:member");

    const response = await accept(
      client().updateBot({
        params: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        headers: AUTH_HEADERS,
        body: { selectedAgentId: otherOrgAgent.composeId },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Telegram official bot preferences can only use agents in the active organization",
        code: "FORBIDDEN",
      },
    });
  });
});
