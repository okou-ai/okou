import { randomUUID } from "node:crypto";
import type StripeSDK from "stripe";
import {
  billingPortalContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { billingPortalRoutes } from "../billing-portal";
import { billingStatusRoutes } from "../billing-status";
import { getStartedRoutes } from "../get-started";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const secret = "whsec_metadata_binding";
const { default: ActualStripeSDK } = await vi.importActual<{
  default: typeof StripeSDK;
}>("stripe");
const returnUrl = "http://localhost:3002/settings/billing";
const portalUrl = "https://billing.stripe.com/session/metadata-binding";

function clients() {
  const app = setupApp({
    context,
    routes: [
      ...webhooksStripeRoutes,
      ...billingStatusRoutes,
      ...getStartedRoutes,
      ...billingPortalRoutes,
    ],
  });
  return {
    webhook: app(webhookStripeContract),
    status: app(billingStatusContract),
    checkin: app(getStartedContract),
    portal: app(billingPortalContract),
  };
}

function signIn() {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  mocks.clerk.session(userId, orgId, "org:admin");
  return { orgId, userId };
}

function subscriptionCreated(customerId: string) {
  const stripe = new ActualStripeSDK("sk_test_metadata_binding");
  // A genuine add-on subscription has no Plan item. Its creation reaches the
  // metadata binder without a paid Plan invoice granting credits afterwards.
  const event = {
    id: `evt_${randomUUID()}`,
    object: "event",
    created: Math.floor(now() / 1000),
    type: "customer.subscription.created",
    data: {
      object: {
        id: `sub_${randomUUID()}`,
        object: "subscription",
        customer: customerId,
        status: "active",
        metadata: {},
        items: {
          data: [
            {
              id: `si_${randomUUID()}`,
              price: { id: "price_bdd_concurrency" },
              quantity: 1,
            },
          ],
        },
      },
    },
  };
  const body = JSON.stringify(event);
  return clients().webhook.post({
    body,
    extraHeaders: {
      "stripe-signature": stripe.webhooks.generateTestHeaderString({
        payload: body,
        secret,
      }),
    },
  });
}

beforeEach(() => {
  const stripe = new ActualStripeSDK("sk_test_metadata_binding");
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", secret);
  context.mocks.stripe.webhooks.constructEventAsync.mockImplementation(
    (body, signature, webhookSecret) => {
      return stripe.webhooks.constructEvent(
        String(body),
        String(signature),
        String(webhookSecret),
      );
    },
  );
  context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
    data: [],
  });
  context.mocks.stripe.billingPortal.configurations.create.mockResolvedValue({
    id: "bpc_metadata_binding",
  });
  context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
    url: portalUrl,
  });
});

test("initializes a fresh customer metadata Plan and replays without another provider lookup", async () => {
  const { orgId } = signIn();
  const customerId = `cus_${randomUUID()}`;
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    metadata: { orgId },
  });
  await accept(subscriptionCreated(customerId), [200]);
  expect(context.mocks.stripe.customers.retrieve).toHaveBeenCalledTimes(1);
  const status = await accept(clients().status.get({ headers }), [200]);
  expect(status.body).toMatchObject({
    tier: "limited-free-1",
    credits: 0,
    concurrencyLimit: 2,
    canBuyCredits: false,
    canBuyConcurrency: false,
    showUsagePack: false,
    autoRechargeAllowed: false,
    restrictedBuiltInModels: true,
  });
  context.mocks.stripe.customers.retrieve.mockRejectedValue(
    new Error("known customers need no lookup"),
  );
  await accept(subscriptionCreated(customerId), [200]);
  expect(context.mocks.stripe.customers.retrieve).toHaveBeenCalledTimes(1);
  expect(
    (await accept(clients().status.get({ headers }), [200])).body,
  ).toStrictEqual(status.body);
});

