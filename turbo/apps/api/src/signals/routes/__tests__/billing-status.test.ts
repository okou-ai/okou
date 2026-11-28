import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { apiTestEnvironment } from "../../../__tests__/test-environment";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { billingStatusRoutes } from "../billing-status";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";
import {
  createBillingWebhookFixture,
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postBillingDowngradeCheckoutCompleted,
  postConcurrencyEntitlementsInvoicePaid,
  postCreditPurchaseInvoicePaid,
  postSubscriptionInvoicePaid,
  TEST_PRICE_CONCURRENCY,
  type BillingWebhookFixture,
} from "./helpers/stripe-billing-webhook";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const app = setupApp({
  context,
  routes: [
    ...billingStatusRoutes,
    ...onboardingCompleteRoutes,
    ...webhooksStripeRoutes,
  ],
});
const billingStatus = app(billingStatusContract);
const onboardingComplete = app(onboardingCompleteContract);
const stripeWebhook = app(webhookStripeContract);

function signIn(
  actor: BillingWebhookFixture,
  role: "org:admin" | "org:member" = "org:admin",
): void {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId, role);
}

function disableStripeBilling(): void {
  mockOptionalEnv("STRIPE_SECRET_KEY", undefined);
}

async function readBillingStatus() {
  return (await accept(billingStatus.get({ headers }), [200])).body;
}

async function completeOnboarding(actor: BillingWebhookFixture): Promise<void> {
  mockClerkUsers(context, [{ id: actor.userId, createdAt: 0 }]);
  signIn(actor);
  await accept(onboardingComplete.complete({ headers, body: {} }), [200]);
}

async function deliverStripeEvent(
  event: Readonly<Record<string, unknown>>,
): Promise<void> {
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_billing_status_test");
  const stripeEvent = {
    id: `evt_${randomUUID()}`,
    created: Math.floor(now() / 1000),
    ...event,
  };
  context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
    stripeEvent,
  );
  await accept(
    stripeWebhook.post({
      body: JSON.stringify(stripeEvent),
      extraHeaders: { "stripe-signature": "t=1,v1=billing-status-test" },
    }),
    [200],
  );
}

