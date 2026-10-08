import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { createBddApi } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const webhook = createWebhookCallbackApi(context);
const billing = createBillingMediaApi(context);

function event(type: string, object: Readonly<Record<string, unknown>>) {
  return {
    id: `evt_archived_billing_${randomUUID()}`,
    created: Math.floor(now() / 1000),
    type,
    data: { object },
  };
}

async function paidPlan() {
  const actor = createBddApi(context).user();
  const plan = await createRunsApi(context).grantProEntitlement(actor);
  webhook.configureStripeBillingEnv();
  return { actor, plan, before: await billing.readBillingStatus(actor) };
}

describe("Stripe billing purpose isolation", () => {
  it.each(["invoice purpose", "subscription purpose", "archived source"])(
    "keeps paid Plan benefits unchanged when replaying an invoice identified by %s",
    async (identity) => {
      const { actor, plan, before } = await paidPlan();
      const metadata = {
        orgId: actor.orgId,
        type: "atom_grant",
        purpose: "atom_grant",
        grantType: "credits",
        creditsAmount: "900000",
        ...(identity === "invoice purpose"
          ? { purpose: "usage_allowance" }
          : {}),
        ...(identity === "archived source"
          ? { source: "atom_usage_allowance" }
          : {}),
      };
      const invoice = {
        id: `in_archived_${randomUUID()}`,
        customer: plan.customerId,
        amount_paid: 0,
        metadata,
        parent: {
          subscription_details: {
            subscription: `sub_archived_${randomUUID()}`,
            metadata:
              identity === "subscription purpose"
                ? { purpose: "usage_allowance" }
                : {},
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              price: { id: "price_bdd_atom_grant" },
              period: {
                start: Math.floor(now() / 1000),
                end: Math.floor(now() / 1000) + 86_400,
              },
              parent: { type: "subscription_item_details" },
            },
          ],
        },
      };
      context.mocks.stripe.subscriptions.retrieve.mockClear();
      context.mocks.stripe.subscriptions.update.mockClear();
      context.mocks.stripe.subscriptions.cancel.mockClear();
      for (let replay = 0; replay < 2; replay++) {
        await webhook.postStripeEvent(event("invoice.paid", invoice), [200]);
      }
      await expect(billing.readBillingStatus(actor)).resolves.toStrictEqual(
        before,
      );
      expect(
        context.mocks.stripe.subscriptions.retrieve,
      ).not.toHaveBeenCalled();
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
      expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    },
  );

  it.each(["created", "updated", "deleted"])(
    "preserves the paid Plan when an archived-purpose subscription %s event contains a Plan price",
    async (kind) => {
      const { actor, plan, before } = await paidPlan();
      const subscription = {
        id: plan.subscriptionId,
        customer: plan.customerId,
        status: kind === "deleted" ? "canceled" : "active",
        cancel_at_period_end: false,
        metadata: { purpose: "usage_allowance", orgId: actor.orgId },
        items: { data: [{ price: { id: "price_bdd_team" } }] },
      };
      context.mocks.stripe.subscriptions.retrieve.mockClear();
      await webhook.postStripeEvent(
        event(`customer.subscription.${kind}`, subscription),
        [200],
      );
      await expect(billing.readBillingStatus(actor)).resolves.toStrictEqual(
        before,
      );
      expect(
        context.mocks.stripe.subscriptions.retrieve,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(["line metadata", "price binding", "unmarked price"])(
    "grants only Plan and concurrency benefits from a mixed invoice using %s",
    async (identity) => {
      const { actor, plan, before } = await paidPlan();
      const start = Math.floor(now() / 1000);
      const end = start + 45 * 86_400;
      const retiredPrice = "price_bdd_atom_grant";
      const subscription = {
        id: plan.subscriptionId,
        customer: plan.customerId,
        status: "active",
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: null,
        metadata: { orgId: actor.orgId },
        items: {
          data: [
            {
              price: { id: retiredPrice },
              current_period_end: start + 7 * 86_400,
            },
            {
              price: { id: "price_bdd_pro" },
              current_period_start: start,
              current_period_end: end,
            },
            {
              price: { id: "price_bdd_concurrency" },
              quantity: 3,
              current_period_end: end,
            },
          ],
        },
      };
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription,
      );
      const invoice = {
        id: `in_mixed_${randomUUID()}`,
        customer: plan.customerId,
        amount_paid: 0,
        metadata:
          identity === "price binding"
            ? { allowancePriceId: retiredPrice }
            : {},
        parent: {
          subscription_details: {
            subscription: plan.subscriptionId,
            metadata: {},
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_retired_${randomUUID()}`,
              price: { id: retiredPrice },
              metadata:
                identity === "line metadata"
                  ? { purpose: "usage_allowance" }
                  : {},
              period: { start, end: start + 7 * 86_400 },
              parent: { type: "subscription_item_details" },
            },
            {
              id: `il_plan_${randomUUID()}`,
              price: { id: "price_bdd_pro" },
              period: { start, end },
              parent: { type: "subscription_item_details" },
            },
            {
              id: `il_concurrency_${randomUUID()}`,
              price: { id: "price_bdd_concurrency" },
              quantity: 3,
              period: { start, end },
              parent: { type: "subscription_item_details" },
            },
          ],
        },
      };
      for (let replay = 0; replay < 2; replay++) {
        await webhook.postStripeEvent(event("invoice.paid", invoice), [200]);
      }
      const renewed = await billing.readBillingStatus(actor);
      expect(renewed.credits).toBe(before.credits + 20_000);
      expect(renewed.tier).toBe("pro");
      expect(renewed.currentPeriodEnd).toBe(new Date(end * 1000).toISOString());
      expect(renewed.concurrencySubscriptions).toStrictEqual([
        expect.objectContaining({ id: plan.subscriptionId, quantity: 3 }),
      ]);
      const endingSubscription = {
        ...subscription,
        cancel_at_period_end: true,
      };
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        endingSubscription,
      );
      await webhook.postStripeEvent(
        event("customer.subscription.updated", endingSubscription),
        [200],
      );
      const ending = await billing.readBillingStatus(actor);
      expect(ending.currentPeriodEnd).toBe(new Date(end * 1000).toISOString());
      expect(ending.credits).toBe(renewed.credits);
    },
  );
});
