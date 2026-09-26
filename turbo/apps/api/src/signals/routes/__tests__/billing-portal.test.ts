import { randomUUID } from "node:crypto";

import { billingPortalContract } from "@okouai/api-contracts/contracts/billing";
import { createStore } from "ccstate";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  deleteInvoicesOrg$,
  seedInvoicesOrg$,
  type InvoicesOrgFixture,
} from "./helpers/billing-invoices";
import {
  createBillingWebhookFixture,
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { billingPortalRoutes } from "../billing-portal";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);

const APP_ORIGIN = "http://app.localhost:3002";
const PORTAL_CONFIGURATION_ID = "bpc_payment_methods";
const RESTRICTED_PORTAL_CONFIGURATION = {
  id: PORTAL_CONFIGURATION_ID,
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
} as const;

describe("POST /api/billing/portal", () => {
  const track = createFixtureTracker<InvoicesOrgFixture>((fixture) => {
    return store.set(deleteInvoicesOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
      data: [RESTRICTED_PORTAL_CONFIGURATION],
    });
  });

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: billingPortalRoutes })(
      billingPortalContract,
    );
    const response = await accept(
      client.create({
        body: { returnUrl: `${APP_ORIGIN}/settings` },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Billing not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: billingPortalRoutes })(
      billingPortalContract,
    );

    const response = await accept(
      client.create({
        body: { returnUrl: `${APP_ORIGIN}/settings` },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 400 when returnUrl is missing", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: billingPortalRoutes })(
      billingPortalContract,
    );
    const response = await accept(
      client.create({
        body: {} as never,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error).toBeDefined();
  });

  it("returns 400 when returnUrl is not a valid URL", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context, routes: billingPortalRoutes })(
      billingPortalContract,
    );
    const response = await accept(
      client.create({
        body: { returnUrl: "not-a-url" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error).toBeDefined();
  });

  it("returns 403 for a non-admin org member", async () => {
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );

    const client = setupApp({ context, routes: billingPortalRoutes })(
      billingPortalContract,
    );
    const response = await accept(
      client.create({
        body: { returnUrl: `${APP_ORIGIN}/settings` },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can manage billing",
        code: "FORBIDDEN",
      },
    });
  });

  it.each([
    `${APP_ORIGIN}/settings/billing`,
    "https://okou.ai/settings/billing",
    "https://console.okou.ai/settings/billing",
    "https://pr-22085-app.omby.ai/settings/billing",
  ])("returns portal URL to the allowed origin %s", async (returnUrl) => {
    const customerId = `cus-portal-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: `sub-portal-${randomUUID().slice(0, 8)}`,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
      url: "https://billing.stripe.com/session/test",
    });

    const client = setupApp({ context, routes: billingPortalRoutes })(
      billingPortalContract,
    );
    const response = await accept(
      client.create({
        body: { returnUrl },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://billing.stripe.com/session/test",
    });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith({
      customer: fixture.stripeCustomerId,
      configuration: PORTAL_CONFIGURATION_ID,
      return_url: returnUrl,
    });
  });

  it("reuses the payment method portal despite unrelated stored metadata", async () => {
    const customerId = `cus-portal-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: `sub-portal-${randomUUID().slice(0, 8)}`,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
      data: [
        {
          ...RESTRICTED_PORTAL_CONFIGURATION,
          metadata: {
            ...RESTRICTED_PORTAL_CONFIGURATION.metadata,
            retired_marker: "present",
          },
        },
      ],
    });
    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
      url: "https://billing.stripe.com/session/manage-billing",
    });

    const returnUrl = `${APP_ORIGIN}/settings/billing`;
    const response = await accept(
      setupApp({ context, routes: billingPortalRoutes })(
        billingPortalContract,
      ).create({
        body: { returnUrl },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://billing.stripe.com/session/manage-billing",
    });
    expect(
      context.mocks.stripe.billingPortal.configurations.list,
    ).toHaveBeenCalledWith({ limit: 100 });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith({
      customer: customerId,
      configuration: PORTAL_CONFIGURATION_ID,
      return_url: returnUrl,
    });
  });

  it.each([
    [
      "multiple purpose matches",
      {
        data: [
          RESTRICTED_PORTAL_CONFIGURATION,
          { ...RESTRICTED_PORTAL_CONFIGURATION, id: "bpc_another" },
        ],
      },
    ],
    [
      "an incomplete configuration list",
      { data: [RESTRICTED_PORTAL_CONFIGURATION], has_more: true },
    ],
  ] as const)("does not open a portal with %s", async (_reason, listed) => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(userId, orgId, "org:admin");
    context.mocks.stripe.customers.create.mockResolvedValue({
      id: `cus-portal-${randomUUID().slice(0, 8)}`,
    });
    context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue(
      listed,
    );

    const response = await accept(
      setupApp({ context, routes: billingPortalRoutes })(
        billingPortalContract,
      ).create({
        body: { returnUrl: `${APP_ORIGIN}/settings/billing` },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [500],
    );
    expect(response.status).toBe(500);
    expect(
      context.mocks.stripe.billingPortal.configurations.list,
    ).toHaveBeenCalledWith({ limit: 100 });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("creates a customer for payment method management without a subscription", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const customerId = `cus-portal-${randomUUID().slice(0, 8)}`;
    const returnUrl = `${APP_ORIGIN}/settings/billing`;
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(userId, orgId, "org:admin");
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
      data: [],
    });
    context.mocks.stripe.billingPortal.configurations.create.mockResolvedValue({
      id: PORTAL_CONFIGURATION_ID,
    });
    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
      url: "https://billing.stripe.com/session/payment-method",
    });

    const response = await accept(
      setupApp({ context, routes: billingPortalRoutes })(
        billingPortalContract,
      ).create({
        body: { returnUrl },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://billing.stripe.com/session/payment-method",
    });
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith({
      metadata: { orgId },
    });
    expect(
      context.mocks.stripe.billingPortal.configurations.create,
    ).toHaveBeenCalledWith(
      {
        name: "Okou payment methods",
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
      { idempotencyKey: "payment-method-portal-v2" },
    );
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith({
      customer: customerId,
      configuration: PORTAL_CONFIGURATION_ID,
      return_url: returnUrl,
    });
  });

  it("repairs a managed portal configuration before creating a session", async () => {
    const customerId = `cus-portal-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: `sub-portal-${randomUUID().slice(0, 8)}`,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.billingPortal.configurations.list.mockResolvedValue({
      data: [
        {
          ...RESTRICTED_PORTAL_CONFIGURATION,
          features: {
            ...RESTRICTED_PORTAL_CONFIGURATION.features,
            subscription_cancel: { enabled: true },
          },
        },
      ],
    });
    context.mocks.stripe.billingPortal.configurations.update.mockResolvedValue({
      id: PORTAL_CONFIGURATION_ID,
    });
    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
      url: "https://billing.stripe.com/session/restricted",
    });

    const response = await accept(
      setupApp({ context, routes: billingPortalRoutes })(
        billingPortalContract,
      ).create({
        body: {
          returnUrl: `${APP_ORIGIN}/settings/billing`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://billing.stripe.com/session/restricted",
    });
    expect(
      context.mocks.stripe.billingPortal.configurations.update,
    ).toHaveBeenCalledWith(PORTAL_CONFIGURATION_ID, {
      active: true,
      name: "Okou payment methods",
      features: {
        customer_update: { enabled: false },
        invoice_history: { enabled: false },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: false },
        subscription_update: { enabled: false },
      },
      login_page: { enabled: false },
      metadata: { purpose: "payment_method_management" },
    });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith({
      customer: customerId,
      configuration: PORTAL_CONFIGURATION_ID,
      return_url: `${APP_ORIGIN}/settings/billing`,
    });
  });

  it("returns a portal URL for an allowance-only org", async () => {
    const fixture = createBillingWebhookFixture();
    const customerId = generatedStripeCustomerId();
    await postUsageAllowanceInvoicePaid(context.signal, {
      ...fixture,
      customerId,
      subscriptionId: generatedStripeSubscriptionId(),
      shortWindowSeconds: 18_000,
      shortWindowUnits: 5000,
      weeklyWindowSeconds: 604_800,
      weeklyWindowUnits: 50_000,
      effectiveAt: new Date("2026-01-01T00:00:00Z"),
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
      url: "https://billing.stripe.com/session/allowance",
    });

    const response = await accept(
      setupApp({ context, routes: billingPortalRoutes })(
        billingPortalContract,
      ).create({
        body: {
          returnUrl: `${APP_ORIGIN}/settings/billing`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://billing.stripe.com/session/allowance",
    });
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).toHaveBeenCalledWith({
      customer: customerId,
      configuration: PORTAL_CONFIGURATION_ID,
      return_url: `${APP_ORIGIN}/settings/billing`,
    });
  });

  it.each([
    "https://evil.example.com/settings/billing",
    "https://okou.ai.evil.example/settings/billing",
  ])("returns 400 for the disallowed origin in %s", async (returnUrl) => {
    mockEnv("APP_URL", APP_ORIGIN);
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:admin",
    );

    const client = setupApp({ context, routes: billingPortalRoutes })(
      billingPortalContract,
    );
    const response = await accept(
      client.create({
        body: { returnUrl },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "returnUrl must match the platform origin",
        code: "BAD_REQUEST",
      },
    });
  });
});
