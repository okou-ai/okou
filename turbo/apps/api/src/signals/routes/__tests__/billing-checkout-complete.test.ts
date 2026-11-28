import { randomUUID } from "node:crypto";
import {
  billingCheckoutContract,
  billingStatusContract,
  billingUsagePackCheckoutContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { apiTestEnvironment } from "../../../__tests__/test-environment";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { billingCheckoutRoutes } from "../billing-checkout";
import { billingStatusRoutes } from "../billing-status";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const APP_ORIGIN = "http://localhost:3002";
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const PRO_PRICE = apiTestEnvironment.OKOU_PRICE_PRO;
const TEAM_PRICE = apiTestEnvironment.OKOU_PRICE_TEAM;
const USAGE_PACK_PLAN_PRO_PRICE =
  apiTestEnvironment.OKOU_PRICE_USAGE_PACK_PLAN_PRO;
const USAGE_PACK_20_PRICE = apiTestEnvironment.OKOU_PRICE_USAGE_PACK_20;

interface Admin {
  readonly orgId: string;
  readonly userId: string;
}

function seconds(date: number): number {
  return Math.floor(date / 1000);
}

function setup() {
  const admin: Admin = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  createRouteMocks(context).clerk.session(admin.userId, admin.orgId);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_checkout_complete");
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: admin.orgId,
    slug: `billing-${admin.orgId.slice(-8)}`,
    name: "Checkout Complete Org",
    createdBy: admin.userId,
    createdAt: now(),
  });
  const appFor = setupApp({
    context,
    routes: [
      ...billingCheckoutRoutes,
      ...billingStatusRoutes,
      ...billingUsagePackCreditsRoutes,
      ...webhooksStripeRoutes,
    ],
  });
  const checkout = appFor(billingCheckoutContract);
  const usagePackCheckout = appFor(billingUsagePackCheckoutContract);
  const status = appFor(billingStatusContract);
  const credits = appFor(billingUsagePackCreditsContract);
  const webhook = appFor(webhookStripeContract);

  async function readStatus() {
    return (await accept(status.get({ headers }), [200])).body;
  }

  async function readCredits() {
    return (await accept(credits.get({ headers }), [200])).body;
  }

  async function complete(sessionId: string) {
    return await checkout.complete({ headers, body: { sessionId } });
  }

  async function deliverStripeEvent(event: Record<string, unknown>) {
    const stripeEvent = {
      id: `evt_${randomUUID()}`,
      created: seconds(now()),
      ...event,
    };
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      stripeEvent,
    );
    return await webhook.post({
      body: JSON.stringify(stripeEvent),
      extraHeaders: { "stripe-signature": "t=1,v1=checkout-complete" },
    });
  }

  /** Starts a Pro plan checkout, which creates the org's Stripe customer. */
  async function startProCheckout(customerId: string, sessionId: string) {
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
      id: sessionId,
      url: `https://checkout.stripe.test/${sessionId}`,
    });
    await accept(
      checkout.create({
        headers,
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
      }),
      [200],
    );
  }

  function stripeCustomerFor(customerId: string) {
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: admin.orgId },
    });
  }

  /** Stripe catalog for the configured usage-pack prices. */
  function mockUsagePackCatalog() {
    const packs = new Map<string, readonly [number, number]>([
      [apiTestEnvironment.OKOU_PRICE_USAGE_PACK_20, [20, 400]],
      [apiTestEnvironment.OKOU_PRICE_USAGE_PACK_50, [50, 2600]],
      [apiTestEnvironment.OKOU_PRICE_USAGE_PACK_100, [100, 8700]],
      [apiTestEnvironment.OKOU_PRICE_USAGE_PACK_200, [200, 22_200]],
    ]);
    context.mocks.stripe.prices.retrieve.mockImplementation((id: unknown) => {
      const pack = typeof id === "string" ? packs.get(id) : undefined;
      const [usd, bonusCredits] = pack ?? [0, 0];
      return Promise.resolve({
        id,
        active: true,
        currency: "usd",
        type: "recurring",
        recurring: { interval: "month", interval_count: 1 },
        unit_amount: usd * 100,
        tax_behavior: "exclusive",
        product: pack
          ? {
              id: `prod_usage_${usd}`,
              name: `$${usd} usage pack`,
              metadata: { bonusCredits: String(bonusCredits) },
              tax_code: "txcd_10000000",
            }
          : { id: `prod_${String(id)}`, metadata: {} },
      });
    });
  }

  return {
    admin,
    checkout,
    usagePackCheckout,
    mockUsagePackCatalog,
    readStatus,
    readCredits,
    complete,
    deliverStripeEvent,
    startProCheckout,
    stripeCustomerFor,
  };
}

interface SubscriptionShape {
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly prices: readonly string[];
  readonly periodEnd: number;
  readonly metadata?: Record<string, unknown>;
}

