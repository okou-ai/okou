import { randomUUID } from "node:crypto";
import {
  billingCheckoutContract,
  billingStatusContract,
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
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const APP_ORIGIN = new URL(apiTestEnvironment.APP_URL).origin;
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const PRO_PRICE = apiTestEnvironment.OKOU_PRICE_PRO;
const TEAM_PRICE = apiTestEnvironment.OKOU_PRICE_TEAM;
const redirects = Object.freeze({
  successUrl: `${APP_ORIGIN}/billing?billing=success`,
  cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
});

function setup(role: "org:admin" | "org:member" = "org:admin") {
  const admin = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  createRouteMocks(context).clerk.session(admin.userId, admin.orgId, role);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_billing_checkout");
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: admin.orgId,
    slug: `billing-${admin.orgId.slice(-8)}`,
    name: "Billing Checkout Org",
    createdBy: admin.userId,
    createdAt: now(),
  });
  const appFor = setupApp({
    context,
    routes: [
      ...billingCheckoutRoutes,
      ...billingStatusRoutes,
      ...webhooksStripeRoutes,
    ],
  });
  const checkout = appFor(billingCheckoutContract);
  const webhook = appFor(webhookStripeContract);
  const status = appFor(billingStatusContract);

  async function readStatus() {
    return (await accept(status.get({ headers }), [200])).body;
  }

  /** Stripe records a paid subscription invoice for the organization. */
  async function subscribe(tier: "pro" | "team") {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const priceId = tier === "team" ? TEAM_PRICE : PRO_PRICE;
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
            price: { id: priceId },
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
                price: { id: priceId },
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
        extraHeaders: { "stripe-signature": "t=1,v1=billing-checkout" },
      }),
      [200],
    );
    return { customerId, subscriptionId, period };
  }

  return { admin, checkout, subscribe, readStatus };
}

