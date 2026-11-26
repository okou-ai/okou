import { randomUUID } from "node:crypto";
import {
  billingPortalContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { billingPortalRoutes } from "../billing-portal";
import { billingStatusRoutes } from "../billing-status";
import { getStartedRoutes } from "../get-started";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { marketingCheckinCampaign } from "./helpers/marketing-reward-consumer";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const APP_URL = "http://app.localhost:3002";
const RETURN_URL = `${APP_URL}/settings/billing`;
const PRICE_CONCURRENCY = "price_metadata_binding_concurrency";
const PORTAL_CONFIGURATION = "bpc_metadata_binding";
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function setup() {
  mockEnv("APP_URL", APP_URL);
  mockEnv("ENV", "development");
  mockEnv("OKOU_PRICE_CONCURRENCY", PRICE_CONCURRENCY);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", `whsec_${randomUUID()}`);
  const admin = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  createRouteMocks(context).clerk.session(admin.userId, admin.orgId);
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: admin.orgId,
    slug: `binding-${admin.orgId.slice(-8)}`,
    name: "Metadata Binding Org",
    createdBy: admin.userId,
    createdAt: now(),
  });
  const appFor = setupApp({
    context,
    routes: [
      ...billingPortalRoutes,
      ...billingStatusRoutes,
      ...getStartedRoutes,
      ...webhooksStripeRoutes,
    ],
  });
  const portal = appFor(billingPortalContract);
  const billing = appFor(billingStatusContract);
  const getStarted = appFor(getStartedContract);
  const webhook = appFor(webhookStripeContract);

  /** Stripe delivers an active add-on subscription with a single concurrency item. */
  async function deliverAddOnSubscriptionCreated(customerId: string) {
    const periodStart = Math.floor(now() / 1000);
    const event = {
      id: `evt_${randomUUID()}`,
      created: periodStart,
      type: "customer.subscription.created",
      data: {
        object: {
          id: `sub_${randomUUID().slice(0, 8)}`,
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
                id: `si_${randomUUID().slice(0, 8)}`,
                price: { id: PRICE_CONCURRENCY },
                quantity: 1,
                current_period_start: periodStart,
                current_period_end: periodStart + 30 * 86_400,
              },
            ],
          },
        },
      },
    };
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      event,
    );
    return await accept(
      webhook.post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=metadata-binding" },
      }),
      [200],
    );
  }

  async function openPortal() {
    return await accept(
      portal.create({ headers, body: { returnUrl: RETURN_URL } }),
      [200],
    );
  }

  async function readStatus() {
    return (await accept(billing.get({ headers }), [200])).body;
  }

  async function checkIn() {
    return (await accept(getStarted.checkin({ headers }), [200])).body;
  }

  return {
    admin,
    deliverAddOnSubscriptionCreated,
    openPortal,
    readStatus,
    checkIn,
  };
}

function stripeCustomerId(): string {
  return `cus_${randomUUID().slice(0, 8)}`;
}

function existingPortalConfiguration() {
  context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
    data: [
      {
        id: PORTAL_CONFIGURATION,
        active: true,
        features: {
          customer_update: { enabled: false },
          invoice_history: { enabled: false },
          payment_method_update: { enabled: true },
          subscription_cancel: { enabled: false },
          subscription_update: { enabled: false },
        },
        login_page: { enabled: false },
        metadata: { purpose: "payment_method_management" },
      },
    ],
    has_more: false,
  });
}

function stripePortalSession(): string {
  const url = `https://billing.stripe.test/session/${randomUUID()}`;
  context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
    id: `bps_${randomUUID()}`,
    url,
  });
  return url;
}

