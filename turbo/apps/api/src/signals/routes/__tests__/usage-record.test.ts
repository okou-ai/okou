import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { mapsContract } from "@okouai/api-contracts/contracts/maps";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  seedUsagePricingRows,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import {
  materializeHourlyUsage$,
  readUsageStorageCounts$,
  seedRun$,
} from "./helpers/usage-state";
import { mapsRoutes } from "../maps";
import { usageRecordRoutes } from "../usage-record";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const billing = createBillingMediaApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatApi = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const mocks = createRouteMocks(context);
const store = createStore();

/*
 * Finalized period membership follows settlement time. Database insertion time
 * remains independent from the application clock used by inline managed
 * settlement and the pending-usage processing endpoint.
 */

const DAY_MS = 86_400_000;
const GOOGLE_GEOCODING_URL =
  "https://maps.googleapis.com/maps/api/geocode/json";
const MAPS_GEOCODING_PRICING_ROWS = [
  {
    kind: "maps",
    provider: "google-maps",
    category: "geocoding",
    unitPrice: 6,
    unitSize: 1,
  },
] as const satisfies readonly UsagePricingRow[];
const MODEL_TOKEN_CATEGORIES = {
  input: "tokens.input",
  output: "tokens.output",
  inputLongContext: "tokens.input.long_context",
  outputLongContext: "tokens.output.long_context",
  cacheReadLongContext: "tokens.cache_read.long_context",
  cacheCreationLongContext: "tokens.cache_creation.long_context",
  inputLongContextFast: "tokens.input.long_context.fast",
  outputLongContextFast: "tokens.output.long_context.fast",
  cacheReadLongContextFast: "tokens.cache_read.long_context.fast",
  cacheCreationLongContextFast: "tokens.cache_creation.long_context.fast",
} as const;

interface ModelTokenCounts {
  readonly input?: number;
  readonly output?: number;
  readonly inputLongContext?: number;
  readonly outputLongContext?: number;
  readonly cacheReadLongContext?: number;
  readonly cacheCreationLongContext?: number;
  readonly inputLongContextFast?: number;
  readonly outputLongContextFast?: number;
  readonly cacheReadLongContextFast?: number;
  readonly cacheCreationLongContextFast?: number;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context, routes: usageRecordRoutes })(usageRecordContract);
}

function createdAt(minutesAgo: number): Date {
  return new Date(nowDate().getTime() - minutesAgo * 60 * 1000);
}

interface UsageRecordActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
}

async function entitledRecordActor(): Promise<UsageRecordActor> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.disableVapid();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Usage record agent",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId };
}

/**
 * Creates a titled chat thread and sends one message through the product chat
 * API, producing a web-triggered run linked to the thread. Without runner
 * infrastructure the run settles into a terminal status on creation; usage
 * reads only depend on the run row and its usage events.
 */
async function createChatThreadRun(
  fixture: UsageRecordActor,
  args: {
    readonly title: string;
    readonly createdAt?: Date;
    readonly threadId?: string;
  },
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const threadId =
    args.threadId ??
    (
      await chatApi.createThread(fixture.actor, {
        agentId: fixture.agentId,
        title: args.title,
      })
    ).id;
  if (args.createdAt) {
    mockNow(args.createdAt);
  }
  const sent = await chatApi.requestSendEvent(
    fixture.actor,
    { agentId: fixture.agentId, prompt: "record usage", threadId },
    [201],
  );
  if (args.createdAt) {
    clearMockNow();
  }
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  return { runId: sent.body.runId, threadId };
}

/**
 * Creates an unthreaded run whose compose declares an inline framework API
 * key. Such runs skip model-provider resolution (agent_runs.model_provider
 * stays NULL), so the sandbox usage-event webhook accepts their model-kind
 * events into the billing ledger.
 */
