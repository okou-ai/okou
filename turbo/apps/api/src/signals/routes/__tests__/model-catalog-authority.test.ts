import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import type {
  OrgModelPolicy,
  UpdateOrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { modelCatalogRoutes } from "../model-catalog";
import { modelPoliciesRoutes } from "../model-policies";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { randomUUID } from "node:crypto";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import {
  deleteUsagePricingRows,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { usageRecordRoutes } from "../usage-record";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  insertCatalogModelFixture,
  updateBuiltInRouteFixture,
  updateBuiltInRoutePricingProviderFixture,
} from "../../../test-fixtures/model-catalog";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { ensureCustomModelModeForTest } from "./helpers/org-model-policy-write";

const context = testContext();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const chatEvents = createChatEventsFixture(context);
const runReads = createRunReadsApi(context);
const webhooks = createWebhookCallbackApi(context);
const billing = createBillingMediaApi(context);
function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function catalogApi() {
  return setupApp({ context, routes: modelCatalogRoutes })(
    modelCatalogContract,
  );
}

function policiesApi() {
  return setupApp({ context, routes: modelPoliciesRoutes })(
    modelPoliciesMainContract,
  );
}

const BASE_TOKEN_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
] as const;

/** Seed test-owned model pricing rows and delete them after the test. */
async function seedModelPricingFixture(
  provider: string,
  prices: Readonly<Record<string, number>>,
): Promise<void> {
  await seedUsagePricingRows(
    Object.entries(prices).map(([category, unitPrice]) => {
      return { kind: "model", provider, category, unitPrice, unitSize: 1 };
    }),
  );
  onTestFinished(async () => {
    await deleteUsagePricingRows({
      kind: "model",
      provider,
      categories: Object.keys(prices),
    });
  });
}

function uniformPrices(
  categories: readonly string[],
  unitPrice: number,
): Record<string, number> {
  return Object.fromEntries(
    categories.map((category) => {
      return [category, unitPrice];
    }),
  );
}

async function signInAdmin(): Promise<void> {
  const actor = authOrgApi.user();
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  await ensureCustomModelModeForTest(context, actor, authHeaders);
}

function builtIn(model: UpdateOrgModelPolicy["model"]): UpdateOrgModelPolicy {
  return {
    model,
    defaultProviderType: "built-in",
    credentialScope: "org",
    modelProviderId: null,
  };
}

async function listPolicies() {
  return (await accept(policiesApi().list({ headers: authHeaders() }), [200]))
    .body;
}

/** Only the system-default case's live route is outside its policy revision. */
function systemDefaultPolicyProjection(policy: OrgModelPolicy) {
  const { runtimeProviderType: _runtimeProviderType, ...projection } = policy;
  if (projection.memberEffective === undefined) {
    return projection;
  }
  const {
    availability: _availability,
    runtimeProviderType: _memberRuntimeProviderType,
    ...memberEffective
  } = projection.memberEffective;
  return { ...projection, memberEffective };
}

