import { randomUUID } from "node:crypto";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { createBddApi } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

test("grants a paid credit invoice once across distinct webhook events", async () => {
  const orgId = `org_${randomUUID()}`;
  const actor = createBddApi(context).user({ orgId });
  createRouteMocks(context).clerk.session(actor.userId, orgId, "org:admin");
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();

  const app = setupApp({
    context,
    routes: onboardingCompleteRoutes,
  });
  const onboarding = await accept(
    app(onboardingCompleteContract).complete({
      headers: { authorization: "Bearer clerk-session" },
      body: {},
    }),
    [200],
  );
  expect(onboarding.status).toBe(200);

  const billing = createBillingMediaApi(context);
  const baseline = await billing.readBillingStatus(actor);
  const baselineGrantIds = new Set(
    baseline.creditGrants.map((grant) => {
      return grant.id;
    }),
  );
  const expiresAtSeconds = Math.floor(now() / 1000) + 90 * 24 * 60 * 60;
  const invoice = {
    id: `in_credit_purchase_${randomUUID()}`,
    customer: null,
    subtotal: 10_000,
    metadata: {
      type: "credit_purchase",
      purpose: "credit_purchase",
      orgId,
      creditsAmountMode: "amount_subtotal",
      creditsExpiresAt: String(expiresAtSeconds),
    },
    parent: null,
    lines: { has_more: false, data: [] },
  };
  const paidEvent = {
    id: `evt_credit_purchase_${randomUUID()}`,
    type: "invoice.paid",
    created: Math.floor(now() / 1000),
    data: { object: invoice },
  };
  // Simulate Stripe's signature-verification boundary, then use the public route.
  webhooks.acceptNextStripeWebhookEvent(paidEvent);
  const purchased = await webhooks.requestStripeWebhook(
    JSON.stringify(paidEvent),
    { "stripe-signature": "t=1,v1=bdd" },
    [200],
  );
  expect(purchased.status).toBe(200);

  const afterPurchase = await billing.readBillingStatus(actor);
  expect(afterPurchase.credits).toBe(baseline.credits + 100_000);
  expect(afterPurchase.creditGrants).toHaveLength(
    baseline.creditGrants.length + 1,
  );
  expect(afterPurchase.creditGrants).toStrictEqual(
    expect.arrayContaining(baseline.creditGrants),
  );
  const addedGrants = afterPurchase.creditGrants.filter((grant) => {
    return !baselineGrantIds.has(grant.id);
  });
  expect(addedGrants).toStrictEqual([
    expect.objectContaining({
      source: "credit_purchase",
      amount: 100_000,
      remaining: 100_000,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    }),
  ]);

  const replayEvent = {
    ...paidEvent,
    id: `evt_credit_purchase_replay_${randomUUID()}`,
  };
  webhooks.acceptNextStripeWebhookEvent(replayEvent);
  const replayed = await webhooks.requestStripeWebhook(
    JSON.stringify(replayEvent),
    { "stripe-signature": "t=1,v1=bdd" },
    [200],
  );
  expect(replayed.status).toBe(200);
  const afterReplay = await billing.readBillingStatus(actor);
  expect(afterReplay.credits).toBe(afterPurchase.credits);
  expect(afterReplay.creditGrants).toStrictEqual(afterPurchase.creditGrants);
});
