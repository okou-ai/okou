import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { cronReconcileBillingEntitlementsContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { billingStatusRoutes } from "../billing-status";
import { cronReconcileBillingEntitlementsRoutes } from "../cron-reconcile-billing-entitlements";
import { createRouteMocks } from "./helpers/route-test";
import {
  createBillingWebhookFixture,
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const context = testContext();

/** This suite owns the real global operator and therefore uses a case-owned DB. */
describe("billing reconciliation operator", () => {
  it("publishes canceled capabilities after Stripe discovery recovers", async () => {
    const app = await setupApp({
      context,
      routes: [
        ...cronReconcileBillingEntitlementsRoutes,
        ...billingStatusRoutes,
      ],
      isolatePg: true,
    });
    const owner = createBillingWebhookFixture();
    const subscriptionId = generatedStripeSubscriptionId();
    const customerId = generatedStripeCustomerId();
    const periodEnd = Math.floor(now() / 1000) - 2 * 86_400;
    await postSubscriptionInvoicePaid(context.signal, {
      ...owner,
      tier: "pro",
      customerId,
      subscriptionId,
      status: "past_due",
      currentPeriodEnd: new Date(periodEnd * 1000),
    });
    createRouteMocks(context).clerk.session(
      owner.userId,
      owner.orgId,
      "org:admin",
    );
    const before = await accept(
      app(billingStatusContract).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(before.body).toMatchObject({
      tier: "pro",
      subscriptionStatus: "past_due",
      hasSubscription: true,
    });
    const canceled = {
      id: subscriptionId,
      customer: customerId,
      status: "canceled",
      metadata: {},
      cancel_at_period_end: false,
      cancel_at: null,
      items: {
        data: [
          {
            price: { id: "price_test_pro" },
            current_period_end: periodEnd,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.retrieve
      .mockRejectedValueOnce(new Error("Stripe temporarily unavailable"))
      .mockResolvedValue(canceled);
    mockEnv("CRON_SECRET", "test-billing-reconciliation-secret");

    await accept(
      app(cronReconcileBillingEntitlementsContract).reconcile({
        headers: { authorization: "Bearer test-billing-reconciliation-secret" },
      }),
      [200],
    );
    const status = await accept(
      app(billingStatusContract).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toMatchObject({
      tier: "limited-free-1",
      subscriptionStatus: "canceled",
      hasSubscription: false,
      canBuyConcurrency: false,
      canBuyCredits: false,
      showUsagePack: false,
      autoRechargeAllowed: false,
    });
  });
});
