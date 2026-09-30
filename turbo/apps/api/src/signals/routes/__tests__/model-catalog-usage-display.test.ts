import { randomUUID } from "node:crypto";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import {
  deleteUsagePricingRows,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { usageRecordRoutes } from "../usage-record";
import { insertCatalogModelFixture } from "../../../test-fixtures/model-catalog";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const mocks = createRouteMocks(context);
const chatEvents = createChatEventsFixture(context);
const webhooks = createWebhookCallbackApi(context);
const billing = createBillingMediaApi(context);

describe("model usage under a pricing alias", () => {
  it("classifies long context from run data and names the actual model", async () => {
    const { actor, agentId, runnerGroup } =
      await chatEvents.entitledChatActor();
    // The Built-in route bills under a pricing alias that is not a key of the
    // long-context map; its upstream model is. The upstream ID only selects
    // billing data here: this verifies the claim and billing contracts, not
    // live provider acceptance.
    const model = `catalog-alias-${randomUUID()}`;
    const pricingProvider = `catalog-alias-pricing-${randomUUID()}`;
    // Base rows keep the route fully priced for admission; only the
    // long-context rows are charged below.
    const pricedCategories = {
      "tokens.input": 1,
      "tokens.output": 1,
      "tokens.cache_read": 1,
      "tokens.cache_creation": 1,
      "tokens.input.long_context": 7,
      "tokens.output.long_context": 11,
      "tokens.cache_read.long_context": 3,
      "tokens.cache_creation.long_context": 5,
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
      displayName: "Catalog Alias",
      sortOrder: 100_000,
      builtInRoutes: [
        {
          concreteProviderType: "openai-api-key",
          upstreamModel: "gpt-6-luna",
          priority: 0,
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
          pricingProvider,
          longContextMinTotalInputTokens: 272_001,
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
      prompt: "bill the aliased catalog model",
      model,
    });
    const { claim, sandboxHeaders } = await chatEvents.claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim).toMatchObject({
      billableFirewalls: ["model-provider:openai-api-key"],
      modelUsageProvider: pricingProvider,
      modelUsageLongContextMinTotalInputTokens: 272_001,
    });

    // The Runner addon reports long-context usage under the pricing alias.
    const tokens = {
      "tokens.input.long_context": 100,
      "tokens.output.long_context": 10,
      "tokens.cache_read.long_context": 1000,
      "tokens.cache_creation.long_context": 20,
    } as const;
    await webhooks.requestAgentUsageEvent(
      {
        runId: run.runId,
        events: Object.entries(tokens).map(([category, quantity]) => {
          return {
            idempotencyKey: randomUUID(),
            kind: "model" as const,
            provider: pricingProvider,
            category,
            quantity,
          };
        }),
      },
      sandboxHeaders,
      [200],
    );
    await billing.processOrgUsageEvents(actor);

    // 100*7 + 10*11 + 1000*3 + 20*5 credits under the alias's rows.
    const expectedCredits = 3910;
    if (!actor.orgId) {
      throw new Error("Expected an organization member");
    }
    mocks.clerk.session(actor.userId, actor.orgId);
    const record = await accept(
      setupApp({ context, routes: usageRecordRoutes })(usageRecordContract).get(
        {
          query: {},
          headers: { authorization: "Bearer clerk-session" },
        },
      ),
      [200],
    );
    expect(record.body.totalCredits).toBe(expectedCredits);
    // The row names the run's model, which the App shows as its catalog
    // display name ("Catalog Alias").
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
});