async function createUnthreadedRun(
  actor: ApiTestUser,
  args: {
    readonly prompt: string;
    readonly triggerSource: TriggerSource;
    readonly createdAt?: Date;
  },
): Promise<{ readonly runId: string }> {
  const name = `bdd-usage-record-${randomUUID().slice(0, 8)}`;
  const compose = await api.createDirectAgent(actor, {
    version: "1.0",
    agents: {
      [name]: {
        framework: "claude-code",
        environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
      },
    },
  });
  if (args.triggerSource === "goal") {
    if (!actor.orgId) {
      throw new Error("Historical Goal usage requires an org-scoped actor");
    }
    // Goal history remains billable/readable after its runtime writer retires.
    return await store.set(
      seedRun$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        composeId: compose.agentId,
        prompt: args.prompt,
        triggerSource: "goal",
        status: "completed",
        completedAt: nowDate(),
        createdAt: args.createdAt,
      },
      context.signal,
    );
  }
  if (args.createdAt) {
    mockNow(args.createdAt);
  }
  const run = await api.createDirectRun(actor, {
    agentId: compose.agentId,
    prompt: args.prompt,
    triggerSource: args.triggerSource,
  });
  if (args.createdAt) {
    clearMockNow();
  }
  return { runId: run.runId };
}

// Unit prices are chosen so cron-computed credits stay readable:
// connector events charge 10 credits per unit, image events 30 per unit,
// model token events 1 credit per token.
async function seedModelPricing(model: string): Promise<void> {
  await seedUsagePricingRows(
    Object.values(MODEL_TOKEN_CATEGORIES).map((category) => {
      return {
        kind: "model",
        provider: model,
        category,
        unitPrice: 1,
        unitSize: 1,
      };
    }),
  );
}

async function seedConnectorPricing(provider: string): Promise<void> {
  await seedUsagePricingRows([
    {
      kind: "connector",
      provider,
      category: "api_request",
      unitPrice: 10,
      unitSize: 1,
    },
  ]);
}

async function seedImagePricing(provider: string): Promise<void> {
  await seedUsagePricingRows([
    {
      kind: "image",
      provider,
      category: "output_image",
      unitPrice: 30,
      unitSize: 1,
    },
  ]);
}

function sandboxHeaders(actor: ApiTestUser, runId: string) {
  return { authorization: `Bearer ${api.sandboxTokenForRun(actor, runId)}` };
}

async function recordConnectorUsage(
  actor: ApiTestUser,
  runId: string,
  provider: string,
  quantity: number,
): Promise<void> {
  await webhooks.requestAgentUsageEvent(
    {
      runId,
      events: [
        {
          idempotencyKey: randomUUID(),
          kind: "connector",
          provider,
          category: "api_request",
          quantity,
        },
      ],
    },
    sandboxHeaders(actor, runId),
    [200],
  );
}

async function recordImageUsage(
  actor: ApiTestUser,
  runId: string,
  provider: string,
  quantity: number,
): Promise<void> {
  await webhooks.requestAgentUsageEvent(
    {
      runId,
      events: [
        {
          idempotencyKey: randomUUID(),
          kind: "image",
          provider,
          category: "output_image",
          quantity,
        },
      ],
    },
    sandboxHeaders(actor, runId),
    [200],
  );
}

async function recordModelUsage(
  actor: ApiTestUser,
  runId: string,
  model: string,
  tokens: ModelTokenCounts,
): Promise<void> {
  const events = (
    Object.keys(MODEL_TOKEN_CATEGORIES) as (keyof ModelTokenCounts)[]
  ).flatMap((key) => {
    const quantity = tokens[key];
    if (!quantity) {
      return [];
    }
    return [
      {
        idempotencyKey: randomUUID(),
        kind: "model" as const,
        provider: model,
        category: MODEL_TOKEN_CATEGORIES[key],
        quantity,
      },
    ];
  });
  await webhooks.requestAgentUsageEvent(
    { runId, events },
    sandboxHeaders(actor, runId),
    [200],
  );
}

