import { randomUUID } from "node:crypto";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import StripeSDK from "stripe";

import { accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { mockStripeClient } from "../../external/stripe-client";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createBillingCheckoutFixture } from "./helpers/billing-checkout-fixture";

const {
  context,
  TEST_PRICE_CONCURRENCY,
  setTierPrices,
  currentSecond,
  readBillingStatus,
  createConcurrencySubscriptionOrg,
} = createBillingCheckoutFixture();

describe("Concurrency invoice publication", () => {
  beforeEach(() => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    setTierPrices();
  });

  it("retries a concurrency invoice after a newer subscription cancellation wins", async () => {
    mockNow(new Date("2035-05-01T00:00:00Z"));
    const periodEnd = new Date("2035-06-01T00:00:00Z");
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId: `sub_${randomUUID()}`,
      slots: 2,
      periodEnd,
    });
    const before = await readBillingStatus(fixture);
    const subscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      schedule: null,
      metadata: { purpose: "concurrency_subscription" },
      items: {
        data: [
          {
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 2,
            current_period_end: Math.floor(periodEnd.getTime() / 1000),
          },
        ],
      },
    };
    const canceling = { ...subscription, cancel_at_period_end: true };
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValue(canceling)
      .mockImplementationOnce(async () => {
        const event = {
          type: "customer.subscription.updated",
          data: { object: canceling },
        };
        context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
          event,
        );
        await accept(
          setupApp({ context, routes: webhooksStripeRoutes })(
            webhookStripeContract,
          ).post({
            body: JSON.stringify(event),
            extraHeaders: { "stripe-signature": "t=1,v1=invoice-race" },
          }),
          [200],
        );
        return subscription;
      });
    const invoice = {
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID()}`,
          customer: fixture.customerId,
          metadata: { purpose: "concurrency_subscription" },
          parent: {
            subscription_details: {
              subscription: fixture.subscriptionId,
              metadata: { purpose: "concurrency_subscription" },
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                quantity: 2,
                price: { id: TEST_PRICE_CONCURRENCY },
                parent: { type: "subscription_item_details" },
                period: {
                  start: currentSecond(),
                  end: Math.floor(periodEnd.getTime() / 1000),
                },
              },
            ],
          },
        },
      },
    };
    const webhook = createWebhookCallbackApi(context);
    const stale = await webhook.postStripeEvent(invoice, [500]);
    expect(stale.status).toBe(500);

    for (let delivery = 0; delivery < 2; delivery++) {
      await webhook.postStripeEvent(invoice, [200]);
      const status = await readBillingStatus(fixture);
      expect(status.credits).toBe(before.credits);
      expect(status.concurrencySubscriptions).toStrictEqual([
        expect.objectContaining({
          id: fixture.subscriptionId,
          quantity: 2,
          cancelAtPeriodEnd: true,
          currentPeriodEnd: periodEnd.toISOString(),
        }),
      ]);
    }
  });
});
