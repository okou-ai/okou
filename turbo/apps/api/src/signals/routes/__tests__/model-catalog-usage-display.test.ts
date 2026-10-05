import { randomUUID } from "node:crypto";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createUsagePricingFixture } from "../../../test-fixtures/usage-pricing";
import { createRouteMocks } from "./helpers/route-test";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { usageRecordRoutes } from "../usage-record";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const mocks = createRouteMocks(context);
const chatEvents = createChatEventsFixture(context);
const webhooks = createWebhookCallbackApi(context);
const billing = createBillingMediaApi(context);

describe("fixed Auto usage display", () => {
  it("classifies long context from run data and names the actual model", async () => {
    const { actor, agentId, runnerGroup } =
      await chatEvents.entitledChatActor();
    const model = "okou-1.0";
    const categories = {
      "tokens.input": 1,
      "tokens.output": 1,
      "tokens.cache_read": 1,
      "tokens.cache_creation": 1,
      "tokens.input.long_context": 7,
      "tokens.output.long_context": 11,
      "tokens.cache_read.long_context": 3,
      "tokens.cache_creation.long_context": 5,
    } as const;
    const pricing = await createUsagePricingFixture({
      configured: Object.entries(categories).map(([category, unitPrice]) => {
        return {
          kind: "model",
          provider: model,
          category,
          unitPrice,
          unitSize: 1,
        };
      }),
    });
    onTestFinished(pricing.cleanup);
    await chatEvents.configureBuiltInPiModel(actor);
    chatEvents.mockPiResourceArchiveDownloads();
    chatEvents.mockPiCheckpointObjectStore();
    const run = await chatEvents.sendChatRun(
      actor,
      { agentId, prompt: "bill fixed Auto long context", model },
      pricing.resolution,
    );
    const { claim, sandboxHeaders } = await chatEvents.claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim).toMatchObject({
      billableFirewalls: ["model-provider:openrouter-codex"],
      modelUsageProvider: model,
      modelUsageLongContextMinTotalInputTokens: 272_001,
    });
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
            kind: "model",
            provider: model,
            category,
            quantity,
          };
        }),
      },
      sandboxHeaders,
      [200],
      pricing.resolution,
    );
    await billing.processOrgUsageEvents(actor, pricing.resolution);
    if (!actor.orgId) {
      throw new Error("Expected an organization member");
    }
    mocks.clerk.session(actor.userId, actor.orgId);
    const record = await accept(
      setupApp({ context, routes: usageRecordRoutes })(usageRecordContract).get(
        { query: {}, headers: { authorization: "Bearer clerk-session" } },
      ),
      [200],
    );
    expect(record.body.totalCredits).toBe(3910);
    expect(record.body.rows).toStrictEqual([
      expect.objectContaining({
        threadId: run.threadId,
        credits: 3910,
        breakdown: [
          {
            kind: "model",
            credits: 3910,
            providers: [
              {
                provider: model,
                credits: 3910,
                usageKinds: [{ kind: "model", credits: 3910 }],
              },
            ],
          },
        ],
      }),
    ]);
    await chatEvents.cancelChatRun(actor, run.runId, sandboxHeaders);
  });
});