describe("GET /api/billing/status", () => {
  it("billing-status-018 returns 200 for a non-admin member", async () => {
    const actor = createBillingWebhookFixture();
    await postCreditPurchaseInvoicePaid(context.signal, {
      orgId: actor.orgId,
      credits: 100_000,
    });
    disableStripeBilling();
    signIn(actor, "org:member");

    const response = await accept(billingStatus.get({ headers }), [200]);

    expect(response.status).toBe(200);
    expect(response.body.credits).toBe(100_000);
  });

  it("billing-status-004 returns billing status for an authenticated user without a subscription", async () => {
    const actor = createBillingWebhookFixture();
    await postCreditPurchaseInvoicePaid(context.signal, {
      orgId: actor.orgId,
      credits: 100_000,
    });
    disableStripeBilling();
    signIn(actor);

    await expect(readBillingStatus()).resolves.toMatchObject({
      tier: "limited-free-1",
      status: "active",
      concurrencyLimit: 2,
      restrictedBuiltInModels: true,
      credits: 100_000,
      onboardingPaymentPending: false,
      hasSubscription: false,
      subscriptionStatus: null,
      currentPeriodEnd: null,
    });
  });

  it("billing-status-003 keeps billing status isolated across successive organization requests", async () => {
    const orgA = createBillingWebhookFixture();
    const orgB = createBillingWebhookFixture();
    await completeOnboarding(orgA);
    await completeOnboarding(orgB);
    await postSubscriptionInvoicePaid(context.signal, {
      ...orgA,
      tier: "pro",
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      currentPeriodEnd: new Date("2099-04-20T00:00:00.000Z"),
    });
    await postSubscriptionInvoicePaid(context.signal, {
      ...orgB,
      tier: "team",
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      currentPeriodEnd: new Date("2099-04-20T00:00:00.000Z"),
    });
    disableStripeBilling();

    signIn(orgA);
    const firstA = await readBillingStatus();
    signIn(orgB);
    const responseB = await readBillingStatus();
    signIn(orgA);
    const secondA = await readBillingStatus();

    expect(firstA).toMatchObject({ tier: "pro", status: "active" });
    expect(responseB).toMatchObject({ tier: "team", status: "active" });
    expect(secondA).toMatchObject({ tier: "pro", status: "active" });
  });

  it("billing-status-006 returns billing status for a subscribed organization", async () => {
    const actor = createBillingWebhookFixture();
    const periodEnd = new Date("2099-04-20T00:00:00.000Z");
    await postSubscriptionInvoicePaid(context.signal, {
      ...actor,
      tier: "pro",
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      currentPeriodEnd: periodEnd,
    });
    await postCreditPurchaseInvoicePaid(context.signal, {
      orgId: actor.orgId,
      credits: 80_000,
    });
    disableStripeBilling();
    signIn(actor);

    await expect(readBillingStatus()).resolves.toMatchObject({
      tier: "pro",
      status: "active",
      credits: 100_000,
      subscriptionStatus: "active",
      currentPeriodEnd: periodEnd.toISOString(),
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      canRestorePlan: false,
      hasSubscription: true,
    });
  });

  it("billing-status-007 does not report a canceled plan as an active subscription", async () => {
    const actor = createBillingWebhookFixture();
    await postSubscriptionInvoicePaid(context.signal, {
      ...actor,
      tier: "pro",
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      status: "canceled",
      currentPeriodEnd: new Date("2099-04-20T00:00:00.000Z"),
    });
    disableStripeBilling();
    signIn(actor);

    await expect(readBillingStatus()).resolves.toMatchObject({
      subscriptionStatus: "canceled",
      hasSubscription: false,
    });
  });

  it("billing-status-009 reflects normal subscription activation and cancellation without enabling package controls", async () => {
    const actor = createBillingWebhookFixture();
    const customerId = generatedStripeCustomerId();
    const subscriptionId = generatedStripeSubscriptionId();
    const proPriceId = apiTestEnvironment.OKOU_PRICE_PRO;
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: actor.orgId },
    });
    const baseSubscription = {
      id: subscriptionId,
      customer: customerId,
      metadata: {},
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      items: {
        data: [{ price: { id: proPriceId } }],
      },
    };
    await deliverStripeEvent({
      type: "customer.subscription.created",
      data: {
        object: {
          ...baseSubscription,
          status: "active",
        },
      },
    });
    disableStripeBilling();
    signIn(actor);

    const activeStatus = await readBillingStatus();

    await deliverStripeEvent({
      type: "customer.subscription.updated",
      data: {
        object: {
          ...baseSubscription,
          status: "canceled",
        },
      },
    });
    const canceledStatus = await readBillingStatus();

    expect(activeStatus).toMatchObject({
      status: "active",
      showUsagePack: false,
    });
    expect(canceledStatus).toMatchObject({
      status: "suspended",
      showUsagePack: false,
    });
  });

  it("billing-status-013 returns Team capabilities and the current Stripe concurrency price", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "3");
    const actor = createBillingWebhookFixture();
    await completeOnboarding(actor);
    await postSubscriptionInvoicePaid(context.signal, {
      ...actor,
      tier: "team",
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      currentPeriodEnd: new Date("2099-04-20T00:00:00.000Z"),
    });
    mockOptionalEnv("STRIPE_SECRET_KEY", apiTestEnvironment.STRIPE_SECRET_KEY);
    context.mocks.stripe.prices.retrieve.mockResolvedValueOnce({
      id: TEST_PRICE_CONCURRENCY,
      active: true,
      currency: "usd",
      unit_amount: 4200,
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
    });
    signIn(actor);

    const withPrice = await readBillingStatus();

    context.mocks.stripe.prices.retrieve.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        code: "resource_missing",
        message: "No such price",
      }),
    );
    const withoutPrice = await readBillingStatus();

    expect(withPrice).toMatchObject({
      tier: "team",
      status: "active",
      canBuyConcurrency: true,
      canBuyCredits: true,
      autoRechargeAllowed: true,
      workflowWebhookAutomationAllowed: true,
      showUsagePack: false,
      restrictedBuiltInModels: false,
      concurrencyLimit: 3,
      concurrencyUnitAmountCents: 4200,
    });
    expect("concurrencyUnitAmountCents" in withoutPrice).toBeFalsy();
  });

  it("billing-status-014 includes active concurrency subscription slots", async () => {
    const actor = createBillingWebhookFixture();
    const customerId = generatedStripeCustomerId();
    const concurrencySubscriptionId = generatedStripeSubscriptionId();
    await postSubscriptionInvoicePaid(context.signal, {
      ...actor,
      tier: "team",
      customerId,
      subscriptionId: generatedStripeSubscriptionId(),
      currentPeriodEnd: new Date("2099-04-20T00:00:00.000Z"),
    });
    await postConcurrencyEntitlementsInvoicePaid(context.signal, {
      ...actor,
      customerId,
      subscriptionId: concurrencySubscriptionId,
      cancelAtPeriodEnd: true,
      lines: [
        {
          slots: 2,
          startsAt: new Date("2099-04-20T00:00:00.000Z"),
          expiresAt: new Date("2099-05-20T00:00:00.000Z"),
        },
        {
          slots: 1,
          startsAt: new Date("2099-05-20T00:00:00.000Z"),
          expiresAt: new Date("2099-06-20T00:00:00.000Z"),
        },
        {
          slots: 5,
          startsAt: new Date("2025-12-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
    });
    disableStripeBilling();
    signIn(actor);

    const body = await readBillingStatus();

    expect(body.concurrencyLimit).toBe(13);
    expect(body.concurrencySubscriptions).toStrictEqual([
      {
        id: concurrencySubscriptionId,
        quantity: 3,
        currentPeriodEnd: "2099-06-20T00:00:00.000Z",
        cancelAtPeriodEnd: true,
      },
    ]);
  });

  it("billing-status-016 returns cancelAtPeriodEnd and cancel schedule details when set", async () => {
    const actor = createBillingWebhookFixture();
    const periodEnd = new Date("2099-04-20T00:00:00.000Z");
    await postSubscriptionInvoicePaid(context.signal, {
      ...actor,
      tier: "pro",
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true,
    });
    disableStripeBilling();
    signIn(actor);

    await expect(readBillingStatus()).resolves.toMatchObject({
      cancelAtPeriodEnd: true,
      hasSubscription: true,
      scheduledChange: {
        type: "cancel",
        targetTier: "limited-free-1",
        effectiveDate: periodEnd.toISOString(),
      },
      canRestorePlan: true,
    });
  });

  it("billing-status-017 returns scheduled downgrade details when set", async () => {
    const actor = createBillingWebhookFixture();
    const customerId = generatedStripeCustomerId();
    const subscriptionId = generatedStripeSubscriptionId();
    const periodEnd = new Date("2099-04-20T00:00:00.000Z");
    await postSubscriptionInvoicePaid(context.signal, {
      ...actor,
      tier: "team",
      customerId,
      subscriptionId,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    });
    await postBillingDowngradeCheckoutCompleted(context.signal, {
      ...actor,
      tier: "team",
      customerId,
      subscriptionId,
      currentPeriodEnd: periodEnd,
      targetTier: "pro",
      scheduleId: `sub_sched_${randomUUID().slice(0, 8)}`,
    });
    disableStripeBilling();
    signIn(actor);

    await expect(readBillingStatus()).resolves.toMatchObject({
      cancelAtPeriodEnd: false,
      scheduledChange: {
        type: "downgrade",
        targetTier: "pro",
        effectiveDate: periodEnd.toISOString(),
      },
      canRestorePlan: true,
    });
  });

  it("billing-status-019 includes creditExpiry data and renewal grant for a paid organization", async () => {
    const actor = createBillingWebhookFixture();
    await postSubscriptionInvoicePaid(context.signal, {
      ...actor,
      tier: "pro",
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      currentPeriodEnd: new Date("2099-04-20T00:00:00.000Z"),
    });
    disableStripeBilling();
    signIn(actor);

    const body = await readBillingStatus();

    expect(body.creditExpiry).toStrictEqual({
      expiringNextCycle: 20_000,
      nextExpiryDate: "2099-05-20T00:00:00.000Z",
    });
    expect(body.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "subscription_renewal",
        label: "Pro plan",
        amount: 20_000,
        remaining: 20_000,
        expiresAt: "2099-05-20T00:00:00.000Z",
      }),
    ]);
  });

  it("billing-status-021 displays credits minus not-yet-settled expired amount", async () => {
    mockNow(Date.parse("2026-02-01T00:00:00.000Z"));
    const actor = createBillingWebhookFixture();
    await postCreditPurchaseInvoicePaid(context.signal, {
      orgId: actor.orgId,
      credits: 100_000,
      expiresAt: new Date("2099-12-31T00:00:00.000Z"),
    });
    await postCreditPurchaseInvoicePaid(context.signal, {
      orgId: actor.orgId,
      credits: 3000,
      expiresAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    mockNow(Date.parse("2026-03-02T00:00:00.000Z"));
    disableStripeBilling();
    signIn(actor);

    const body = await readBillingStatus();

    expect(body.credits).toBe(100_000);
  });

  it("billing-status-025 maps one_time_purchase records to the Promotional segment", async () => {
    const actor = createBillingWebhookFixture();
    mockEnv(
      "OKOU_ONE_TIME_CAMPAIGN",
      JSON.stringify({
        ZERO100: {
          priceId: "price_test_zero100",
          couponId: "coupon_test_zero100",
        },
      }),
    );
    await deliverStripeEvent({
      type: "checkout.session.completed",
      created: Math.floor(Date.parse("2099-12-01T00:00:00.000Z") / 1000),
      data: {
        object: {
          id: `cs_zero100_${randomUUID().slice(0, 8)}`,
          invoice: null,
          subscription: null,
          customer: null,
          mode: "payment",
          payment_status: "paid",
          amount_subtotal: 0,
          amount_total: 0,
          metadata: {
            purpose: "one_time_purchase",
            orgId: actor.orgId,
            campaignKey: "ZERO100",
          },
        },
      },
    });
    disableStripeBilling();
    signIn(actor);

    const body = await readBillingStatus();

    expect(body.creditBreakdown).toContainEqual({
      category: "promotional",
      label: "Promotional",
      credits: 100_000,
    });
  });

  it("billing-status-026 surfaces paid-tier credit purchases as Pay as you go", async () => {
    const actor = createBillingWebhookFixture();
    await postSubscriptionInvoicePaid(context.signal, {
      ...actor,
      tier: "pro",
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      currentPeriodEnd: new Date("2099-05-20T00:00:00.000Z"),
    });
    await postCreditPurchaseInvoicePaid(context.signal, {
      orgId: actor.orgId,
      credits: 5000,
      expiresAt: new Date("2099-12-31T00:00:00.000Z"),
    });
    disableStripeBilling();
    signIn(actor);

    const body = await readBillingStatus();

    expect(body.creditBreakdown).toStrictEqual([
      {
        category: "plan",
        label: "Pro plan",
        credits: 20_000,
        tier: "pro",
      },
      {
        category: "payAsYouGo",
        label: "Pay as you go",
        credits: 5000,
      },
    ]);
    expect(
      body.creditGrants.some((grant) => {
        return grant.source === "auto_recharge";
      }),
    ).toBeFalsy();
  });

  it("billing-status-010 reports active concurrency subscription availability without a plan subscription", async () => {
    const actor = createBillingWebhookFixture();
    await postConcurrencyEntitlementsInvoicePaid(context.signal, {
      ...actor,
      customerId: generatedStripeCustomerId(),
      subscriptionId: generatedStripeSubscriptionId(),
      subscriptionStatus: "active",
      lines: [
        {
          slots: 2,
          startsAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2099-04-20T00:00:00.000Z"),
        },
      ],
    });
    disableStripeBilling();
    signIn(actor);

    const body = await readBillingStatus();

    expect(body.hasSubscription).toBeTruthy();
  });

  it("billing-status-015 excludes canceled concurrency subscriptions from status", async () => {
    const actor = createBillingWebhookFixture();
    const customerId = generatedStripeCustomerId();
    await postSubscriptionInvoicePaid(context.signal, {
      ...actor,
      tier: "team",
      customerId,
      subscriptionId: generatedStripeSubscriptionId(),
      currentPeriodEnd: new Date("2099-04-20T00:00:00.000Z"),
    });
    await postConcurrencyEntitlementsInvoicePaid(context.signal, {
      ...actor,
      customerId,
      subscriptionId: generatedStripeSubscriptionId(),
      subscriptionStatus: "canceled",
      lines: [
        {
          slots: 2,
          startsAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2099-04-20T00:00:00.000Z"),
        },
      ],
    });
    disableStripeBilling();
    signIn(actor);

    const body = await readBillingStatus();

    expect(body.concurrencyLimit).toBe(10);
    expect(body.concurrencySubscriptions).toStrictEqual([]);
  });

  it("billing-status-027 returns defaults when org billing row does not exist", async () => {
    const actor = createBillingWebhookFixture();
    mockOptionalEnv("STRIPE_SECRET_KEY", apiTestEnvironment.STRIPE_SECRET_KEY);
    mockEnv("OKOU_PRICE_CONCURRENCY", TEST_PRICE_CONCURRENCY);
    context.mocks.stripe.prices.retrieve.mockRejectedValueOnce(
      new Error("Stripe unavailable"),
    );
    signIn(actor);

    const body = await readBillingStatus();

    expect(body).toMatchObject({
      tier: "limited-free-1",
      status: "suspended",
      credits: 0,
      hasSubscription: false,
      canBuyConcurrency: false,
    });
    expect("concurrencyUnitAmountCents" in body).toBeFalsy();
  });
});
