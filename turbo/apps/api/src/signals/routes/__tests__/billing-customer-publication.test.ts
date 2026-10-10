import { randomUUID } from "node:crypto";

import {
  billingPortalContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { billingPortalRoutes } from "../billing-portal";
import { billingStatusRoutes } from "../billing-status";
import { getStartedRoutes } from "../get-started";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const returnUrl = "http://app.localhost:3002/settings/billing";
const portalUrl = "https://billing.stripe.com/session/customer-publication";

function clients() {
  const app = setupApp({
    context,
    routes: [
      ...billingPortalRoutes,
      ...billingStatusRoutes,
      ...getStartedRoutes,
    ],
  });
  return {
    portal: app(billingPortalContract),
    status: app(billingStatusContract),
    getStarted: app(getStartedContract),
  };
}

function signIn() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId, "org:admin");
  return { userId, orgId };
}

beforeEach(() => {
  mockEnv("APP_URL", "http://app.localhost:3002");
  context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
    data: [],
  });
  context.mocks.stripe.billingPortal.configurations.create.mockResolvedValue({
    id: "bpc_customer_publication",
  });
  context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
    url: portalUrl,
  });
});

test("initializes the default Plan through a fresh payment-method portal and reuses its customer", async () => {
  const { orgId } = signIn();
  const customerId = `cus_${randomUUID()}`;
  context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
  const api = clients();
  const open = () => {
    return accept(api.portal.create({ headers, body: { returnUrl } }), [200]);
  };
  expect((await open()).body).toStrictEqual({ url: portalUrl });
  const status = await accept(api.status.get({ headers }), [200]);
  expect(status.body).toMatchObject({
    tier: "limited-free-1",
    status: "active",
    credits: 0,
    concurrencyLimit: 2,
    canBuyCredits: false,
    canBuyConcurrency: false,
    showUsagePack: false,
    autoRechargeAllowed: false,
    restrictedBuiltInModels: true,
    workflowWebhookAutomationAllowed: false,
    hasSubscription: false,
  });
  context.mocks.stripe.customers.create.mockResolvedValue({
    id: `cus_unused_${randomUUID()}`,
  });
  expect((await open()).body).toStrictEqual({ url: portalUrl });
  expect(context.mocks.stripe.customers.create).toHaveBeenCalledTimes(1);
  expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith(
    { metadata: { orgId } },
    { idempotencyKey: `stripe-customer:development::${orgId}` },
  );
  expect(
    context.mocks.stripe.billingPortal.sessions.create,
  ).toHaveBeenLastCalledWith({
    customer: customerId,
    configuration: "bpc_customer_publication",
    return_url: returnUrl,
  });
  expect((await accept(api.status.get({ headers }), [200])).body).toStrictEqual(
    status.body,
  );
});

test("binds an organization initialized by a check-in while preserving its Plan and reward", async () => {
  signIn();
  const api = clients();
  const checkin = await accept(api.getStarted.checkin({ headers }), [200]);
  const before = await accept(api.status.get({ headers }), [200]);
  const customerId = `cus_${randomUUID()}`;
  context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
  expect(
    (await accept(api.portal.create({ headers, body: { returnUrl } }), [200]))
      .body,
  ).toStrictEqual({ url: portalUrl });
  expect((await accept(api.status.get({ headers }), [200])).body).toStrictEqual(
    before.body,
  );
  expect(
    (await accept(api.getStarted.checkin({ headers }), [200])).body,
  ).toStrictEqual(checkin.body);
  expect(
    context.mocks.stripe.billingPortal.sessions.create,
  ).toHaveBeenCalledWith({
    customer: customerId,
    configuration: "bpc_customer_publication",
    return_url: returnUrl,
  });
});

test("publishes one authoritative customer for concurrent fresh portal requests", async () => {
  signIn();
  const customerId = `cus_${randomUUID()}`;
  context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
  const api = clients();
  const opened = await Promise.all([
    api.portal.create({ headers, body: { returnUrl } }),
    api.portal.create({ headers, body: { returnUrl } }),
  ]);
  for (const response of opened) {
    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ url: portalUrl });
  }
  expect(
    context.mocks.stripe.billingPortal.sessions.create,
  ).toHaveBeenCalledTimes(2);
  for (const [session] of context.mocks.stripe.billingPortal.sessions.create
    .mock.calls) {
    expect(session).toMatchObject({ customer: customerId });
  }
  expect((await accept(api.status.get({ headers }), [200])).body).toMatchObject(
    {
      tier: "limited-free-1",
      credits: 0,
      concurrencyLimit: 2,
      restrictedBuiltInModels: true,
    },
  );
});