test("preserves a check-in Plan and reward and skips lazy Clerk existence lookup", async () => {
  const { orgId } = signIn();
  const api = clients();
  const checkin = await accept(api.checkin.checkin({ headers }), [200]);
  const before = await accept(api.status.get({ headers }), [200]);
  const customerId = `cus_${randomUUID()}`;
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    metadata: { orgId },
  });
  context.mocks.clerk.organizations.getOrganization.mockRejectedValue(
    new Error("existing metadata needs no Clerk lookup"),
  );
  await accept(subscriptionCreated(customerId), [200]);
  expect(
    context.mocks.clerk.organizations.getOrganization,
  ).not.toHaveBeenCalled();
  expect((await accept(api.status.get({ headers }), [200])).body).toStrictEqual(
    before.body,
  );
  expect(
    (await accept(api.checkin.checkin({ headers }), [200])).body,
  ).toStrictEqual(checkin.body);
});

test("keeps a different published customer and the complete public Plan unchanged", async () => {
  const { orgId } = signIn();
  const api = clients();
  const existingCustomer = `cus_${randomUUID()}`;
  context.mocks.stripe.customers.create.mockResolvedValue({
    id: existingCustomer,
  });
  await accept(api.portal.create({ headers, body: { returnUrl } }), [200]);
  const before = await accept(api.status.get({ headers }), [200]);
  const incomingCustomer = `cus_${randomUUID()}`;
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: incomingCustomer,
    metadata: { orgId },
  });
  await accept(subscriptionCreated(incomingCustomer), [200]);
  expect((await accept(api.status.get({ headers }), [200])).body).toStrictEqual(
    before.body,
  );
  await accept(api.portal.create({ headers, body: { returnUrl } }), [200]);
  expect(
    context.mocks.stripe.billingPortal.sessions.create,
  ).toHaveBeenLastCalledWith({
    customer: existingCustomer,
    configuration: "bpc_metadata_binding",
    return_url: returnUrl,
  });
  expect(context.mocks.stripe.customers.create).toHaveBeenCalledTimes(1);
});

test.each(["deleted", "missing metadata"] as const)(
  "ignores a %s customer and preserves the public Plan",
  async (outcome) => {
    signIn();
    const api = clients();
    await accept(api.checkin.checkin({ headers }), [200]);
    const before = await accept(api.status.get({ headers }), [200]);
    const customerId = `cus_${randomUUID()}`;
    context.mocks.stripe.customers.retrieve.mockResolvedValue(
      outcome === "deleted"
        ? { id: customerId, deleted: true }
        : { id: customerId, metadata: {} },
    );
    await accept(subscriptionCreated(customerId), [200]);
    expect(
      (await accept(api.status.get({ headers }), [200])).body,
    ).toStrictEqual(before.body);
    expect(context.mocks.stripe.customers.retrieve).toHaveBeenCalledWith(
      customerId,
    );
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
  },
);

test.each([
  { statusCode: 404 },
  { code: "NOT_FOUND" },
  { name: "NotFoundError" },
])(
  "ignores Clerk's explicit missing organization response %j",
  async (error) => {
    const { orgId } = signIn();
    const customerId = `cus_${randomUUID()}`;
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId },
    });
    context.mocks.clerk.organizations.getOrganization.mockRejectedValue(error);
    await accept(subscriptionCreated(customerId), [200]);
    const publishedCustomer = `cus_${randomUUID()}`;
    context.mocks.stripe.customers.create.mockResolvedValue({
      id: publishedCustomer,
    });
    await accept(
      clients().portal.create({ headers, body: { returnUrl } }),
      [200],
    );
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenLastCalledWith({
      customer: publishedCustomer,
      configuration: "bpc_metadata_binding",
      return_url: returnUrl,
    });
  },
);

test("propagates a Clerk dependency error and accepts a later signed delivery", async () => {
  const { orgId } = signIn();
  const customerId = `cus_${randomUUID()}`;
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    metadata: { orgId },
  });
  context.mocks.clerk.organizations.getOrganization.mockRejectedValueOnce(
    new Error("Clerk unavailable"),
  );
  await expect(subscriptionCreated(customerId)).rejects.toThrow(
    "Unknown response status 500 for POST /api/webhooks/stripe",
  );
  await accept(subscriptionCreated(customerId), [200]);
  expect(
    (await accept(clients().status.get({ headers }), [200])).body,
  ).toMatchObject({ tier: "limited-free-1", credits: 0, concurrencyLimit: 2 });
});
