import { randomUUID } from "node:crypto";
import { billingCreditCheckoutContract } from "@okouai/api-contracts/contracts/billing";
import { expect } from "vitest";
import { z } from "zod";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { billingCreditCheckoutRoutes } from "../../billing-credit-checkout";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { createRouteMocks } from "./route-test";

const checkoutSchema = z.object({
  customer: z.string(),
  invoice_creation: z.object({
    invoice_data: z.object({ metadata: z.record(z.string(), z.string()) }),
  }),
  line_items: z.array(z.object({ quantity: z.number() })),
});

export async function purchaseToolCredits(
  context: TestContext,
  actor: ApiTestUser,
  purchase: {
    readonly credits: number;
    readonly customerId: string;
    readonly invoiceId: string;
  },
): Promise<void> {
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();
  mockEnv("OKOU_PRICE_CUSTOM_CREDIT_UNIT", "price_public_tool_credit_unit");
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:admin",
  );
  let observed: z.infer<typeof checkoutSchema> | undefined;
  const url = `https://checkout.stripe.test/${randomUUID()}`;
  context.mocks.stripe.checkout.sessions.create.mockImplementationOnce(
    (input) => {
      observed = checkoutSchema.parse(input);
      return Promise.resolve({ id: `cs_${randomUUID()}`, url });
    },
  );
  const origin = new URL(env("APP_URL")).origin;
  const checkout = await accept(
    setupApp({ context, routes: billingCreditCheckoutRoutes })(
      billingCreditCheckoutContract,
    ).create({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        credits: purchase.credits,
        successUrl: `${origin}/billing`,
        cancelUrl: `${origin}/billing`,
      },
    }),
    [200],
  );
  expect(checkout.body).toStrictEqual({ url });
  if (!observed) {
    throw new Error("Expected Stripe to receive the credit checkout");
  }
  expect(observed.customer).toBe(purchase.customerId);
  expect(observed.line_items).toMatchObject([
    { quantity: purchase.credits / 1000 },
  ]);
  await webhooks.postStripeEvent(
    {
      id: `evt_${randomUUID()}`,
      type: "invoice.paid",
      created: Math.floor(now() / 1000),
      data: {
        object: {
          id: purchase.invoiceId,
          customer: observed.customer,
          subtotal: purchase.credits / 10,
          amount_paid: purchase.credits / 10,
          metadata: observed.invoice_creation.invoice_data.metadata,
          parent: null,
          lines: { has_more: false, data: [] },
        },
      },
    },
    [200],
  );
  await flushWaitUntilForTest();
}

/** Normal personal model authorization and actual Runner claim; no signed test token. */
export async function claimPublicToolRun(
  context: TestContext,
  actor: ApiTestUser,
  registerCleanup: (cleanup: () => Promise<void>) => void,
) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(actor, {
    displayName: "Public paid-tool actor",
    visibility: "private",
  });
  const owned: { runId?: string; sandboxToken?: string } = {};
  let released = false;
  const storageBucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKeyId = env("SECRETS_KMS_KEY_ID");
  const cleanup = async () => {
    if (released) {
      return;
    }
    released = true;
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", storageBucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const { runId, sandboxToken } = owned;
    if (runId) {
      const current = await runs.readRun(actor, runId);
      if (["queued", "pending", "running"].includes(current.status)) {
        await runs.requestCancelRun(actor, runId, [200]);
      }
      if (sandboxToken) {
        await createWebhookCallbackApi(context).requestAgentComplete(
          { runId, exitCode: 1, error: "Run cancelled" },
          { authorization: `Bearer ${sandboxToken}` },
          [200],
        );
      }
      await flushWaitUntilForTest();
    }
    await bdd.deleteAgent(actor, agent.agentId);
    await flushWaitUntilForTest();
  };
  registerCleanup(cleanup);
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    model: "claude-fable-5-1",
    prompt: "Use a paid tool",
  });
  owned.runId = run.runId;
  await runs.heartbeatRunner(runnerGroup);
  const claim = await runs.claimRunnerJob(run.runId);
  owned.sandboxToken = claim.sandboxToken;
  const token = claim.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected the claimed Runner's Okou credential");
  }
  return {
    ...run,
    claim,
    cleanup,
    token,
    headers: { authorization: `Bearer ${token}` },
  };
}