function uniqueProvider(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

describe("GET /api/usage/record", () => {
  afterEach(() => {
    clearMockNow();
  });

  it("returns 401 when not authenticated", async () => {
    const response = await accept(
      apiClient().get({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 for invalid timezone values", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: { tz: "Not/A/Timezone" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid timezone: Not/A/Timezone",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 403 when team usage records are requested", async () => {
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:admin",
    );

    const response = await accept(
      apiClient().get({
        query: { scope: "team", range: "7d", tz: "UTC" },
        headers: authHeaders(),
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Team usage records are aggregated by member",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns rows across sources ordered by recent activity", async () => {
    const fixture = await entitledRecordActor();
    const model = uniqueProvider("bdd-model");
    const connectorProvider = uniqueProvider("bdd-connector");
    await seedModelPricing(model);
    await seedConnectorPricing(connectorProvider);

    const older = await createChatThreadRun(fixture, {
      title: "Older chat",
      createdAt: createdAt(120),
    });
    await recordConnectorUsage(
      fixture.actor,
      older.runId,
      connectorProvider,
      8,
    );

    // Unthreaded Slack run — one row per run, links via runId.
    const slack = await createUnthreadedRun(fixture.actor, {
      prompt: "Slack triage",
      triggerSource: "slack",
      createdAt: createdAt(60),
    });
    await recordModelUsage(fixture.actor, slack.runId, model, {
      input: 30,
      output: 20,
    });

    const newer = await createChatThreadRun(fixture, {
      title: "Newer chat",
      createdAt: createdAt(5),
    });
    await recordConnectorUsage(
      fixture.actor,
      newer.runId,
      connectorProvider,
      25,
    );

    await billing.processOrgUsageEvents(fixture.actor);
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.rows).toHaveLength(3);
    expect(response.body.pagination.total).toBe(3);
    // Range-wide credit total across all three rows (250 + 50 + 80).
    expect(response.body.totalCredits).toBe(380);
    expect(response.body.period).not.toBeNull();

    expect(response.body.rows[0]?.source).toBe("chat");
    expect(response.body.rows[0]?.threadId).toBe(newer.threadId);
    expect(response.body.rows[0]?.runId).toBeNull();
    expect(response.body.rows[0]?.title).toBe("Newer chat");
    expect(response.body.rows[0]?.credits).toBe(250);
    expect(response.body.rows[0]?.tokens).toBe(0);
    expect(response.body.rows[0]?.breakdown).toStrictEqual([
      {
        kind: "connector",
        credits: 250,
        providers: [
          {
            provider: connectorProvider,
            credits: 250,
            usageKinds: [{ kind: "connector", credits: 250 }],
          },
        ],
      },
    ]);
    expect(response.body.rows[0]?.member).toBeNull();

    expect(response.body.rows[1]?.source).toBe("slack");
    expect(response.body.rows[1]?.threadId).toBeNull();
    expect(response.body.rows[1]?.runId).toBe(slack.runId);
    expect(response.body.rows[1]?.title).toBe("Slack triage");
    expect(response.body.rows[1]?.credits).toBe(50);
    expect(response.body.rows[1]?.tokens).toBe(50);
    expect(response.body.rows[1]?.breakdown).toStrictEqual([
      {
        kind: "model",
        credits: 50,
        providers: [
          {
            provider: model,
            credits: 50,
            usageKinds: [{ kind: "model", credits: 50 }],
          },
        ],
      },
    ]);

    expect(response.body.rows[2]?.source).toBe("chat");
    expect(response.body.rows[2]?.threadId).toBe(older.threadId);
    expect(response.body.rows[2]?.credits).toBe(80);
  });

  it("returns rows, totals, tokens, and breakdowns from hourly storage", async () => {
    const fixture = await entitledRecordActor();
    if (!fixture.actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    const model = uniqueProvider("hourly-model");
    const connectorProvider = uniqueProvider("hourly-connector");
    await seedModelPricing(model);
    await seedConnectorPricing(connectorProvider);
    const run = await createUnthreadedRun(fixture.actor, {
      prompt: "Hourly usage record",
      triggerSource: "slack",
    });
    await recordModelUsage(fixture.actor, run.runId, model, { input: 50 });
    await recordConnectorUsage(fixture.actor, run.runId, connectorProvider, 2);
    await billing.processOrgUsageEvents(fixture.actor);
    await expect(
      store.set(
        materializeHourlyUsage$,
        {
          orgId: fixture.actor.orgId,
          userId: fixture.actor.userId,
          runId: run.runId,
        },
        context.signal,
      ),
    ).resolves.toBe(2);
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "user", id: fixture.actor.userId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 0, hourly: 2 });

    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
    const response = await accept(
      apiClient().get({
        query: { range: "today", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.totalCredits).toBe(70);
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.rows).toStrictEqual([
      expect.objectContaining({
        source: "slack",
        runId: run.runId,
        credits: 70,
        tokens: 50,
        breakdown: [
          {
            kind: "model",
            credits: 50,
            providers: [
              {
                provider: model,
                credits: 50,
                usageKinds: [{ kind: "model", credits: 50 }],
              },
            ],
          },
          {
            kind: "connector",
            credits: 20,
            providers: [
              {
                provider: connectorProvider,
                credits: 20,
                usageKinds: [{ kind: "connector", credits: 20 }],
              },
            ],
          },
        ],
      }),
    ]);
  });

  it("normalizes unattended sources without changing credits", async () => {
    const fixture = await entitledRecordActor();
    const connectorProvider = uniqueProvider("bdd-connector");
    await seedConnectorPricing(connectorProvider);

    const sources = [
      ["automation-schedule", 2],
      ["automation-event", 3],
      ["automation-schedule", 4],
      ["automation-event", 5],
      ["goal", 6],
    ] as const;
    for (const [triggerSource, quantity] of sources) {
      const run = await createUnthreadedRun(fixture.actor, {
        prompt: `${triggerSource} usage`,
        triggerSource,
      });
      await recordConnectorUsage(
        fixture.actor,
        run.runId,
        connectorProvider,
        quantity,
      );
    }

    await billing.processOrgUsageEvents(fixture.actor);
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({
        query: { source: "automation", range: "7d", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows).toHaveLength(1);
    expect(response.body.totalCredits).toBe(200);
    expect(response.body.rows[0]).toMatchObject({
      source: "automation",
      threadId: null,
      runId: null,
      credits: 200,
      tokens: 0,
    });
  });

  it("aggregates deleted chat threads into a synthetic usage row", async () => {
    const fixture = await entitledRecordActor();
    const connectorProvider = uniqueProvider("bdd-connector");
    const imageProvider = uniqueProvider("bdd-image");
    await seedConnectorPricing(connectorProvider);
    await seedImagePricing(imageProvider);

    const deletedOlder = await createChatThreadRun(fixture, {
      title: "Deleted older chat",
      createdAt: createdAt(50),
    });
    await recordConnectorUsage(
      fixture.actor,
      deletedOlder.runId,
      connectorProvider,
      2,
    );

    const current = await createChatThreadRun(fixture, {
      title: "Current chat",
      createdAt: createdAt(20),
    });
    await recordConnectorUsage(
      fixture.actor,
      current.runId,
      connectorProvider,
      4,
    );

    const deletedNewer = await createChatThreadRun(fixture, {
      title: "Deleted newer chat",
      createdAt: createdAt(10),
    });
    await recordConnectorUsage(
      fixture.actor,
      deletedNewer.runId,
      connectorProvider,
      8,
    );
    await recordImageUsage(fixture.actor, deletedNewer.runId, imageProvider, 1);

    await billing.processOrgUsageEvents(fixture.actor);
    await chatApi.deleteThread(fixture.actor, deletedOlder.threadId);
    await chatApi.deleteThread(fixture.actor, deletedNewer.threadId);

    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({
        query: { range: "7d", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows).toHaveLength(2);
    expect(response.body.pagination.total).toBe(2);
    expect(response.body.totalCredits).toBe(170);

    expect(response.body.rows[0]).toMatchObject({
      source: "chat",
      threadId: null,
      runId: null,
      title: "Deleted chats",
      credits: 130,
      tokens: 0,
    });
    expect(response.body.rows[0]?.breakdown).toStrictEqual([
      {
        kind: "image",
        credits: 30,
        providers: [
          {
            provider: imageProvider,
            credits: 30,
            usageKinds: [{ kind: "image", credits: 30 }],
          },
        ],
      },
      {
        kind: "connector",
        credits: 100,
        providers: [
          {
            provider: connectorProvider,
            credits: 100,
            usageKinds: [{ kind: "connector", credits: 100 }],
          },
        ],
      },
    ]);

    expect(response.body.rows[1]).toMatchObject({
      source: "chat",
      threadId: current.threadId,
      runId: null,
      title: "Current chat",
      credits: 40,
      tokens: 0,
    });
  });

  it("filters rows by source", async () => {
    const fixture = await entitledRecordActor();
    const connectorProvider = uniqueProvider("bdd-connector");
    await seedConnectorPricing(connectorProvider);

    const chat = await createChatThreadRun(fixture, {
      title: "A chat",
      createdAt: createdAt(20),
    });
    await recordConnectorUsage(fixture.actor, chat.runId, connectorProvider, 1);

    const slack = await createUnthreadedRun(fixture.actor, {
      prompt: "Slack digest",
      triggerSource: "slack",
      createdAt: createdAt(10),
    });
    await recordConnectorUsage(
      fixture.actor,
      slack.runId,
      connectorProvider,
      12,
    );

    await billing.processOrgUsageEvents(fixture.actor);
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const slackResponse = await accept(
      apiClient().get({
        query: { source: "slack" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(slackResponse.body.rows).toHaveLength(1);
    expect(slackResponse.body.pagination.total).toBe(1);
    expect(slackResponse.body.rows[0]?.source).toBe("slack");
    expect(slackResponse.body.rows[0]?.runId).toBe(slack.runId);
    expect(slackResponse.body.rows[0]?.credits).toBe(120);

    const chatResponse = await accept(
      apiClient().get({
        query: { source: "chat" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(chatResponse.body.rows).toHaveLength(1);
    expect(chatResponse.body.rows[0]?.source).toBe("chat");
    expect(chatResponse.body.rows[0]?.threadId).toBe(chat.threadId);
    expect(chatResponse.body.rows[0]?.credits).toBe(10);
  });

  it("normalizes non-passthrough trigger sources to other", async () => {
    const fixture = await entitledRecordActor();
    const model = uniqueProvider("bdd-model");
    await seedModelPricing(model);

    const webhookRun = await createUnthreadedRun(fixture.actor, {
      prompt: "Webhook triggered run",
      triggerSource: "webhook",
      createdAt: createdAt(10),
    });
    await recordModelUsage(fixture.actor, webhookRun.runId, model, {
      inputLongContextFast: 25,
      outputLongContextFast: 5,
      cacheReadLongContextFast: 7,
      cacheCreationLongContextFast: 3,
    });

    await billing.processOrgUsageEvents(fixture.actor);
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({
        query: { source: "other" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows).toHaveLength(1);
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.rows[0]).toMatchObject({
      source: "other",
      threadId: null,
      runId: webhookRun.runId,
      title: "Webhook triggered run",
      credits: 40,
      tokens: 40,
    });
  });

  it("paginates by page size", async () => {
    const fixture = await entitledRecordActor();
    const connectorProvider = uniqueProvider("bdd-connector");
    await seedConnectorPricing(connectorProvider);
    const tiedCreatedAt = createdAt(10);
    const threadIds: string[] = [];

    for (const title of ["Chat A", "Chat B", "Chat C"]) {
      const chat = await createChatThreadRun(fixture, {
        title,
        createdAt: tiedCreatedAt,
      });
      threadIds.push(chat.threadId);
      await recordConnectorUsage(
        fixture.actor,
        chat.runId,
        connectorProvider,
        1,
      );
    }

    await billing.processOrgUsageEvents(fixture.actor);
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({
        query: { page: 1, pageSize: 2 },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows).toHaveLength(2);
    expect(response.body.pagination.total).toBe(3);
    const expectedThreadIds = [...threadIds].sort();
    expect(
      response.body.rows.map((row) => {
        return row.threadId;
      }),
    ).toStrictEqual(expectedThreadIds.slice(0, 2));

    const secondPage = await accept(
      apiClient().get({
        query: { page: 2, pageSize: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(secondPage.body.rows).toHaveLength(1);
    expect(secondPage.body.rows[0]?.threadId).toBe(expectedThreadIds[2]);

    const emptyPage = await accept(
      apiClient().get({
        query: { page: 3, pageSize: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(emptyPage.body.rows).toStrictEqual([]);
    expect(emptyPage.body.pagination.total).toBe(3);
    expect(emptyPage.body.totalCredits).toBe(30);
  });

  it("returns kind and provider breakdowns for each usage row", async () => {
    const fixture = await entitledRecordActor();
    const model = uniqueProvider("bdd-model");
    const connectorProvider = uniqueProvider("bdd-connector");
    const imageProvider = uniqueProvider("bdd-image");
    await seedModelPricing(model);
    await seedConnectorPricing(connectorProvider);
    await seedImagePricing(imageProvider);

    const run = await createUnthreadedRun(fixture.actor, {
      prompt: "Mixed media run",
      triggerSource: "test",
      createdAt: createdAt(5),
    });
    await recordModelUsage(fixture.actor, run.runId, model, {
      input: 100,
      output: 50,
    });
    await recordImageUsage(fixture.actor, run.runId, imageProvider, 4);
    await recordConnectorUsage(fixture.actor, run.runId, connectorProvider, 2);

    await billing.processOrgUsageEvents(fixture.actor);
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({
        query: { range: "7d", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows[0]?.credits).toBe(290);
    expect(response.body.rows[0]?.breakdown).toStrictEqual([
      {
        kind: "model",
        credits: 150,
        providers: [
          {
            provider: model,
            credits: 150,
            usageKinds: [{ kind: "model", credits: 150 }],
          },
        ],
      },
      {
        kind: "image",
        credits: 120,
        providers: [
          {
            provider: imageProvider,
            credits: 120,
            usageKinds: [{ kind: "image", credits: 120 }],
          },
        ],
      },
      {
        kind: "connector",
        credits: 20,
        providers: [
          {
            provider: connectorProvider,
            credits: 20,
            usageKinds: [{ kind: "connector", credits: 20 }],
          },
        ],
      },
    ]);
  });

  it("uses settlement time consistently for rows, totals, and breakdowns", async () => {
    const fixture = await entitledRecordActor();
    billing.configureMapsProvider();
    const pricing = await createUsagePricingFixture({
      configured: MAPS_GEOCODING_PRICING_ROWS,
    });
    onTestFinished(pricing.cleanup);
    server.use(
      http.get(GOOGLE_GEOCODING_URL, () => {
        return HttpResponse.json({
          status: "OK",
          results: [
            {
              formatted_address: "1 Infinite Loop, Cupertino, CA",
              geometry: { location: { lat: 37.3317, lng: -122.0301 } },
            },
          ],
        });
      }),
    );

    const run = await createUnthreadedRun(fixture.actor, {
      prompt: "Settlement boundary usage",
      triggerSource: "test",
    });
    const settledAt = new Date(nowDate().getTime() + 8 * DAY_MS);
    mockNow(settledAt);
    const mapsToken = api.okouTokenForRunWithCapabilities(
      fixture.actor,
      run.runId,
      ["maps:read"],
    );
    const maps = setupApp({
      context,
      routes: mapsRoutes,
      usagePricingResolution: pricing.resolution,
    })(mapsContract);
    const geocode = await accept(
      maps.geocode({
        headers: { authorization: `Bearer ${mapsToken}` },
        body: { address: "1 Infinite Loop, Cupertino" },
      }),
      [200],
    );
    expect(geocode.body.creditsCharged).toBe(6);

    mockNow(new Date(settledAt.getTime() + 60_000));
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);

    const response = await accept(
      apiClient().get({
        query: { range: "7d", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows).toHaveLength(1);
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.totalCredits).toBe(6);
    expect(response.body.rows[0]).toMatchObject({
      source: "other",
      runId: run.runId,
      credits: 6,
      tokens: 0,
    });
    expect(response.body.rows[0]?.breakdown).toStrictEqual([
      {
        kind: "other",
        credits: 6,
        providers: [
          {
            provider: "google-maps",
            credits: 6,
            usageKinds: [{ kind: "maps", credits: 6 }],
          },
        ],
      },
    ]);
  });

  it("returns an empty null-period response for free billing period usage", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: { range: "billingPeriod", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      period: null,
      rows: [],
      totalCredits: 0,
      pagination: { page: 1, pageSize: 20, total: 0 },
    });
  });
});
