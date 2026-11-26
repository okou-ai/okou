import { randomUUID } from "node:crypto";
import {
  billingPortalContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { billingPortalRoutes } from "../billing-portal";
import { billingStatusRoutes } from "../billing-status";
import { getStartedRoutes } from "../get-started";
import { marketingCheckinCampaign } from "./helpers/marketing-reward-consumer";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const APP_URL = "http://app.localhost:3002";
const RETURN_URL = `${APP_URL}/settings/billing`;
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const PORTAL_CONFIGURATION = "bpc_payment_methods";

function setup() {
  mockEnv("APP_URL", APP_URL);
  mockEnv("ENV", "development");
  const admin = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  createRouteMocks(context).clerk.session(admin.userId, admin.orgId);
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: admin.orgId,
    slug: `publication-${admin.orgId.slice(-8)}`,
    name: "Customer Publication Org",
    createdBy: admin.userId,
    createdAt: now(),
  });
  const appFor = setupApp({
    context,
    routes: [
      ...billingPortalRoutes,
      ...billingStatusRoutes,
      ...getStartedRoutes,
    ],
  });
  const portal = appFor(billingPortalContract);
  const billing = appFor(billingStatusContract);
  const getStarted = appFor(getStartedContract);

  async function openPortal(status: 200 | 500 = 200) {
    return await accept(
      portal.create({ headers, body: { returnUrl: RETURN_URL } }),
      [status],
    );
  }

  async function readStatus() {
    return (await accept(billing.get({ headers }), [200])).body;
  }

  async function checkIn() {
    return (await accept(getStarted.checkin({ headers }), [200])).body;
  }

  return { admin, openPortal, readStatus, checkIn };
}

function managedConfiguration() {
  return {
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
  };
}

function existingPortalConfiguration() {
  context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
    data: [managedConfiguration()],
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

function stripeCustomerId(): string {
  return `cus_${randomUUID().slice(0, 8)}`;
}

describe("billing customer publication", () => {
  it("billing-customer-publication-001 initializes the default Plan through a fresh payment-method portal and reuses its customer", async () => {
    const { admin, openPortal, readStatus } = setup();
    const customerId = stripeCustomerId();
    context.mocks.stripe.customers.create
      .mockResolvedValueOnce({ id: customerId })
      .mockResolvedValue({ id: stripeCustomerId() });
    context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.billingPortal.configurations.create.mockResolvedValue(
      managedConfiguration(),
    );
    const url = stripePortalSession();

    const first = await openPortal();
    const firstStatus = await readStatus();
    const second = await openPortal();
    const secondStatus = await readStatus();

    expect(first.body).toStrictEqual({ url });
    expect(second.body).toStrictEqual({ url });
    expect(firstStatus).toMatchObject({
      tier: "limited-free-1",
      status: "active",
      credits: 0,
      concurrencyLimit: 2,
      canBuyCredits: true,
      canBuyConcurrency: false,
      showUsagePack: false,
      autoRechargeAllowed: false,
      workflowWebhookAutomationAllowed: false,
      restrictedBuiltInModels: true,
      hasSubscription: false,
      subscriptionStatus: null,
    });
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith(
      { metadata: expect.objectContaining({ orgId: admin.orgId }) },
      { idempotencyKey: `stripe-customer:development::${admin.orgId}` },
    );
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenLastCalledWith({
      customer: customerId,
      configuration: PORTAL_CONFIGURATION,
      return_url: RETURN_URL,
    });
    expect(secondStatus).toStrictEqual(firstStatus);
  });

  it("billing-customer-publication-002 binds an organization initialized by a check-in while preserving its Plan and reward", async () => {
    marketingCheckinCampaign(context);
    const { openPortal, readStatus, checkIn } = setup();
    const receipt = await checkIn();
    const before = await readStatus();
    const customerId = stripeCustomerId();
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    existingPortalConfiguration();
    const url = stripePortalSession();

    const opened = await openPortal();
    const after = await readStatus();
    const repeated = await checkIn();

    expect(opened.body).toStrictEqual({ url });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith({
      customer: customerId,
      configuration: PORTAL_CONFIGURATION,
      return_url: RETURN_URL,
    });
    expect(after).toStrictEqual(before);
    expect(repeated).toStrictEqual(receipt);
  });

  it("billing-customer-publication-003 publishes one authoritative customer for concurrent fresh portal requests", async () => {
    const { openPortal, readStatus } = setup();
    const customerId = stripeCustomerId();
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    existingPortalConfiguration();
    const url = stripePortalSession();

    const opened = await Promise.all([openPortal(), openPortal()]);
    const status = await readStatus();

    expect(
      opened.map((response) => {
        return response.body;
      }),
    ).toStrictEqual([{ url }, { url }]);
    const sessionCustomers =
      context.mocks.stripe.billingPortal.sessions.create.mock.calls.map(
        ([params]) => {
          return typeof params === "object" &&
            params !== null &&
            "customer" in params
            ? params.customer
            : undefined;
        },
      );
    expect(sessionCustomers).toStrictEqual([customerId, customerId]);
    expect(status).toMatchObject({
      tier: "limited-free-1",
      credits: 0,
      concurrencyLimit: 2,
      restrictedBuiltInModels: true,
    });
  });

  it("billing-customer-publication-006 propagates provider failure without a winner and accepts another normal portal request", async () => {
    marketingCheckinCampaign(context);
    const { openPortal, readStatus, checkIn } = setup();
    await checkIn();
    const before = await readStatus();
    context.mocks.stripe.customers.create
      .mockRejectedValueOnce(new Error("Stripe customer creation failed"))
      .mockResolvedValue({ id: stripeCustomerId() });
    existingPortalConfiguration();
    const url = stripePortalSession();

    await openPortal(500);
    const sessionsAfterFailure =
      context.mocks.stripe.billingPortal.sessions.create.mock.calls.length;
    const after = await readStatus();
    const retried = await openPortal();

    expect(sessionsAfterFailure).toBe(0);
    expect(after).toStrictEqual(before);
    expect(retried.body).toStrictEqual({ url });
  });
});