describe("model catalog authority", () => {
  it("exposes the database system default and display price tiers", async () => {
    await signInAdmin();
    const { body } = await accept(
      catalogApi().get({ headers: authHeaders() }),
      [200],
    );

    expect(body.systemDefaultModel).toBe("okou-1.0");
    expect(
      body.models.find((row) => {
        return row.model === "okou-1.0";
      })?.priceTier,
    ).toBe("$");
  });

  it("projects the system default policy without storing a per-organization row", async () => {
    await signInAdmin();
    const initial = await listPolicies();

    expect(initial.policies).toStrictEqual([
      expect.objectContaining({
        model: "okou-1.0",
        defaultProviderType: "built-in",
        credentialScope: "org",
      }),
    ]);

    // The default is projected rather than persisted. Empty PUT preserves its
    // complete policy projection and revision, not the live key/route/cooldown
    // facts behind the three runtime fields exercised by the owned model below.
    const written = await accept(
      policiesApi().update({
        headers: authHeaders(),
        body: { revision: initial.revision, policies: [] },
      }),
      [200],
    );
    expect(written.body.revision).toBe(initial.revision);
    expect(
      written.body.policies.map(systemDefaultPolicyProjection),
    ).toStrictEqual(initial.policies.map(systemDefaultPolicyProjection));
  });

  it("admits a new policy for an active catalog model", async () => {
    await signInAdmin();
    const { revision } = await listPolicies();

    const added = await accept(
      policiesApi().update({
        headers: authHeaders(),
        body: { revision, policies: [builtIn("claude-opus-5-5")] },
      }),
      [200],
    );
    expect(
      added.body.policies.map((policy) => {
        return policy.model;
      }),
    ).toStrictEqual(["okou-1.0", "claude-opus-5-5"]);
  });

  it("stores the final replacement for a legacy model preference", async () => {
    await signInAdmin();
    const { revision } = await listPolicies();
    await accept(
      policiesApi().update({
        headers: authHeaders(),
        body: { revision, policies: [builtIn("claude-fable-5-1")] },
      }),
      [200],
    );
    const preferences = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);

    const updated = await accept(
      preferences.update({
        headers: authHeaders(),
        body: { selectedModel: "claude-fable-5", serviceTier: null },
      }),
      [200],
    );
    expect(updated.body.selectedModel).toBe("claude-fable-5-1");
  });

  it("launches a new catalog model on a supported protocol from rows alone", async () => {
    const model = `catalog-launch-${randomUUID()}`;
    const restore = await insertCatalogModelFixture({
      model,
      displayName: "Catalog Launch",
      sortOrder: 100_000,
      builtInRoutes: [
        {
          concreteProviderType: "openrouter-codex",
          upstreamModel: "openai/catalog-launch",
          priority: 0,
          efforts: ["low", "high"],
          defaultEffort: "high",
        },
        {
          concreteProviderType: "openai-api-key",
          upstreamModel: "catalog-launch",
          priority: 1,
          efforts: ["low", "high"],
          defaultEffort: "high",
        },
      ],
    });
    onTestFinished(restore);
    await signInAdmin();
    await seedBuiltInModelCandidateKeys(context, model);
    const initial = await listPolicies();
    expect(initial.modelsAvailableToAdd).toContain(model);

    const added = await accept(
      policiesApi().update({
        headers: authHeaders(),
        body: { revision: initial.revision, policies: [builtIn(model)] },
      }),
      [200],
    );
    const launched = (body: typeof added.body) => {
      return body.policies.find((policy) => {
        return policy.model === model;
      });
    };
    expect(launched(added.body)).toMatchObject({
      model,
      defaultProviderType: "built-in",
      runtimeProviderType: "openrouter-codex",
    });
    expect(launched(added.body)?.memberEffective).toStrictEqual({
      providerType: "built-in",
      runtimeProviderType: "openrouter-codex",
      credentialScope: "org",
      availability: "available",
      accountSelection: "not_applicable",
    });

    // Disabling the first-priority candidate moves Built-in execution to the
    // next enabled route.
    await updateBuiltInRouteFixture({
      model,
      concreteProviderType: "openrouter-codex",
      enabled: false,
    });
    const nextCandidate = await listPolicies();
    expect(nextCandidate.revision).toBe(added.body.revision);
    expect(launched(nextCandidate)).toMatchObject({
      runtimeProviderType: "openai-api-key",
    });
    expect(launched(nextCandidate)?.memberEffective).toStrictEqual({
      providerType: "built-in",
      runtimeProviderType: "openai-api-key",
      credentialScope: "org",
      availability: "available",
      accountSelection: "not_applicable",
    });

    // This UUID-owned model has no other candidates or run/cooldown writers.
    // Its key leases remain held; only its own final enabled route is removed.
    await updateBuiltInRouteFixture({
      model,
      concreteProviderType: "openai-api-key",
      enabled: false,
    });
    const unavailable = await listPolicies();
    expect(unavailable.revision).toBe(added.body.revision);
    expect(launched(unavailable)?.runtimeProviderType).toBeNull();
    expect(launched(unavailable)?.memberEffective).toStrictEqual({
      providerType: "built-in",
      runtimeProviderType: null,
      credentialScope: "org",
      availability: "unavailable",
      accountSelection: "not_applicable",
    });
  });

  it("runs a new catalog model on an existing protocol from rows alone", async () => {
    const { actor, agentId, runnerGroup } =
      await chatEvents.entitledChatActor();
    // Only run_model_catalog and model_routes rows are inserted: the model is
    // in no static list and reuses the OpenAI API-key (Codex) protocol of the
    // existing GPT models. The upstream ID is a fixture value, so this
    // verifies protocol-level routing, not live provider acceptance.
    const model = `catalog-run-${randomUUID()}`;
    const upstreamModel = `catalog-run-upstream-${randomUUID()}`;
    const restore = await insertCatalogModelFixture({
      model,
      displayName: "Catalog Run",
      sortOrder: 100_000,
      builtInRoutes: [
        {
          concreteProviderType: "openai-api-key",
          upstreamModel,
          priority: 0,
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
          serviceTiers: ["priority"],
        },
      ],
    });
    onTestFinished(restore);
    await seedBuiltInModelCandidateKeys(context, model);
    await chatEvents.api.updateOrgModelPolicies(actor, [
      {
        model,
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const run = await chatEvents.sendChatRun(actor, {
      agentId,
      prompt: "run the new catalog model",
      model,
      runOptions: { reasoningEffort: "low", codexServiceTier: "fast" },
    });

    await expect(
      chatEvents.api.readRun(actor, run.runId),
    ).resolves.toMatchObject({
      source: {
        providerType: "built-in",
        runtimeProviderType: "openai-api-key",
        model,
      },
    });
    const { claim } = await chatEvents.claimChatRun(runnerGroup, run.runId);
    expect(claim).toMatchObject({
      cliAgentType: "codex",
      environment: { OPENAI_MODEL: upstreamModel },
      platformEnvironment: {
        OKOU_REASONING_EFFORT: "low",
        OKOU_CODEX_SERVICE_TIER: "fast",
      },
      billableFirewalls: ["model-provider:openai-api-key"],
      // Built-in usage is billed under the route's pricing link
      // (`usage_pricing` provider = the model ID).
      modelUsageProvider: model,
    });
  });
  it("bills a new catalog model through its route's usage_pricing link", async () => {
    const { actor, agentId, runnerGroup } =
      await chatEvents.entitledChatActor();
    // The route's pricing link names a usage_pricing provider that differs
    // from the model ID, so the charged amount can only come from the linked
    // rows. The upstream ID is a fixture value: this verifies protocol-level
    // routing and platform billing, not live provider acceptance.
    const model = `catalog-billed-${randomUUID()}`;
    const pricingProvider = `catalog-billed-pricing-${randomUUID()}`;
    const upstreamModel = `catalog-billed-upstream-${randomUUID()}`;
    const pricedCategories = {
      "tokens.input": 7,
      "tokens.output": 11,
      "tokens.cache_read": 3,
      "tokens.cache_creation": 5,
    } as const;
    await seedUsagePricingRows(
      Object.entries(pricedCategories).map(([category, unitPrice]) => {
        return {
          kind: "model",
          provider: pricingProvider,
          category,
          unitPrice,
          unitSize: 1,
        };
      }),
    );
    onTestFinished(async () => {
      await deleteUsagePricingRows({
        kind: "model",
        provider: pricingProvider,
        categories: Object.keys(pricedCategories),
      });
    });
    const restore = await insertCatalogModelFixture({
      model,
      displayName: "Catalog Billed",
      sortOrder: 100_000,
      builtInRoutes: [
        {
          concreteProviderType: "openai-api-key",
          upstreamModel,
          priority: 0,
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
          pricingProvider,
        },
      ],
    });
    onTestFinished(restore);
    await seedBuiltInModelCandidateKeys(context, model);
    await chatEvents.api.updateOrgModelPolicies(actor, [
      {
        model,
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const run = await chatEvents.sendChatRun(actor, {
      agentId,
      prompt: "bill the new catalog model",
      model,
    });
    const log = await runReads.requestReadLogById(actor, run.runId, [200]);
    expect(log.body).toMatchObject({ selectedModel: model });
    const { claim, sandboxHeaders } = await chatEvents.claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim).toMatchObject({
      billableFirewalls: ["model-provider:openai-api-key"],
      modelUsageProvider: pricingProvider,
    });

    // The Runner addon reports each token category under the claim's
    // modelUsageProvider through the sandbox usage webhook.
    const usageProvider = claim.modelUsageProvider;
    if (!usageProvider) {
      throw new Error("Expected the claim to carry a usage provider");
    }
    const tokens = {
      "tokens.input": 100,
      "tokens.output": 10,
      "tokens.cache_read": 1000,
      "tokens.cache_creation": 20,
    } as const;
    await webhooks.requestAgentUsageEvent(
      {
        runId: run.runId,
        events: Object.entries(tokens).map(([category, quantity]) => {
          return {
            idempotencyKey: randomUUID(),
            kind: "model" as const,
            provider: usageProvider,
            category,
            quantity,
          };
        }),
      },
      sandboxHeaders,
      [200],
    );
    await billing.processOrgUsageEvents(actor);

    // 100*7 + 10*11 + 1000*3 + 20*5 credits under the linked pricing rows.
    const expectedCredits = 3910;
    if (!actor.orgId) {
      throw new Error("Expected an organization member");
    }
    mocks.clerk.session(actor.userId, actor.orgId);
    const record = await accept(
      setupApp({ context, routes: usageRecordRoutes })(usageRecordContract).get(
        { query: {}, headers: authHeaders() },
      ),
      [200],
    );
    expect(record.body.totalCredits).toBe(expectedCredits);
    expect(record.body.rows).toStrictEqual([
      expect.objectContaining({
        threadId: run.threadId,
        credits: expectedCredits,
        breakdown: [
          {
            kind: "model",
            credits: expectedCredits,
            providers: [
              {
                // Usage is named by the run's model; the pricing provider
                // only selects the usage_pricing rows.
                provider: model,
                credits: expectedCredits,
                usageKinds: [{ kind: "model", credits: expectedCredits }],
              },
            ],
          },
        ],
      }),
    ]);
  });
  async function launchCatalogModel(args: {
    readonly model: string;
    readonly routes: Parameters<
      typeof insertCatalogModelFixture
    >[0]["builtInRoutes"];
  }) {
    const chatActor = await chatEvents.entitledChatActor();
    const restore = await insertCatalogModelFixture({
      model: args.model,
      displayName: "Catalog Priced",
      sortOrder: 100_000,
      builtInRoutes: args.routes,
    });
    onTestFinished(restore);
    await seedBuiltInModelCandidateKeys(context, args.model);
    await chatEvents.api.updateOrgModelPolicies(chatActor.actor, [
      {
        model: args.model,
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    return chatActor;
  }

  it("bills a priority-tier run at the route's fast pricing rows", async () => {
    const model = `catalog-fast-${randomUUID()}`;
    const pricingProvider = `catalog-fast-pricing-${randomUUID()}`;
    await seedModelPricingFixture(pricingProvider, {
      ...uniformPrices(BASE_TOKEN_CATEGORIES, 1),
      ...uniformPrices(
        BASE_TOKEN_CATEGORIES.map((category) => {
          return `${category}.fast`;
        }),
        3,
      ),
    });
    const { actor, agentId, runnerGroup } = await launchCatalogModel({
      model,
      routes: [
        {
          concreteProviderType: "openai-api-key",
          upstreamModel: `catalog-fast-upstream-${randomUUID()}`,
          priority: 0,
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
          serviceTiers: ["priority"],
          pricingProvider,
        },
      ],
    });

    const run = await chatEvents.sendChatRun(actor, {
      agentId,
      prompt: "bill the fast tier",
      model,
      runOptions: { codexServiceTier: "fast" },
    });
    const { claim, sandboxHeaders } = await chatEvents.claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim.modelUsageProvider).toBe(pricingProvider);

    // The addon reports priority-tier usage under the `.fast` categories.
    await webhooks.requestAgentUsageEvent(
      {
        runId: run.runId,
        events: [
          { category: "tokens.input.fast", quantity: 100 },
          { category: "tokens.output.fast", quantity: 10 },
        ].map((event) => {
          return {
            idempotencyKey: randomUUID(),
            kind: "model" as const,
            provider: pricingProvider,
            ...event,
          };
        }),
      },
      sandboxHeaders,
      [200],
    );
    await billing.processOrgUsageEvents(actor);

    if (!actor.orgId) {
      throw new Error("Expected an organization member");
    }
    mocks.clerk.session(actor.userId, actor.orgId);
    const record = await accept(
      setupApp({ context, routes: usageRecordRoutes })(usageRecordContract).get(
        { query: {}, headers: authHeaders() },
      ),
      [200],
    );
    // (100 + 10) tokens at the fast rate of 3 credits per token.
    expect(record.body.totalCredits).toBe(330);
  });

  it("runs on the next priced Built-in candidate when the first is unpriced", async () => {
    const model = `catalog-unpriced-${randomUUID()}`;
    const pricedProvider = `catalog-priced-${randomUUID()}`;
    const secondUpstream = `catalog-priced-upstream-${randomUUID()}`;
    await seedModelPricingFixture(
      pricedProvider,
      uniformPrices(BASE_TOKEN_CATEGORIES, 1),
    );
    const { actor, agentId, runnerGroup } = await launchCatalogModel({
      model,
      routes: [
        {
          // First priority, but its pricing link has no usage_pricing rows.
          concreteProviderType: "openrouter-codex",
          upstreamModel: `catalog-unpriced-upstream-${randomUUID()}`,
          priority: 0,
          efforts: [],
          defaultEffort: null,
          pricingProvider: `catalog-unpriced-pricing-${randomUUID()}`,
        },
        {
          concreteProviderType: "openai-api-key",
          upstreamModel: secondUpstream,
          priority: 1,
          efforts: [],
          defaultEffort: null,
          pricingProvider: pricedProvider,
        },
      ],
    });

    const run = await chatEvents.sendChatRun(actor, {
      agentId,
      prompt: "run on a priced route",
      model,
    });
    await expect(
      chatEvents.api.readRun(actor, run.runId),
    ).resolves.toMatchObject({
      source: {
        providerType: "built-in",
        runtimeProviderType: "openai-api-key",
        model,
      },
    });
    const { claim } = await chatEvents.claimChatRun(runnerGroup, run.runId);
    expect(claim).toMatchObject({
      cliAgentType: "codex",
      environment: { OPENAI_MODEL: secondUpstream },
      billableFirewalls: ["model-provider:openai-api-key"],
      modelUsageProvider: pricedProvider,
    });
  });

  it("rejects a Built-in run when no candidate route has complete usage pricing", async () => {
    // Every candidate lacks a category its route can bill: the first has no
    // pricing rows at all, the second prices only base categories while its
    // threshold makes `.long_context` billable. Nothing may run unbilled.
    const model = `catalog-all-unpriced-${randomUUID()}`;
    const basePricedProvider = `catalog-all-unpriced-base-${randomUUID()}`;
    const unpricedProvider = `catalog-all-unpriced-none-${randomUUID()}`;
    await seedModelPricingFixture(
      basePricedProvider,
      uniformPrices(BASE_TOKEN_CATEGORIES, 1),
    );
    const { actor, agentId } = await launchCatalogModel({
      model,
      routes: [
        {
          concreteProviderType: "openrouter-codex",
          upstreamModel: `catalog-all-unpriced-upstream-${randomUUID()}`,
          priority: 0,
          efforts: [],
          defaultEffort: null,
          pricingProvider: unpricedProvider,
        },
        {
          concreteProviderType: "openai-api-key",
          upstreamModel: `catalog-all-unpriced-upstream-${randomUUID()}`,
          priority: 1,
          efforts: [],
          defaultEffort: null,
          pricingProvider: basePricedProvider,
          longContextMinTotalInputTokens: 500_001,
        },
      ],
    });

    const clientEventId = randomUUID();
    const sent = await chatEvents.chat.requestSendEvent(
      actor,
      { agentId, prompt: "run without a priced route", model, clientEventId },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the chat input to be accepted");
    }
    expect(sent.body.runId).toBeNull();
    await flushWaitUntilForTest();
    // The picked input is rejected with the pricing reason; no run starts.
    const { events } = await chatEvents.waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return items.some((item) => {
          return item.eventType === "input.rejected";
        });
      },
    );
    expect(
      events.find((event) => {
        return event.eventType === "input.rejected";
      }),
    ).toMatchObject({ error: "model_provider_unavailable" });
    expect(
      events.filter((event) => {
        return "runId" in event && event.runId !== undefined;
      }),
    ).toStrictEqual([]);
  });

  it("bills a new model's long-context usage at its route's catalog threshold", async () => {
    // Model, upstream and pricing IDs are all fixture values unknown to any
    // code table: the threshold exists only on the route rows. No provider
    // traffic is involved; the usage events are what the Runner addon emits
    // for this threshold.
    const model = `catalog-long-context-${randomUUID()}`;
    const basePricedProvider = `catalog-long-context-base-${randomUUID()}`;
    const pricingProvider = `catalog-long-context-pricing-${randomUUID()}`;
    const upstreamModel = `catalog-long-context-upstream-${randomUUID()}`;
    const threshold = 500_001;
    await seedModelPricingFixture(
      basePricedProvider,
      uniformPrices(BASE_TOKEN_CATEGORIES, 1),
    );
    await seedModelPricingFixture(pricingProvider, {
      ...uniformPrices(BASE_TOKEN_CATEGORIES, 1),
      ...uniformPrices(
        BASE_TOKEN_CATEGORIES.map((category) => {
          return `${category}.long_context`;
        }),
        4,
      ),
    });
    const { actor, agentId, runnerGroup } = await launchCatalogModel({
      model,
      routes: [
        {
          // First priority, but its pricing lacks the .long_context rows its
          // threshold makes billable, so admission skips it.
          concreteProviderType: "openrouter-codex",
          upstreamModel: `catalog-long-context-base-upstream-${randomUUID()}`,
          priority: 0,
          efforts: [],
          defaultEffort: null,
          pricingProvider: basePricedProvider,
          longContextMinTotalInputTokens: threshold,
        },
        {
          concreteProviderType: "openai-api-key",
          upstreamModel,
          priority: 1,
          efforts: [],
          defaultEffort: null,
          pricingProvider,
          longContextMinTotalInputTokens: threshold,
        },
      ],
    });

    const run = await chatEvents.sendChatRun(actor, {
      agentId,
      prompt: "bill long-context usage",
      model,
    });
    const log = await runReads.requestReadLogById(actor, run.runId, [200]);
    expect(log.body).toMatchObject({
      selectedModel: model,
      modelRuntimeProvider: "openai-api-key",
      modelRuntimeModel: upstreamModel,
    });
    const { claim, sandboxHeaders } = await chatEvents.claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim).toMatchObject({
      billableFirewalls: ["model-provider:openai-api-key"],
      modelUsageProvider: pricingProvider,
      modelUsageLongContextMinTotalInputTokens: threshold,
    });

    // One response below the threshold (base) and one at it (.long_context).
    await webhooks.requestAgentUsageEvent(
      {
        runId: run.runId,
        events: [
          { category: "tokens.input", quantity: 100 },
          { category: "tokens.output", quantity: 10 },
          { category: "tokens.input.long_context", quantity: 1000 },
          { category: "tokens.output.long_context", quantity: 20 },
        ].map((event) => {
          return {
            idempotencyKey: randomUUID(),
            kind: "model" as const,
            provider: pricingProvider,
            ...event,
          };
        }),
      },
      sandboxHeaders,
      [200],
    );
    await billing.processOrgUsageEvents(actor);

    if (!actor.orgId) {
      throw new Error("Expected an organization member");
    }
    mocks.clerk.session(actor.userId, actor.orgId);
    const record = await accept(
      setupApp({ context, routes: usageRecordRoutes })(usageRecordContract).get(
        { query: {}, headers: authHeaders() },
      ),
      [200],
    );
    // (100 + 10) base tokens at 1 plus (1000 + 20) long-context tokens at 4.
    expect(record.body.totalCredits).toBe(4190);
  });

  it("keeps a started run's pricing identity when the route is relinked", async () => {
    const model = `catalog-relink-${randomUUID()}`;
    const originalProvider = `catalog-relink-original-${randomUUID()}`;
    const relinkedProvider = `catalog-relink-new-${randomUUID()}`;
    await seedModelPricingFixture(
      originalProvider,
      uniformPrices(BASE_TOKEN_CATEGORIES, 1),
    );
    await seedModelPricingFixture(
      relinkedProvider,
      uniformPrices(BASE_TOKEN_CATEGORIES, 2),
    );
    const { actor, agentId, runnerGroup } = await launchCatalogModel({
      model,
      routes: [
        {
          concreteProviderType: "openai-api-key",
          upstreamModel: `catalog-relink-upstream-${randomUUID()}`,
          priority: 0,
          efforts: [],
          defaultEffort: null,
          pricingProvider: originalProvider,
        },
      ],
    });
    const started = await chatEvents.sendChatRun(actor, {
      agentId,
      prompt: "start before the relink",
      model,
    });

    await updateBuiltInRoutePricingProviderFixture({
      model,
      concreteProviderType: "openai-api-key",
      pricingProvider: relinkedProvider,
    });

    // The run was admitted and captured before the relink: its claim still
    // reports usage under the original pricing identity.
    const { claim } = await chatEvents.claimChatRun(runnerGroup, started.runId);
    expect(claim.modelUsageProvider).toBe(originalProvider);

    // A run created after the relink bills under the new link.
    const next = await chatEvents.sendChatRun(actor, {
      agentId,
      prompt: "start after the relink",
      model,
    });
    const nextClaim = await chatEvents.claimChatRun(runnerGroup, next.runId);
    expect(nextClaim.claim.modelUsageProvider).toBe(relinkedProvider);
  });
});
