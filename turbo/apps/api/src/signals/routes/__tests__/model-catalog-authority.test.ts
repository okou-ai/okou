import { modelCatalogContract } from "@okouai/api-contracts/contracts/model-catalog";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import type { UpdateOrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";
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
import {
  insertCatalogModelFixture,
  updateBuiltInRouteFixture,
} from "../../../test-fixtures/model-catalog";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import {
  readRunModelLaunchOptionsFixture,
  readRunModelRuntimeRouteFixture,
} from "../../../test-fixtures/agent-runs";

const context = testContext();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const chatEvents = createChatEventsFixture(context);
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

function signInAdmin(): void {
  const actor = authOrgApi.user();
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
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

describe("model catalog authority", () => {
  it("exposes the database system default and display price tiers", async () => {
    signInAdmin();
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
    signInAdmin();
    const initial = await listPolicies();

    expect(initial.policies).toStrictEqual([
      expect.objectContaining({
        model: "okou-1.0",
        defaultProviderType: "built-in",
        credentialScope: "org",
      }),
    ]);

    // The default is projected rather than persisted, so a write that omits
    // it returns the same projection and revision.
    const written = await accept(
      policiesApi().update({
        headers: authHeaders(),
        body: { revision: initial.revision, policies: [] },
      }),
      [200],
    );
    expect(written.body.revision).toBe(initial.revision);
    expect(written.body.policies).toStrictEqual(initial.policies);
  });

  it("admits a new policy for an active catalog model", async () => {
    signInAdmin();
    const { revision } = await listPolicies();

    // Active in the catalog; the legacy `allow_new_org_policy` flag is false
    // for this row and no longer decides admission.
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
    signInAdmin();
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
    signInAdmin();
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

    // Disabling the first-priority candidate moves Built-in execution to the
    // next enabled route.
    await updateBuiltInRouteFixture({
      model,
      concreteProviderType: "openrouter-codex",
      enabled: false,
    });
    expect(launched(await listPolicies())).toMatchObject({
      runtimeProviderType: "openai-api-key",
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
      readRunModelRuntimeRouteFixture(run.runId),
    ).resolves.toMatchObject({
      modelProvider: "built-in",
      selectedModel: model,
      modelRuntimeProvider: "openai-api-key",
      modelRuntimeModel: upstreamModel,
    });
    await expect(
      readRunModelLaunchOptionsFixture(run.runId),
    ).resolves.toStrictEqual({
      reasoningEffort: "low",
      codexServiceTier: "fast",
    });
    const { claim } = await chatEvents.claimChatRun(runnerGroup, run.runId);
    expect(claim).toMatchObject({
      cliAgentType: "codex",
      environment: { OPENAI_MODEL: upstreamModel },
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
    await expect(
      readRunModelRuntimeRouteFixture(run.runId),
    ).resolves.toMatchObject({ selectedModel: model });
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
                provider: pricingProvider,
                credits: expectedCredits,
                usageKinds: [{ kind: "model", credits: expectedCredits }],
              },
            ],
          },
        ],
      }),
    ]);
  });
});
