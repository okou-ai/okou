import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { mockStripeClient } from "../../external/stripe-client";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();

describe("signed subscription deletion", () => {
  it.each(["pro", "team"] as const)(
    "preserves paid credits and free capabilities after deleting and redelivering %s",
    async (tier) => {
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const actor = bdd.user();
      bdd.acceptAgentStorageWrites();
      const granted = await runs.grantProEntitlement(actor, {
        tier,
        stripeTransport: "http",
      });
      const before = await runs.readBillingStatus(actor);
      expect(before).toMatchObject({
        tier,
        hasSubscription: true,
        credits: tier === "team" ? 120_000 : 20_000,
      });

      const { default: Stripe } =
        await vi.importActual<typeof import("stripe")>("stripe");
      const stripe = new Stripe(env("STRIPE_SECRET_KEY"));
      mockStripeClient(stripe);
      const payload = JSON.stringify({
        id: `evt_signed_deletion_${randomUUID()}`,
        object: "event",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: granted.subscriptionId,
            customer: granted.customerId,
            object: "subscription",
            status: "canceled",
            metadata: { purpose: "plan", utm_source: "retired" },
          },
        },
      });
      const client = setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      );

      for (const delivery of ["initial", "redelivery"]) {
        await accept(
          client.post({
            body: payload,
            extraHeaders: {
              "stripe-signature": stripe.webhooks.generateTestHeaderString({
                payload,
                secret: "whsec_bdd_stripe",
              }),
            },
          }),
          [200],
        );
        const after = await runs.readBillingStatus(actor);
        expect(after, delivery).toMatchObject({
          tier: "limited-free-1",
          status: "active",
          subscriptionStatus: "canceled",
          hasSubscription: false,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: null,
          scheduledChange: null,
          canBuyConcurrency: false,
          autoRechargeAllowed: false,
          restrictedBuiltInModels: true,
          workflowWebhookAutomationAllowed: false,
          concurrencyLimit: 2,
          credits: before.credits,
        });
        expect(after.creditGrants, delivery).toStrictEqual(before.creditGrants);
      }
    },
  );
});
