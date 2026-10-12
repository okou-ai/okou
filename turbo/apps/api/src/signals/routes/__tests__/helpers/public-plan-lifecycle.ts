import { randomUUID } from "node:crypto";
import { expect, onTestFinished } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import { now } from "../../../../lib/time";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import type { ApiTestUser } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";

/** A real Stripe subscription lifecycle; it issues no invoice or credit grant. */
export function publicPlanLifecycle(
  context: TestContext,
  actor: ApiTestUser,
  tier: "pro" | "team" = "pro",
  existing?: { readonly customerId: string; readonly subscriptionId: string },
) {
  const customerId = existing?.customerId ?? `cus_plan_${randomUUID()}`;
  let subscriptionId = existing?.subscriptionId ?? `sub_plan_${randomUUID()}`;
  let created = existing !== undefined;
  let canceled = false;
  onTestFinished(async () => {
    if (!created) {
      return;
    }
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureStripeBillingEnv();
    await webhooks.postStripeEvent(
      {
        id: `evt_${randomUUID()}`,
        type: "customer.subscription.deleted",
        created: Math.floor(now() / 1000),
        data: {
          object: {
            id: subscriptionId,
            customer: customerId,
            status: "canceled",
            metadata: {},
          },
        },
      },
      [200],
    );
    await flushWaitUntilForTest();
  });
  return {
    async update(status: "active" | "trialing" | "past_due" | "canceled") {
      const webhooks = createWebhookCallbackApi(context);
      webhooks.configureStripeBillingEnv();
      // Stripe cancellation is terminal: its deletion event releases the old
      // subscription before the customer subscribes again under a new identity.
      if (canceled && status !== "canceled") {
        await webhooks.postStripeEvent(
          {
            id: `evt_${randomUUID()}`,
            type: "customer.subscription.deleted",
            created: Math.floor(now() / 1000),
            data: {
              object: {
                id: subscriptionId,
                customer: customerId,
                status: "canceled",
                metadata: {},
              },
            },
          },
          [200],
        );
        await flushWaitUntilForTest();
        subscriptionId = `sub_plan_${randomUUID()}`;
        created = false;
      }
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId: actor.orgId },
      });
      const subscription = {
        id: subscriptionId,
        customer: customerId,
        status,
        metadata: {},
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: null,
        trial_end: null,
        items: {
          data: [
            {
              price: {
                id: tier === "team" ? "price_bdd_team" : "price_bdd_pro",
              },
            },
          ],
        },
      };
      if (!created) {
        await webhooks.postStripeEvent(
          {
            id: `evt_${randomUUID()}`,
            type: "customer.subscription.created",
            created: Math.floor(now() / 1000),
            data: { object: { ...subscription, status: "active" } },
          },
          [200],
        );
        created = true;
      }
      await webhooks.postStripeEvent(
        {
          id: `evt_${randomUUID()}`,
          type: "customer.subscription.updated",
          created: Math.floor(now() / 1000),
          data: { object: subscription },
        },
        [200],
      );
      canceled = status === "canceled";
      await flushWaitUntilForTest();
      await expect(
        createRunsApi(context).readBillingStatus(actor),
      ).resolves.toMatchObject({
        tier,
        status: status === "canceled" ? "suspended" : "active",
      });
    },
  };
}
