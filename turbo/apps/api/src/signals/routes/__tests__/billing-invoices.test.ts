import { randomUUID } from "node:crypto";

import { billingInvoicesContract } from "@okouai/api-contracts/contracts/billing";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { billingInvoicesRoutes } from "../billing-invoices";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const app = setupApp({
  context,
  routes: [...billingInvoicesRoutes, ...webhooksStripeRoutes],
});
const invoices = app(billingInvoicesContract);
const stripeWebhook = app(webhookStripeContract);

function signIn(role: "org:admin" | "org:member" = "org:admin") {
  const actor = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId, role);
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: actor.orgId,
    slug: `invoices-${actor.orgId.slice(-8)}`,
    name: "Invoices Org",
    createdBy: actor.userId,
    createdAt: now(),
  });
  return actor;
}

/** Stripe reports the first paid invoice of a Pro subscription for the org. */
async function subscribePro(orgId: string): Promise<string> {
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_billing_invoices");
  const customerId = `cus_${randomUUID().slice(0, 8)}`;
  const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
  const periodEnd = Math.floor(now() / 1000) + 30 * 86_400;
  const period = { start: periodEnd - 30 * 86_400, end: periodEnd };
  context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
    id: customerId,
    metadata: { orgId },
  });
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
    id: subscriptionId,
    status: "active",
    customer: customerId,
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    trial_end: null,
    metadata: {},
    items: {
      data: [
        {
          price: { id: "price_bdd_pro" },
          current_period_start: period.start,
          current_period_end: period.end,
        },
      ],
    },
  });
  const event = {
    id: `evt_${randomUUID()}`,
    created: Math.floor(now() / 1000),
    type: "invoice.paid",
    data: {
      object: {
        id: `in_${randomUUID().slice(0, 8)}`,
        customer: customerId,
        metadata: {},
        parent: {
          subscription_details: { subscription: subscriptionId, metadata: {} },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${randomUUID().slice(0, 8)}`,
              price: { id: "price_bdd_pro" },
              quantity: 1,
              parent: { type: "subscription_item_details" },
              period,
            },
          ],
        },
      },
    },
  };
  context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(event);
  await accept(
    stripeWebhook.post({
      body: JSON.stringify(event),
      extraHeaders: { "stripe-signature": "t=1,v1=billing-invoices" },
    }),
    [200],
  );
  return customerId;
}

describe("GET /api/billing/invoices", () => {
  it("billing-invoices-003 refuses invoices to a member who is not an admin", async () => {
    signIn("org:member");

    const response = await accept(invoices.get({ headers }), [403]);
    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can view invoices",
        code: "FORBIDDEN",
      },
    });
  });

  it("billing-invoices-004 lists the organization's Stripe invoices for an admin", async () => {
    const admin = signIn();
    const customerId = await subscribePro(admin.orgId);
    const createdFirst = Math.floor(now() / 1000) - 60 * 86_400;
    const createdSecond = createdFirst + 30 * 86_400;
    // Route the application's invoice listing to the Stripe SDK double.
    createBillingMediaApi(context);
    context.mocks.stripe.invoices.list.mockResolvedValue({
      data: [
        {
          id: "inv_001",
          number: "INV-2026-001",
          created: createdFirst,
          amount_paid: 4000,
          status: "paid",
          hosted_invoice_url: "https://invoice.stripe.test/inv_001",
        },
        {
          id: "inv_002",
          number: "INV-2026-002",
          created: createdSecond,
          amount_paid: 4000,
          status: "paid",
          hosted_invoice_url: "https://invoice.stripe.test/inv_002",
        },
      ],
    });

    const response = await accept(invoices.get({ headers }), [200]);
    expect(context.mocks.stripe.invoices.list).toHaveBeenCalledWith(
      expect.objectContaining({ customer: customerId }),
    );
    expect(response.body).toStrictEqual({
      invoices: [
        {
          id: "inv_001",
          number: "INV-2026-001",
          date: createdFirst,
          amount: 4000,
          status: "paid",
          hostedInvoiceUrl: "https://invoice.stripe.test/inv_001",
        },
        {
          id: "inv_002",
          number: "INV-2026-002",
          date: createdSecond,
          amount: 4000,
          status: "paid",
          hostedInvoiceUrl: "https://invoice.stripe.test/inv_002",
        },
      ],
    });
  });

  it("billing-invoices-005 returns no invoices when the organization has no Stripe customer", async () => {
    signIn();
    createBillingMediaApi(context);
    context.mocks.stripe.invoices.list.mockRejectedValue(
      new Error("Stripe invoices must not be listed"),
    );

    const response = await accept(invoices.get({ headers }), [200]);
    expect(response.body).toStrictEqual({ invoices: [] });
    expect(context.mocks.stripe.invoices.list).not.toHaveBeenCalled();
  });
});
