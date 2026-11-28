import { randomUUID } from "node:crypto";
import { billingPortalContract } from "@okouai/api-contracts/contracts/billing";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { billingPortalRoutes } from "../billing-portal";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const APP_URL = "http://app.localhost:3002";
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const PORTAL_CONFIGURATION = "bpc_payment_methods";
const PORTAL_FEATURES = Object.freeze({
  customer_update: { enabled: false },
  invoice_history: { enabled: false },
  payment_method_update: { enabled: true },
  subscription_cancel: { enabled: false },
  subscription_update: { enabled: false },
});

function setup(role: "org:admin" | "org:member" = "org:admin") {
  mockEnv("APP_URL", APP_URL);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_billing_portal");
  const admin = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  createRouteMocks(context).clerk.session(admin.userId, admin.orgId, role);
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: admin.orgId,
    slug: `portal-${admin.orgId.slice(-8)}`,
    name: "Billing Portal Org",
    createdBy: admin.userId,
    createdAt: now(),
  });
  const appFor = setupApp({
    context,
    routes: [...billingPortalRoutes, ...webhooksStripeRoutes],
  });
  const portal = appFor(billingPortalContract);
  const webhook = appFor(webhookStripeContract);

  /** Stripe records a paid Pro subscription invoice for the organization. */
  async function subscribePro(): Promise<string> {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const periodEnd = Math.floor(now() / 1000) + 30 * 86_400;
    const period = { start: periodEnd - 30 * 86_400, end: periodEnd };
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: customerId,
      metadata: { orgId: admin.orgId },
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
            subscription_details: {
              subscription: subscriptionId,
              metadata: {},
            },
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
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      event,
    );
    await accept(
      webhook.post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=billing-portal" },
      }),
      [200],
    );
    return customerId;
  }

  return { admin, portal, subscribePro };
}

function stripePortalSession(): string {
  const url = `https://billing.stripe.test/session/${randomUUID()}`;
  context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
    id: `bps_${randomUUID()}`,
    url,
  });
  return url;
}

function managedConfiguration(
  features: typeof PORTAL_FEATURES = PORTAL_FEATURES,
) {
  return {
    id: PORTAL_CONFIGURATION,
    active: true,
    features,
    login_page: { enabled: false },
    metadata: { purpose: "payment_method_management" },
  };
}

/** A subscribed admin opens the portal; returns what Stripe received. */
async function openSubscribedPortal(returnUrl: string) {
  const { portal, subscribePro } = setup();
  const customerId = await subscribePro();
  context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
    data: [managedConfiguration()],
    has_more: false,
  });
  const url = stripePortalSession();
  const response = await accept(
    portal.create({ headers, body: { returnUrl } }),
    [200],
  );
  return {
    body: response.body,
    url,
    session:
      context.mocks.stripe.billingPortal.sessions.create.mock.calls[0]?.[0],
    expectedSession: {
      customer: customerId,
      configuration: PORTAL_CONFIGURATION,
      return_url: returnUrl,
    },
  };
}

describe("POST /api/billing/portal", () => {
  it("billing-portal-003 refuses the billing portal to a non-admin member", async () => {
    const { portal } = setup("org:member");

    const response = await accept(
      portal.create({
        headers,
        body: { returnUrl: `${APP_URL}/settings/billing` },
      }),
      [403],
    );

    expect(response.body.error).toMatchObject({
      message: "Only org admins can manage billing",
      code: "FORBIDDEN",
    });
  });

  it("billing-portal-004 opens the portal returning to the app origin", async () => {
    const opened = await openSubscribedPortal(`${APP_URL}/settings/billing`);

    expect(opened.body).toStrictEqual({ url: opened.url });
    expect(opened.session).toStrictEqual(opened.expectedSession);
  });

  it("billing-portal-005 opens the portal returning to okou.ai", async () => {
    const opened = await openSubscribedPortal(
      "https://okou.ai/settings/billing",
    );

    expect(opened.body).toStrictEqual({ url: opened.url });
    expect(opened.session).toStrictEqual(opened.expectedSession);
  });

  it("billing-portal-011 creates a customer and payment-method portal for an org without a subscription", async () => {
    const { admin, portal } = setup();
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.billingPortal.configurations.create.mockResolvedValue(
      managedConfiguration(),
    );
    const url = stripePortalSession();
    const returnUrl = `${APP_URL}/settings/billing`;

    const response = await accept(
      portal.create({ headers, body: { returnUrl } }),
      [200],
    );

    expect(response.body).toStrictEqual({ url });
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith(
      { metadata: expect.objectContaining({ orgId: admin.orgId }) },
      { idempotencyKey: `stripe-customer:development::${admin.orgId}` },
    );
    expect(
      context.mocks.stripe.billingPortal.configurations.create,
    ).toHaveBeenCalledWith(
      {
        name: "Okou payment methods",
        features: PORTAL_FEATURES,
        login_page: { enabled: false },
        metadata: { purpose: "payment_method_management" },
      },
      { idempotencyKey: "payment-method-portal-v2" },
    );
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith({
      customer: customerId,
      configuration: PORTAL_CONFIGURATION,
      return_url: returnUrl,
    });
  });

  it("billing-portal-012 repairs a managed portal configuration that allows cancellation", async () => {
    const { portal, subscribePro } = setup();
    const customerId = await subscribePro();
    context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
      data: [
        managedConfiguration({
          ...PORTAL_FEATURES,
          subscription_cancel: { enabled: true },
        }),
      ],
      has_more: false,
    });
    context.mocks.stripe.billingPortal.configurations.update.mockResolvedValue(
      managedConfiguration(),
    );
    const url = stripePortalSession();
    const returnUrl = `${APP_URL}/settings/billing`;

    const response = await accept(
      portal.create({ headers, body: { returnUrl } }),
      [200],
    );

    expect(response.body).toStrictEqual({ url });
    expect(
      context.mocks.stripe.billingPortal.configurations.update,
    ).toHaveBeenCalledWith(PORTAL_CONFIGURATION, {
      active: true,
      name: "Okou payment methods",
      features: PORTAL_FEATURES,
      login_page: { enabled: false },
      metadata: { purpose: "payment_method_management" },
    });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith({
      customer: customerId,
      configuration: PORTAL_CONFIGURATION,
      return_url: returnUrl,
    });
  });

  it("billing-portal-013 rejects a return URL on an unrelated origin", async () => {
    const { portal } = setup();

    const response = await accept(
      portal.create({
        headers,
        body: { returnUrl: "https://evil.example.com/settings/billing" },
      }),
      [400],
    );

    expect(response.body.error).toStrictEqual({
      message: "returnUrl must match the platform origin",
      code: "BAD_REQUEST",
    });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("billing-portal-014 rejects a return URL that only starts with okou.ai", async () => {
    const { portal } = setup();

    const response = await accept(
      portal.create({
        headers,
        body: { returnUrl: "https://okou.ai.evil.example/settings/billing" },
      }),
      [400],
    );

    expect(response.body.error).toStrictEqual({
      message: "returnUrl must match the platform origin",
      code: "BAD_REQUEST",
    });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).not.toHaveBeenCalled();
  });
});
