import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { cronReconcileBillingEntitlementsContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { billingStatusRoutes } from "../billing-status";
import { cronReconcileBillingEntitlementsRoutes } from "../cron-reconcile-billing-entitlements";
import { createBddApi } from "./helpers/api-bdd";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createPublicBillingZeroFixture } from "./helpers/public-billing-zero-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const CRON_SECRET = "test-payment-failed-plan-cron";

describe("payment-failed Plan reconciliation", () => {
  it.each(["past_due", "unpaid"] as const)(
    "downgrades an expired %s subscription and its runtime capabilities together",
    async (subscriptionStatus) => {
      const app = await setupApp({
        context,
        routes: [
          ...cronReconcileBillingEntitlementsRoutes,
          ...billingStatusRoutes,
        ],
        isolatePg: true,
      });
      mockNow(new Date("2026-10-20T12:00:00.000Z"));
      mockEnv("CRON_SECRET", CRON_SECRET);
      const owner = createBddApi(context).user();
      const webhooks = createWebhookCallbackApi(context);
      webhooks.configureStripeBillingEnv();
      const billing = createPublicBillingZeroFixture(context, owner, {
        plan: {
          tier: "team",
          priceId: "price_bdd_team",
          webhookSecret: "whsec_bdd_stripe",
        },
      });
      await billing.initialize();
      const paidThrough = Math.floor(now() / 1000) - 2 * 86_400;
      const subscription = {
        id: billing.subscriptionId,
        customer: billing.customerId,
        status: subscriptionStatus,
        metadata: {},
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: null,
        trial_end: null,
        latest_invoice: null,
        items: {
          data: [
            {
              id: `si_${billing.subscriptionId}`,
              price: { id: "price_bdd_team" },
              current_period_end: paidThrough,
            },
          ],
        },
      };
      context.mocks.stripe.events.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.invoices.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription,
      );
      await webhooks.postStripeEvent(
        {
          id: `evt_failed_${billing.subscriptionId}`,
          type: "customer.subscription.updated",
          created: Math.floor(now() / 1000),
          data: { object: subscription },
        },
        [200],
        billing.run,
      );
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
      expect(before.body).toMatchObject({ tier: "team", subscriptionStatus });

      const reconciled = await billing.run(() => {
        return accept(
          app(cronReconcileBillingEntitlementsContract).reconcile({
            headers: { authorization: `Bearer ${CRON_SECRET}` },
          }),
          [200],
        );
      });
      expect(reconciled.body).toMatchObject({ success: true, downgraded: 1 });
      createRouteMocks(context).clerk.session(
        owner.userId,
        owner.orgId,
        "org:admin",
      );
      const after = await accept(
        app(billingStatusContract).get({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(after.body).toMatchObject({
        tier: "limited-free-1",
        subscriptionStatus,
        concurrencyLimit: 2,
        credits: 0,
        creditBreakdown: [],
      });
    },
  );
});
