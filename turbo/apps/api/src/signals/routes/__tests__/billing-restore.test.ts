import { randomUUID } from "node:crypto";

import {
  billingAutoRechargeContract,
  billingRestoreContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { createStore } from "ccstate";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  deleteInvoicesOrg$,
  seedInvoicesOrg$,
  type InvoicesOrgFixture,
} from "./helpers/billing-invoices";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { billingAutoRechargeRoutes } from "../billing-auto-recharge";
import { billingRestoreRoutes } from "../billing-restore";
import { billingStatusRoutes } from "../billing-status";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);

function mockSubscriptionWithPaymentMethod(
  subId: string,
  customerId: string,
): void {
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
    id: subId,
    customer: customerId,
    default_payment_method: "pm_test",
  });
}

async function readBillingStatus() {
  return await accept(
    setupApp({ context, routes: billingStatusRoutes })(
      billingStatusContract,
    ).get({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
}

describe("POST /api/billing/restore", () => {
  const track = createFixtureTracker<InvoicesOrgFixture>((fixture) => {
    return store.set(deleteInvoicesOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    mockOptionalEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  });

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);

    const client = setupApp({ context, routes: billingRestoreRoutes })(
      billingRestoreContract,
    );
    const response = await accept(
      client.create({
        body: {},
        headers: {},
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
    const client = setupApp({ context, routes: billingRestoreRoutes })(
      billingRestoreContract,
    );
    const response = await accept(
      client.create({
        body: {},
        headers: {},
      }),
      [401],
    );

    expect(response.status).toBe(401);
  });

  it("returns 403 for non-admin org member", async () => {
    const fixture = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context, routes: billingRestoreRoutes })(
      billingRestoreContract,
    );
    const response = await accept(
      client.create({
        body: {},
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

  it("returns 409 when org has no subscription", async () => {
    const fixture = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: billingRestoreRoutes })(
      billingRestoreContract,
    );
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Org has no active subscription",
        code: "CONFLICT",
      },
    });
  });

  it("returns 409 when subscription is not scheduled for cancellation", async () => {
    const subId = `sub-not-scheduled-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          cancelAtPeriodEnd: false,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: billingRestoreRoutes })(
      billingRestoreContract,
    );
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Subscription has no scheduled billing change",
        code: "CONFLICT",
      },
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("restores a subscription scheduled for cancellation", async () => {
    const subId = `sub-restore-${randomUUID().slice(0, 8)}`;
    const customerId = `cus-restore-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          cancelAtPeriodEnd: true,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockSubscriptionWithPaymentMethod(subId, customerId);
    context.mocks.stripe.subscriptions.update.mockResolvedValue({ id: subId });

    const client = setupApp({ context, routes: billingRestoreRoutes })(
      billingRestoreContract,
    );
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ status: "restored" });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subId,
      { cancel_at_period_end: false },
    );

    const status = await readBillingStatus();
    expect(status.body.cancelAtPeriodEnd).toBeFalsy();
    expect(status.body.scheduledChange).toBeNull();
  });

  it("records a restore that Stripe applied while the organization row was rewritten", async () => {
    const subId = `sub-restore-${randomUUID().slice(0, 8)}`;
    const customerId = `cus-restore-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          cancelAtPeriodEnd: true,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockSubscriptionWithPaymentMethod(subId, customerId);
    // Another organization write (settlement debits and webhooks rewrite the
    // same row) lands while Stripe is applying the restore.
    context.mocks.stripe.subscriptions.update.mockImplementation(async () => {
      await accept(
        setupApp({ context, routes: billingAutoRechargeRoutes })(
          billingAutoRechargeContract,
        ).update({
          headers: { authorization: "Bearer clerk-session" },
          body: { enabled: false, threshold: 1000, amount: 5000 },
        }),
        [200],
      );
      return { id: subId };
    });

    const response = await accept(
      setupApp({ context, routes: billingRestoreRoutes })(
        billingRestoreContract,
      ).create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ status: "restored" });
    const status = await readBillingStatus();
    expect(status.body.cancelAtPeriodEnd).toBeFalsy();
    expect(status.body.scheduledChange).toBeNull();
  });

  it("restores a scheduled downgrade by releasing its subscription schedule", async () => {
    const subId = `sub-restore-schedule-${randomUUID().slice(0, 8)}`;
    const scheduleId = `sched-restore-${randomUUID().slice(0, 8)}`;
    const customerId = `cus-restore-schedule-${randomUUID().slice(0, 8)}`;
    const changeAt = new Date("2099-07-04T00:00:00Z");
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
          cancelAtPeriodEnd: false,
          pendingSubscriptionScheduleId: scheduleId,
          pendingSubscriptionTargetTier: "pro",
          pendingSubscriptionChangeAt: changeAt,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockSubscriptionWithPaymentMethod(subId, customerId);
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValue({
      id: scheduleId,
    });

    const client = setupApp({ context, routes: billingRestoreRoutes })(
      billingRestoreContract,
    );
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ status: "restored" });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    const status = await readBillingStatus();
    expect(status.body.cancelAtPeriodEnd).toBeFalsy();
    expect(status.body.scheduledChange).toBeNull();
  });

  it("uses the request brand fallback and preserves an explicit return URL when restore requires a payment method", async () => {
    const subId = `sub-restore-card-${randomUUID().slice(0, 8)}`;
    const customerId = `cus-restore-card-${randomUUID().slice(0, 8)}`;
    const okouFallbackReturnUrl = "https://app.okou.ai";
    const explicitReturnUrl = "https://app.okou.ai/settings/billing";
    const checkoutUrl = "https://checkout.stripe.com/setup/restore";
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          cancelAtPeriodEnd: true,
        },
        context.signal,
      ),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      customer: customerId,
      default_payment_method: null,
      default_source: null,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      deleted: false,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: checkoutUrl,
    });

    const client = setupApp({ context, routes: billingRestoreRoutes })(
      billingRestoreContract,
    );
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
        extraHeaders: { origin: "https://app.okou.ai" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "payment_method_required",
      checkoutUrl,
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "setup",
      customer: customerId,
      currency: "usd",
      success_url: okouFallbackReturnUrl,
      cancel_url: okouFallbackReturnUrl,
      metadata: {
        purpose: "billing_restore",
        orgId: fixture.orgId,
        subscriptionId: subId,
      },
      setup_intent_data: {
        metadata: {
          purpose: "billing_restore",
          orgId: fixture.orgId,
          subscriptionId: subId,
        },
      },
    });
    context.mocks.stripe.checkout.sessions.create.mockClear();
    const explicitResponse = await accept(
      client.create({
        body: { returnUrl: explicitReturnUrl },
        headers: { authorization: "Bearer clerk-session" },
        extraHeaders: { origin: "https://app.okou.ai" },
      }),
      [200],
    );
    expect(explicitResponse.body).toStrictEqual(response.body);
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: explicitReturnUrl,
        cancel_url: explicitReturnUrl,
      }),
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});