describe("POST /api/billing/checkout", () => {
  it("billing-checkout-003 refuses checkout for a non-admin member", async () => {
    const { checkout } = setup("org:member");

    const response = await accept(
      checkout.create({ headers, body: { tier: "pro", ...redirects } }),
      [403],
    );

    expect(response.body.error).toMatchObject({
      code: "FORBIDDEN",
      message: "Only org admins can manage billing",
    });
  });

  it("billing-checkout-004 returns a hosted Checkout URL to an admin", async () => {
    const { admin, checkout } = setup();
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const checkoutUrl = `https://checkout.stripe.test/cs_${randomUUID()}`;
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
      id: `cs_${randomUUID()}`,
      url: checkoutUrl,
    });

    const response = await accept(
      checkout.create({ headers, body: { tier: "pro", ...redirects } }),
      [200],
    );

    expect(response.body).toStrictEqual({ url: checkoutUrl });
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ orgId: admin.orgId }),
      }),
      expect.objectContaining({
        idempotencyKey: `stripe-customer:development::${admin.orgId}`,
      }),
    );
    const purchaseMetadata = {
      orgId: admin.orgId,
      tier: "pro",
      priceId: PRO_PRICE,
      purchaseCreatedAt: expect.any(String),
    };
    expect(
      context.mocks.stripe.checkout.sessions.create.mock.calls[0]?.[0],
    ).toStrictEqual(
      expect.objectContaining({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: PRO_PRICE, quantity: 1 }],
        allow_promotion_codes: true,
        success_url: redirects.successUrl,
        cancel_url: redirects.cancelUrl,
        metadata: expect.objectContaining(purchaseMetadata),
        subscription_data: expect.objectContaining({
          metadata: expect.objectContaining(purchaseMetadata),
        }),
      }),
    );
  });

  it("billing-checkout-017 refuses a Pro checkout that would downgrade a Team organization", async () => {
    const { checkout, subscribe } = setup();
    await subscribe("team");

    const response = await accept(
      checkout.create({ headers, body: { tier: "pro", ...redirects } }),
      [400],
    );

    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Cannot create Pro checkout while current tier is Team; use billing management to change plans",
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("billing-checkout-018 refuses a Pro checkout that would duplicate the current Pro plan", async () => {
    const { checkout, subscribe } = setup();
    await subscribe("pro");

    const response = await accept(
      checkout.create({ headers, body: { tier: "pro", ...redirects } }),
      [400],
    );

    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Cannot create Pro checkout while current tier is Pro; use billing management to change plans",
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("billing-checkout-020 refuses a Pro trial outside onboarding payment", async () => {
    const { checkout } = setup();

    const response = await accept(
      checkout.create({
        headers,
        body: { tier: "pro", trialDays: 7, ...redirects },
      }),
      [400],
    );

    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Pro trial checkout is only available during onboarding",
    });
  });

  it("billing-checkout-021 refuses a trial for a non-Pro tier", async () => {
    const { checkout } = setup();

    const response = await accept(
      checkout.create({
        headers,
        body: { tier: "team", trialDays: 7, ...redirects },
      }),
      [400],
    );

    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Trial checkout is only available for Pro tier",
    });
  });

  it("billing-checkout-022 refuses a success URL outside the platform origin", async () => {
    const { checkout } = setup();

    const response = await accept(
      checkout.create({
        headers,
        body: {
          tier: "pro",
          successUrl: "https://evil.example.com/billing",
          cancelUrl: redirects.cancelUrl,
        },
      }),
      [400],
    );

    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "successUrl and cancelUrl must match the platform origin",
    });
  });

  it("billing-checkout-013 refreshes a Plan preview whose saved card was replaced", async () => {
    const { checkout } = setup();
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    const customerWithCard = (paymentMethodId: string) => {
      return {
        id: customerId,
        invoice_settings: { default_payment_method: paymentMethodId },
        default_source: null,
      };
    };
    context.mocks.stripe.customers.retrieve
      .mockResolvedValueOnce(customerWithCard("pm_original"))
      .mockResolvedValue(customerWithCard("pm_replacement"));
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      amount_due: 2000,
      total: 2000,
      subtotal: 2000,
      currency: "usd",
      lines: { data: [], has_more: false },
    });
    const body = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      ...redirects,
    };
    const first = await accept(checkout.create({ headers, body }), [200]);
    if (!("previewToken" in first.body)) {
      throw new Error("Expected a Plan purchase preview");
    }

    const refreshed = await accept(
      checkout.create({
        headers,
        body: { ...body, previewToken: first.body.previewToken },
      }),
      [200],
    );

    expect(refreshed.body).toMatchObject({
      status: "preview",
      purchaseType: "plan",
      tier: "pro",
      immediateAmountCents: 2000,
      nextRecurringAmountCents: 2000,
      currency: "usd",
    });
    expect(refreshed.body).not.toMatchObject({
      previewToken: first.body.previewToken,
    });
    expect(context.mocks.stripe.customers.retrieve).toHaveBeenCalledTimes(3);
    expect(context.mocks.stripe.subscriptions.create).not.toHaveBeenCalled();
  });

  it("billing-checkout-015 uses hosted Checkout when the opted-in admin has no saved card", async () => {
    const { checkout } = setup();
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const checkoutUrl = `https://checkout.stripe.test/cs_${randomUUID()}`;
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
      id: `cs_${randomUUID()}`,
      url: checkoutUrl,
    });

    const response = await accept(
      checkout.create({
        headers,
        body: { tier: "pro", supportsInAppPreview: true, ...redirects },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ url: checkoutUrl });
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
  });

  it("billing-checkout-010 pays a saved-card Plan preview through the checkout route", async () => {
    const previewTime = Date.parse("2026-03-02T00:00:00.000Z");
    mockNow(previewTime);
    const { admin, checkout, readStatus } = setup();
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const periodEnd = Math.floor(previewTime / 1000) + 30 * 86_400;
    const period = { start: periodEnd - 30 * 86_400, end: periodEnd };
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: admin.orgId },
      invoice_settings: { default_payment_method: "pm_saved_card" },
      default_source: null,
    });
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      amount_due: 2000,
      total: 2000,
      subtotal: 2000,
      currency: "usd",
      lines: { data: [], has_more: false },
    });
    const invoice = (status: "open" | "paid") => {
      return {
        id: `in_${subscriptionId}`,
        status,
        customer: customerId,
        amount_due: 2000,
        amount_paid: status === "paid" ? 2000 : 0,
        total: 2000,
        subtotal: 2000,
        currency: "usd",
        metadata: {},
        parent: {
          subscription_details: { subscription: subscriptionId, metadata: {} },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${subscriptionId}`,
              price: { id: PRO_PRICE },
              quantity: 1,
              amount: 2000,
              parent: { type: "subscription_item_details" },
              period,
            },
          ],
        },
      };
    };
    const subscription = (status: "incomplete" | "active") => {
      return {
        id: subscriptionId,
        status,
        customer: customerId,
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: null,
        trial_end: null,
        metadata: {},
        default_payment_method: "pm_saved_card",
        latest_invoice: invoice(status === "active" ? "paid" : "open"),
        items: {
          data: [
            {
              price: { id: PRO_PRICE },
              quantity: 1,
              current_period_start: period.start,
              current_period_end: period.end,
            },
          ],
        },
      };
    };
    context.mocks.stripe.subscriptions.create.mockResolvedValue(
      subscription("incomplete"),
    );
    context.mocks.stripe.invoices.pay.mockResolvedValue(invoice("paid"));
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      subscription("active"),
    );
    const body = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      ...redirects,
    };

    const preview = await accept(checkout.create({ headers, body }), [200]);
    expect(preview.body).toMatchObject({
      status: "preview",
      purchaseType: "plan",
      tier: "pro",
      immediateAmountCents: 2000,
      nextRecurringAmountCents: 2000,
      currency: "usd",
    });
    if (!("previewToken" in preview.body)) {
      throw new Error("Expected a Plan purchase preview");
    }
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    mockNow(previewTime + 60_000);

    const confirmed = await accept(
      checkout.create({
        headers,
        body: { ...body, previewToken: preview.body.previewToken },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      2,
    );
    expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: customerId,
        default_payment_method: "pm_saved_card",
        payment_behavior: "default_incomplete",
        metadata: expect.objectContaining({
          purchaseCreatedAt: new Date(previewTime).toISOString(),
        }),
      }),
      {
        idempotencyKey: expect.stringMatching(/^plan-purchase:/),
      },
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      expect.any(String),
      {},
      { idempotencyKey: expect.stringMatching(/^billing-operation:plan:/) },
    );
    await expect(readStatus()).resolves.toMatchObject({
      tier: "pro",
      subscriptionStatus: "active",
    });
  });

  it("billing-checkout-014 rejects competing Plan previews and stale purchase replays", async () => {
    const { admin, checkout } = setup();
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: admin.orgId },
      invoice_settings: { default_payment_method: "pm_saved_card" },
      default_source: null,
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      amount_due: 2000,
      total: 2000,
      subtotal: 2000,
      currency: "usd",
      lines: { data: [], has_more: false },
    });
    const periodEnd = Math.floor(now() / 1000) + 30 * 86_400;
    const period = { start: periodEnd - 30 * 86_400, end: periodEnd };
    const listed: Record<string, unknown>[] = [];
    const planSubscription = (
      id: string,
      priceId: string,
      metadata: Record<string, string>,
    ) => {
      return {
        id,
        status: "active",
        customer: customerId,
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: null,
        trial_end: null,
        metadata,
        default_payment_method: "pm_saved_card",
        latest_invoice: {
          id: `in_${id}`,
          status: "paid",
          customer: customerId,
          amount_due: 2000,
          amount_paid: 2000,
          total: 2000,
          subtotal: 2000,
          currency: "usd",
          metadata: {},
          parent: { subscription_details: { subscription: id, metadata } },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${id}`,
                price: { id: priceId },
                quantity: 1,
                amount: 2000,
                parent: { type: "subscription_item_details" },
                period,
              },
            ],
          },
        },
        items: {
          data: [
            {
              price: { id: priceId },
              quantity: 1,
              current_period_start: period.start,
              current_period_end: period.end,
            },
          ],
        },
      };
    };
    // Stripe lists every subscription created so far.
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: listed,
      has_more: false,
    });
    context.mocks.stripe.subscriptions.create.mockImplementation(
      (params: unknown) => {
        const { items, metadata } = params as {
          readonly items: readonly { readonly price: string }[];
          readonly metadata: Record<string, string>;
        };
        const created = planSubscription(
          `sub_${randomUUID().slice(0, 8)}`,
          items[0]?.price ?? "",
          metadata,
        );
        listed.push(created);
        return Promise.resolve(created);
      },
    );
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (id: unknown) => {
        return Promise.resolve(
          listed.find((subscription) => {
            return subscription.id === id;
          }),
        );
      },
    );
    const preview = async (tier: "pro" | "team") => {
      const response = await accept(
        checkout.create({
          headers,
          body: { tier, supportsInAppPreview: true, ...redirects },
        }),
        [200],
      );
      if (!("previewToken" in response.body)) {
        throw new Error("Expected a Plan purchase preview");
      }
      return response.body.previewToken;
    };
    const firstPro = await preview("pro");
    const secondPro = await preview("pro");
    const team = await preview("team");
    const confirm = (previewToken: string) => {
      return accept(
        checkout.confirm({ headers, body: { previewToken } }),
        [200, 409],
      );
    };

    const racing = await Promise.all([confirm(firstPro), confirm(secondPro)]);
    const teamConfirmation = await confirm(team);
    listed.push(
      planSubscription(`sub_${randomUUID().slice(0, 8)}`, TEAM_PRICE, {
        orgId: admin.orgId,
      }),
    );
    const winner = racing[0].status === 200 ? firstPro : secondPro;
    const replay = await confirm(winner);

    expect(
      racing
        .map((response) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const stale = {
      code: "CONFLICT",
      message: "Plan purchase preview is no longer valid",
    };
    expect(teamConfirmation.status).toBe(409);
    expect(teamConfirmation.body).toMatchObject({ error: stale });
    expect(replay.status).toBe(409);
    expect(replay.body).toStrictEqual(teamConfirmation.body);
    expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.pay).not.toHaveBeenCalled();
  });

  it("billing-checkout-011 resumes a pending Team purchase and applies it before returning", async () => {
    const { admin, checkout, subscribe, readStatus } = setup();
    const {
      customerId,
      subscriptionId: proSubscriptionId,
      period,
    } = await subscribe("pro");
    const pendingTeamId = `sub_team_${randomUUID().slice(0, 8)}`;
    const teamInvoiceId = `in_team_${randomUUID().slice(0, 8)}`;
    const teamMetadata = {
      orgId: admin.orgId,
      tier: "team",
      priceId: TEAM_PRICE,
      billingPurchaseId: `bp_${randomUUID()}`,
    };
    let teamPaid = false;
    const teamInvoice = (invoiceStatus: "open" | "paid") => {
      return {
        id: teamInvoiceId,
        status: invoiceStatus,
        customer: customerId,
        amount_due: 20_000,
        amount_paid: invoiceStatus === "paid" ? 20_000 : 0,
        total: 20_000,
        subtotal: 20_000,
        currency: "usd",
        metadata: {},
        parent: {
          subscription_details: {
            subscription: pendingTeamId,
            metadata: teamMetadata,
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${teamInvoiceId}`,
              price: { id: TEAM_PRICE },
              quantity: 1,
              amount: 20_000,
              parent: { type: "subscription_item_details" },
              period,
            },
          ],
        },
      };
    };
    const proSubscription = {
      id: proSubscriptionId,
      status: "active",
      customer: customerId,
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      metadata: { orgId: admin.orgId },
      default_payment_method: "pm_saved_card",
      items: {
        data: [
          {
            price: { id: PRO_PRICE },
            quantity: 1,
            current_period_start: period.start,
            current_period_end: period.end,
          },
        ],
      },
    };
    const teamSubscription = () => {
      return {
        id: pendingTeamId,
        status: teamPaid ? "active" : "incomplete",
        customer: customerId,
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: null,
        trial_end: null,
        metadata: teamMetadata,
        default_payment_method: "pm_saved_card",
        latest_invoice: teamInvoice(teamPaid ? "paid" : "open"),
        items: {
          data: [
            {
              price: { id: TEAM_PRICE },
              quantity: 1,
              current_period_start: period.start,
              current_period_end: period.end,
            },
          ],
        },
      };
    };
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: admin.orgId },
      invoice_settings: { default_payment_method: "pm_saved_card" },
      default_source: null,
    });
    context.mocks.stripe.subscriptions.list.mockImplementation(() => {
      const data = [proSubscription, teamSubscription()];
      return Promise.resolve({ data, has_more: false });
    });
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (id: unknown) => {
        if (id === pendingTeamId) {
          return Promise.resolve(teamSubscription());
        }
        return Promise.resolve(proSubscription);
      },
    );
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      amount_due: 20_000,
      total: 20_000,
      subtotal: 20_000,
      currency: "usd",
      lines: { data: [], has_more: false },
    });
    context.mocks.stripe.invoices.pay.mockImplementation(() => {
      teamPaid = true;
      return Promise.resolve(teamInvoice("paid"));
    });
    context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
      ...proSubscription,
      status: "canceled",
    });

    const body = {
      tier: "team" as const,
      supportsInAppPreview: true,
      ...redirects,
    };
    const preview = await accept(checkout.create({ headers, body }), [200]);
    if (!("previewToken" in preview.body)) {
      throw new Error("Expected a Team purchase preview");
    }

    const confirmed = await accept(
      checkout.create({
        headers,
        body: { ...body, previewToken: preview.body.previewToken },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.subscriptions.create).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      teamInvoiceId,
      {},
      { idempotencyKey: expect.stringMatching(/^billing-operation:plan:/) },
    );
    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      proSubscriptionId,
      { invoice_now: false, prorate: false },
    );
    await expect(readStatus()).resolves.toMatchObject({
      tier: "team",
      subscriptionStatus: "active",
    });
  });

  it("billing-checkout-012 rejects a resumable Plan purchase after its saved card changes", async () => {
    const { admin, checkout, subscribe } = setup();
    const {
      customerId,
      subscriptionId: proSubscriptionId,
      period,
    } = await subscribe("pro");
    const pendingTeamId = `sub_team_${randomUUID().slice(0, 8)}`;
    const teamInvoiceId = `in_team_${randomUUID().slice(0, 8)}`;
    const teamMetadata = {
      orgId: admin.orgId,
      tier: "team",
      priceId: TEAM_PRICE,
      billingPurchaseId: `bp_${randomUUID()}`,
    };
    let pendingPaymentMethod = "pm_saved_card";
    const proSubscription = {
      id: proSubscriptionId,
      status: "active",
      customer: customerId,
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      metadata: { orgId: admin.orgId },
      default_payment_method: "pm_saved_card",
      items: {
        data: [
          {
            price: { id: PRO_PRICE },
            quantity: 1,
            current_period_start: period.start,
            current_period_end: period.end,
          },
        ],
      },
    };
    const teamSubscription = () => {
      return {
        id: pendingTeamId,
        status: "incomplete",
        customer: customerId,
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: null,
        trial_end: null,
        metadata: teamMetadata,
        default_payment_method: pendingPaymentMethod,
        latest_invoice: {
          id: teamInvoiceId,
          status: "open",
          customer: customerId,
          amount_due: 20_000,
          amount_paid: 0,
          total: 20_000,
          subtotal: 20_000,
          currency: "usd",
          metadata: {},
          parent: {
            subscription_details: {
              subscription: pendingTeamId,
              metadata: teamMetadata,
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${teamInvoiceId}`,
                price: { id: TEAM_PRICE },
                quantity: 1,
                amount: 20_000,
                parent: { type: "subscription_item_details" },
                period,
              },
            ],
          },
        },
        items: {
          data: [
            {
              price: { id: TEAM_PRICE },
              quantity: 1,
              current_period_start: period.start,
              current_period_end: period.end,
            },
          ],
        },
      };
    };
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: admin.orgId },
      invoice_settings: { default_payment_method: "pm_saved_card" },
      default_source: null,
    });
    context.mocks.stripe.subscriptions.list.mockImplementation(() => {
      const data = [proSubscription, teamSubscription()];
      return Promise.resolve({ data, has_more: false });
    });
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (id: unknown) => {
        if (id === pendingTeamId) {
          return Promise.resolve(teamSubscription());
        }
        return Promise.resolve(proSubscription);
      },
    );
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      amount_due: 20_000,
      total: 20_000,
      subtotal: 20_000,
      currency: "usd",
      lines: { data: [], has_more: false },
    });

    const preview = await accept(
      checkout.create({
        headers,
        body: { tier: "team", supportsInAppPreview: true, ...redirects },
      }),
      [200],
    );
    if (!("previewToken" in preview.body)) {
      throw new Error("Expected a Team purchase preview");
    }

    pendingPaymentMethod = "pm_other_card";

    const response = await accept(
      checkout.confirm({
        headers,
        body: { previewToken: preview.body.previewToken },
      }),
      [409],
    );

    expect(response.body).toMatchObject({
      error: {
        code: "CONFLICT",
        message: "Plan purchase preview is no longer valid",
      },
    });
    expect(context.mocks.stripe.invoices.pay).not.toHaveBeenCalled();
  });
});