test("preserves an organization check-in completed during external customer preparation", async () => {
  signIn();
  const api = clients();
  const customerId = `cus_${randomUUID()}`;
  context.mocks.stripe.customers.create.mockImplementationOnce(async () => {
    await accept(api.getStarted.checkin({ headers }), [200]);
    return { id: customerId };
  });
  await accept(api.portal.create({ headers, body: { returnUrl } }), [200]);
  expect(
    (await accept(api.getStarted.status({ headers }), [200])).body,
  ).toMatchObject({
    claimedToday: true,
    checkinStreak: 1,
  });
  expect((await accept(api.status.get({ headers }), [200])).body).toMatchObject(
    {
      tier: "limited-free-1",
      credits: 0,
      concurrencyLimit: 2,
    },
  );
  expect(
    context.mocks.stripe.billingPortal.sessions.create,
  ).toHaveBeenCalledWith({
    customer: customerId,
    configuration: "bpc_customer_publication",
    return_url: returnUrl,
  });
});

test("uses a concurrently committed customer after losing the provider response", async () => {
  signIn();
  const api = clients();
  const customerId = `cus_${randomUUID()}`;
  context.mocks.stripe.customers.create
    .mockImplementationOnce(async () => {
      await accept(api.portal.create({ headers, body: { returnUrl } }), [200]);
      throw new Error("Customer response was lost");
    })
    .mockResolvedValue({ id: customerId });
  expect(
    (await accept(api.portal.create({ headers, body: { returnUrl } }), [200]))
      .body,
  ).toStrictEqual({ url: portalUrl });
  expect(
    context.mocks.stripe.billingPortal.sessions.create,
  ).toHaveBeenCalledTimes(2);
  for (const [session] of context.mocks.stripe.billingPortal.sessions.create
    .mock.calls) {
    expect(session).toMatchObject({ customer: customerId });
  }
  expect((await accept(api.status.get({ headers }), [200])).body).toMatchObject(
    {
      tier: "limited-free-1",
      credits: 0,
      concurrencyLimit: 2,
    },
  );
});

test("propagates provider failure without a winner and accepts another normal portal request", async () => {
  signIn();
  const api = clients();
  await accept(api.getStarted.checkin({ headers }), [200]);
  const before = await accept(api.status.get({ headers }), [200]);
  context.mocks.stripe.customers.create.mockRejectedValueOnce(
    new Error("Stripe unavailable"),
  );
  const failed = await accept(
    api.portal.create({ headers, body: { returnUrl } }),
    [500],
  );
  expect(failed.status).toBe(500);
  expect(
    context.mocks.stripe.billingPortal.sessions.create,
  ).not.toHaveBeenCalled();
  expect((await accept(api.status.get({ headers }), [200])).body).toStrictEqual(
    before.body,
  );
  context.mocks.stripe.customers.create.mockResolvedValue({
    id: `cus_${randomUUID()}`,
  });
  expect(
    (await accept(api.portal.create({ headers, body: { returnUrl } }), [200]))
      .body,
  ).toStrictEqual({ url: portalUrl });
});

test("retains the preview routing metadata and provider idempotency identity", async () => {
  const { orgId } = signIn();
  mockEnv("ENV", "preview");
  mockOptionalEnv("OKOU_PREVIEW_JOB_REF", "pr-tx0062");
  context.mocks.stripe.customers.create.mockResolvedValue({
    id: `cus_${randomUUID()}`,
  });
  await accept(
    clients().portal.create({ headers, body: { returnUrl } }),
    [200],
  );
  expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith(
    { metadata: { orgId, vm0_environment: "preview", job_ref: "pr-tx0062" } },
    { idempotencyKey: `stripe-customer:preview:pr-tx0062:${orgId}` },
  );
});