function stripeInvoice(
  shape: SubscriptionShape,
  invoiceId: string,
  invoiceStatus: "open" | "paid",
  amountCents: number,
) {
  const periodStart = shape.periodEnd - 30 * 86_400;
  return {
    id: invoiceId,
    object: "invoice",
    status: invoiceStatus,
    customer: shape.customerId,
    amount_paid: invoiceStatus === "paid" ? amountCents : 0,
    amount_due: amountCents,
    total: amountCents,
    subtotal: amountCents,
    currency: "usd",
    metadata: shape.metadata ?? {},
    parent: {
      subscription_details: {
        subscription: shape.subscriptionId,
        metadata: shape.metadata ?? {},
      },
    },
    lines: {
      has_more: false,
      data: shape.prices.map((priceId, index) => {
        return {
          id: `il_${invoiceId}_${index}`,
          price: { id: priceId },
          quantity: 1,
          amount: index === 0 ? amountCents : 0,
          parent: { type: "subscription_item_details" },
          period: { start: periodStart, end: shape.periodEnd },
        };
      }),
    },
  };
}

function stripeSubscription(
  shape: SubscriptionShape,
  latestInvoice: Record<string, unknown>,
) {
  const periodStart = shape.periodEnd - 30 * 86_400;
  return {
    id: shape.subscriptionId,
    object: "subscription",
    status: "active",
    customer: shape.customerId,
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    trial_end: null,
    metadata: shape.metadata ?? {},
    latest_invoice: latestInvoice,
    items: {
      data: shape.prices.map((priceId, index) => {
        return {
          id: `si_${shape.subscriptionId}_${index}`,
          price: { id: priceId },
          quantity: 1,
          current_period_start: periodStart,
          current_period_end: shape.periodEnd,
        };
      }),
    },
  };
}

function completedSession(
  sessionId: string,
  customerId: string,
  subscriptionId: string | null,
) {
  return {
    id: sessionId,
    object: "checkout.session",
    status: "complete",
    mode: "subscription",
    customer: customerId,
    subscription: subscriptionId,
  };
}