describe("Stripe customer metadata binding", () => {
  it("billing-stripe-metadata-binding-001 initializes a fresh customer metadata Plan and replays without another provider lookup", async () => {
    const { admin, deliverAddOnSubscriptionCreated, readStatus } = setup();
    const customerId = stripeCustomerId();
    context.mocks.stripe.customers.retrieve
      .mockResolvedValueOnce({
        id: customerId,
        metadata: { orgId: admin.orgId },
      })
      .mockRejectedValue(new Error("Stripe customer lookup unavailable"));

    await deliverAddOnSubscriptionCreated(customerId);
    const first = await readStatus();
    await deliverAddOnSubscriptionCreated(customerId);
    const second = await readStatus();

    expect(context.mocks.stripe.customers.retrieve).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      tier: "limited-free-1",
      credits: 0,
      concurrencyLimit: 2,
      canBuyCredits: true,
      canBuyConcurrency: false,
      showUsagePack: false,
      autoRechargeAllowed: false,
      restrictedBuiltInModels: true,
    });
    expect(second).toStrictEqual(first);
  });

  it("billing-stripe-metadata-binding-002 preserves a check-in Plan and reward and skips lazy Clerk existence lookup", async () => {
    marketingCheckinCampaign(context);
    const { admin, deliverAddOnSubscriptionCreated, readStatus, checkIn } =
      setup();
    const receipt = await checkIn();
    const before = await readStatus();
    const customerId = stripeCustomerId();
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: admin.orgId },
    });
    context.mocks.clerk.organizations.getOrganization.mockClear();
    context.mocks.clerk.organizations.getOrganization.mockRejectedValue(
      new Error("Clerk organization lookup unavailable"),
    );

    await deliverAddOnSubscriptionCreated(customerId);
    const after = await readStatus();
    const repeated = await checkIn();

    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
    expect(after).toStrictEqual(before);
    expect(repeated).toStrictEqual(receipt);
  });

  it("billing-stripe-metadata-binding-003 keeps a different published customer and the complete public Plan unchanged", async () => {
    const { admin, deliverAddOnSubscriptionCreated, openPortal, readStatus } =
      setup();
    const publishedCustomerId = stripeCustomerId();
    context.mocks.stripe.customers.create.mockResolvedValue({
      id: publishedCustomerId,
    });
    existingPortalConfiguration();
    stripePortalSession();
    await openPortal();
    const before = await readStatus();
    const incomingCustomerId = stripeCustomerId();
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: incomingCustomerId,
      metadata: { orgId: admin.orgId },
    });

    await deliverAddOnSubscriptionCreated(incomingCustomerId);
    const after = await readStatus();
    const url = stripePortalSession();
    const reopened = await openPortal();

    expect(after).toStrictEqual(before);
    expect(reopened.body).toStrictEqual({ url });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenLastCalledWith({
      customer: publishedCustomerId,
      configuration: PORTAL_CONFIGURATION,
      return_url: RETURN_URL,
    });
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledTimes(1);
  });

  it("billing-stripe-metadata-binding-005 ignores a missing metadata customer and preserves the public Plan", async () => {
    marketingCheckinCampaign(context);
    const { deliverAddOnSubscriptionCreated, readStatus, checkIn } = setup();
    await checkIn();
    const before = await readStatus();
    const customerId = stripeCustomerId();
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: {},
    });
    context.mocks.clerk.organizations.getOrganization.mockClear();

    await deliverAddOnSubscriptionCreated(customerId);
    const after = await readStatus();

    expect(after).toStrictEqual(before);
    expect(context.mocks.stripe.customers.retrieve).toHaveBeenCalledWith(
      customerId,
    );
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
  });

  it('billing-stripe-metadata-binding-006 ignores Clerk\'s explicit missing organization response {"statusCode":404}', async () => {
    const { admin, deliverAddOnSubscriptionCreated, openPortal } = setup();
    const incomingCustomerId = stripeCustomerId();
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: incomingCustomerId,
      metadata: { orgId: admin.orgId },
    });
    context.mocks.clerk.organizations.getOrganization.mockRejectedValueOnce({
      statusCode: 404,
    });

    await deliverAddOnSubscriptionCreated(incomingCustomerId);
    const publishedCustomerId = stripeCustomerId();
    context.mocks.stripe.customers.create.mockResolvedValue({
      id: publishedCustomerId,
    });
    existingPortalConfiguration();
    const url = stripePortalSession();
    const opened = await openPortal();

    expect(opened.body).toStrictEqual({ url });
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith({
      customer: publishedCustomerId,
      configuration: PORTAL_CONFIGURATION,
      return_url: RETURN_URL,
    });
  });
});