describe("POST /api/billing/checkout/complete", () => {
  it("billing-checkout-complete-007 rejects an expired checkout instead of reporting it as pending", async () => {
    const api = setup();
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const sessionId = `cs_${randomUUID()}`;
    await api.startProCheckout(customerId, sessionId);
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: sessionId,
      object: "checkout.session",
      status: "expired",
      mode: "subscription",
      customer: customerId,
      subscription: null,
    });

    const response = await accept(api.complete(sessionId), [400]);

    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Checkout session expired",
    });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("billing-checkout-complete-008 rejects a completed checkout that belongs to another customer", async () => {
    const api = setup();
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    await api.startProCheckout(customerId, `cs_${randomUUID()}`);
    const sessionId = `cs_${randomUUID()}`;
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue(
      completedSession(
        sessionId,
        `cus_${randomUUID().slice(0, 8)}`,
        `sub_${randomUUID().slice(0, 8)}`,
      ),
    );

    const response = await accept(api.complete(sessionId), [400]);

    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Checkout session does not belong to current organization",
    });
  });

  it("billing-checkout-complete-005 refuses a completed checkout that would downgrade a Team organization", async () => {
    const api = setup();
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    await api.startProCheckout(customerId, `cs_${randomUUID()}`);
    api.stripeCustomerFor(customerId);
    const team: SubscriptionShape = {
      subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
      customerId,
      prices: [TEAM_PRICE],
      periodEnd: seconds(now()) + 30 * 86_400,
    };
    const teamInvoice = stripeInvoice(
      team,
      `in_${randomUUID().slice(0, 8)}`,
      "paid",
      10_000,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      stripeSubscription(team, teamInvoice),
    );
    await accept(
      api.deliverStripeEvent({
        type: "invoice.paid",
        data: { object: teamInvoice },
      }),
      [200],
    );
    expect((await api.readStatus()).tier).toBe("team");
    const pro: SubscriptionShape = {
      ...team,
      subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
      prices: [PRO_PRICE],
    };
    const sessionId = `cs_${randomUUID()}`;
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue(
      completedSession(sessionId, customerId, pro.subscriptionId),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(
        pro,
        stripeInvoice(pro, `in_${randomUUID().slice(0, 8)}`, "paid", 2000),
      ),
    );

    const response = await accept(api.complete(sessionId), [400]);

    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Cannot create Pro checkout while current tier is Team; use billing management to change plans",
    });
    await expect(api.readStatus()).resolves.toMatchObject({
      tier: "team",
      subscriptionStatus: "active",
    });
  });

  it("billing-checkout-complete-001 grants a paid Pro checkout once even when the webhook arrives later", async () => {
    mockNow(Date.parse("2026-03-02T00:00:00.000Z"));
    const api = setup();
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const sessionId = `cs_${randomUUID()}`;
    await api.startProCheckout(customerId, sessionId);
    api.stripeCustomerFor(customerId);
    const shape: SubscriptionShape = {
      subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
      customerId,
      prices: [PRO_PRICE],
      periodEnd: seconds(now()) + 30 * 86_400,
    };
    const invoiceId = `in_${randomUUID().slice(0, 8)}`;
    const openInvoice = stripeInvoice(shape, invoiceId, "open", 2000);
    const paidInvoice = stripeInvoice(shape, invoiceId, "paid", 2000);
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue(
      completedSession(sessionId, customerId, shape.subscriptionId),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(shape, openInvoice),
    );

    const pending = await accept(api.complete(sessionId), [200]);
    expect(pending.body).toStrictEqual({ completed: false });
    expect((await api.readStatus()).tier).not.toBe("pro");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(shape, paidInvoice),
    );
    const concurrent = await Promise.all([
      accept(api.complete(sessionId), [200]),
      accept(api.complete(sessionId), [200]),
    ]);
    const later = await accept(api.complete(sessionId), [200]);
    for (const response of [...concurrent, later]) {
      expect(response.body).toStrictEqual({ completed: true });
    }

    const reconciled = await api.readStatus();
    expect(reconciled).toMatchObject({
      tier: "pro",
      subscriptionStatus: "active",
      hasSubscription: true,
      currentPeriodEnd: new Date(shape.periodEnd * 1000).toISOString(),
      credits: 20_000,
    });
    const reconciledCredits = await api.readCredits();

    await accept(
      api.deliverStripeEvent({
        type: "invoice.paid",
        data: { object: paidInvoice },
      }),
      [200],
    );

    await expect(api.readStatus()).resolves.toStrictEqual(reconciled);
    await expect(api.readCredits()).resolves.toStrictEqual(reconciledCredits);
  });

  it("billing-checkout-complete-002 grants a paid usage pack checkout once even when the webhook arrives later", async () => {
    mockNow(Date.parse("2026-03-02T00:00:00.000Z"));
    const api = setup();
    api.mockUsagePackCatalog();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: api.admin.userId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const sessionId = `cs_${randomUUID()}`;
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    let checkoutMetadata: Record<string, unknown> = {};
    context.mocks.stripe.checkout.sessions.create.mockImplementationOnce(
      (input: unknown) => {
        if (
          typeof input === "object" &&
          input !== null &&
          "metadata" in input
        ) {
          checkoutMetadata = { ...(input.metadata as Record<string, unknown>) };
        }
        return Promise.resolve({
          id: sessionId,
          url: `https://checkout.stripe.test/${sessionId}`,
        });
      },
    );
    await accept(
      api.usagePackCheckout.create({
        headers,
        body: {
          tier: "pro",
          memberUsagePacks: [{ memberId: api.admin.userId, usagePackUsd: 20 }],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
      }),
      [200],
    );
    api.stripeCustomerFor(customerId);
    const shape: SubscriptionShape = {
      subscriptionId: `sub_${randomUUID().slice(0, 8)}`,
      customerId,
      prices: [USAGE_PACK_20_PRICE, USAGE_PACK_PLAN_PRO_PRICE],
      periodEnd: seconds(now()) + 30 * 86_400,
      metadata: checkoutMetadata,
    };
    const invoiceId = `in_${randomUUID().slice(0, 8)}`;
    const openInvoice = stripeInvoice(shape, invoiceId, "open", 2000);
    const paidInvoice = stripeInvoice(shape, invoiceId, "paid", 2000);
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      ...completedSession(sessionId, customerId, shape.subscriptionId),
      metadata: checkoutMetadata,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(shape, openInvoice),
    );

    const pending = await accept(api.complete(sessionId), [200]);
    expect(pending.body).toStrictEqual({ completed: false });
    expect((await api.readStatus()).tier).not.toBe("pro");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(shape, paidInvoice),
    );
    const concurrent = await Promise.all([
      accept(api.complete(sessionId), [200]),
      accept(api.complete(sessionId), [200]),
    ]);
    const later = await accept(api.complete(sessionId), [200]);
    for (const response of [...concurrent, later]) {
      expect(response.body).toStrictEqual({ completed: true });
    }

    const reconciled = await api.readStatus();
    expect(reconciled).toMatchObject({
      tier: "pro",
      subscriptionStatus: "active",
      hasSubscription: true,
      currentPeriodEnd: new Date(shape.periodEnd * 1000).toISOString(),
    });
    const reconciledCredits = await api.readCredits();
    expect(reconciledCredits).toMatchObject({
      hasUsagePack: true,
      totalCredits: 20_400,
      purchasedCredits: 20_000,
      bonusCredits: 400,
    });
    expect(reconciledCredits.creditGrants).toHaveLength(2);

    await accept(
      api.deliverStripeEvent({
        type: "invoice.paid",
        data: { object: paidInvoice },
      }),
      [200],
    );

    await expect(api.readStatus()).resolves.toStrictEqual(reconciled);
    await expect(api.readCredits()).resolves.toStrictEqual(reconciledCredits);
  });
});
