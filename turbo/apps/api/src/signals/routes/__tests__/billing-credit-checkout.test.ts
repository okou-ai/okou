import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  billingCreditCheckoutContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { billingCreditCheckoutRoutes } from "../billing-credit-checkout";
import { billingStatusRoutes } from "../billing-status";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const CREDIT_UNIT_PRICE = "price_credit_checkout_unit";
const SUCCESS_URL = "http://localhost:3002/settings/billing?credits=success";
const CANCEL_URL = "http://localhost:3002/settings/billing?credits=cancel";
const SAVED_CARD = "pm_credit_checkout_saved_card";
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function creditCheckoutApi() {
  return setupApp({ context, routes: billingCreditCheckoutRoutes })(
    billingCreditCheckoutContract,
  );
}

function billingStatusApi() {
  return setupApp({ context, routes: billingStatusRoutes })(
    billingStatusContract,
  );
}

function signIn(actor: ApiTestUser): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
}

function newAdmin(): ApiTestUser {
  mockEnv("OKOU_PRICE_CUSTOM_CREDIT_UNIT", CREDIT_UNIT_PRICE);
  const admin = createBddApi(context).user();
  signIn(admin);
  return admin;
}

async function proWorkspace(): Promise<ApiTestUser> {
  const admin = newAdmin();
  await publicPlanLifecycle(context, admin, "pro").update("active");
  signIn(admin);
  return admin;
}

function stripeHostedCheckout(): string {
  const sessionId = `cs_credit_checkout_${randomUUID()}`;
  const url = `https://checkout.stripe.test/${sessionId}`;
  context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
    id: sessionId,
    url,
  });
  return url;
}

/** The workspace's Stripe customer, optionally carrying a coupon discount. */
function stripeCustomer(orgId: string, couponId?: string): void {
  context.mocks.stripe.customers.retrieve.mockImplementation(
    (customerId: unknown) => {
      return Promise.resolve({
        id: customerId,
        metadata: { orgId },
        discount: couponId ? { source: { coupon: couponId } } : null,
        invoice_settings: { default_payment_method: null },
      });
    },
  );
}

function subscriptionPaymentMethod(paymentMethod: string | null): void {
  context.mocks.stripe.subscriptions.retrieve.mockImplementation(
    (subscriptionId: unknown) => {
      return Promise.resolve({
        id: subscriptionId,
        status: "active",
        default_payment_method: paymentMethod,
      });
    },
  );
}

function metadataOf(params: unknown): unknown {
  return typeof params === "object" && params !== null && "metadata" in params
    ? params.metadata
    : {};
}

/** Stripe echoes the requested invoice items as preview lines. */
function stripePreview(amountCents: number): void {
  context.mocks.stripe.invoices.createPreview.mockImplementation(
    (params: unknown) => {
      const items =
        typeof params === "object" &&
        params !== null &&
        "invoice_items" in params &&
        Array.isArray(params.invoice_items)
          ? (params.invoice_items as unknown[])
          : [];
      return Promise.resolve({
        currency: "usd",
        amount_due: amountCents,
        lines: {
          data: items.map((item) => {
            return { metadata: metadataOf(item) };
          }),
        },
      });
    },
  );
}

/** A Stripe invoice that is drafted, finalized open, then paid or held for authentication. */
function stripeSavedBillingInvoice(args: {
  readonly amountCents: number;
  readonly payment: "succeeds" | "requires_action";
  readonly hostedInvoiceUrl?: string;
}): void {
  const id = `in_credit_checkout_${randomUUID()}`;
  const lines: { metadata: unknown }[] = [];
  let status = "draft";
  function current() {
    return {
      id,
      status,
      amount_due: args.amountCents,
      currency: "usd",
      hosted_invoice_url: args.hostedInvoiceUrl ?? null,
      lines: { data: [...lines] },
    };
  }
  context.mocks.stripe.invoices.create.mockResolvedValue(current());
  context.mocks.stripe.invoiceItems.create.mockImplementation(
    (params: unknown) => {
      lines.push({ metadata: metadataOf(params) });
      return Promise.resolve({ id: `ii_${randomUUID()}` });
    },
  );
  context.mocks.stripe.invoices.retrieve.mockImplementation(async () => {
    return await Promise.resolve(current());
  });
  context.mocks.stripe.invoices.finalizeInvoice.mockImplementation(() => {
    status = "open";
    return Promise.resolve(current());
  });
  context.mocks.stripe.invoices.pay.mockImplementation(() => {
    if (args.payment === "requires_action") {
      return Promise.reject(
        Object.assign(new Error("Payment requires authentication"), {
          type: "StripeCardError",
          code: "invoice_payment_intent_requires_action",
        }),
      );
    }
    status = "paid";
    return Promise.resolve(current());
  });
}

async function requestCheckout(options: {
  readonly previewExistingBilling?: boolean;
}) {
  return await creditCheckoutApi().create({
    headers,
    body: {
      credits: 20_000,
      successUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
      ...options,
    },
  });
}

async function readStatus() {
  const response = await accept(billingStatusApi().get({ headers }), [200]);
  return response.body;
}

function onlyCheckoutSession(): unknown {
  const calls = context.mocks.stripe.checkout.sessions.create.mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0]?.[0];
}

describe("POST /api/billing/credit-checkout", () => {
  it("billing-credit-checkout-001 forbids a non-admin member from buying credits", async () => {
    mockEnv("OKOU_PRICE_CUSTOM_CREDIT_UNIT", CREDIT_UNIT_PRICE);
    const member = createBddApi(context).user({ orgRole: "org:member" });
    signIn(member);

    const response = await accept(requestCheckout({}), [403]);

    expect(response.body.error).toStrictEqual({
      code: "FORBIDDEN",
      message: "Only org admins can buy credits",
    });
  });

  it("billing-credit-checkout-002 opens a promotion-code checkout for a customer without a discount", async () => {
    const admin = newAdmin();
    const orgId = admin.orgId ?? "";
    const customerId = `cus_credit_checkout_${randomUUID()}`;
    context.mocks.stripe.customers.create.mockResolvedValue({
      id: customerId,
      metadata: { orgId },
    });
    stripeCustomer(orgId);
    const url = stripeHostedCheckout();

    const response = await accept(requestCheckout({}), [200]);

    expect(response.body).toStrictEqual({ url });
    const purchaseMetadata = {
      purpose: "credit_purchase",
      orgId,
      purchaseCreatedAt: expect.any(String),
      creditsAmountMode: "amount_subtotal",
      requestedCreditsAmount: "20000",
    };
    expect(onlyCheckoutSession()).toMatchObject({
      mode: "payment",
      customer: customerId,
      line_items: [{ price: CREDIT_UNIT_PRICE, quantity: 20 }],
      allow_promotion_codes: true,
      invoice_creation: {
        enabled: true,
        invoice_data: {
          metadata: { type: "credit_purchase", ...purchaseMetadata },
        },
      },
      metadata: purchaseMetadata,
    });
  });

  it("billing-credit-checkout-003 applies the customer's coupon to the checkout", async () => {
    const admin = await proWorkspace();
    stripeCustomer(admin.orgId ?? "", "coupon_credit_checkout_loyal");
    const url = stripeHostedCheckout();

    const response = await accept(requestCheckout({}), [200]);

    expect(response.body).toStrictEqual({ url });
    const session = onlyCheckoutSession();
    expect(session).toMatchObject({
      mode: "payment",
      line_items: [{ price: CREDIT_UNIT_PRICE, quantity: 20 }],
      discounts: [{ coupon: "coupon_credit_checkout_loyal" }],
    });
    expect(session).not.toHaveProperty("allow_promotion_codes");
    expect(context.mocks.stripe.customers.retrieve).toHaveBeenCalledWith(
      (session as { customer: string }).customer,
    );
  });

  it("billing-credit-checkout-004 confirms a saved-card purchase with the preview time", async () => {
    const admin = await proWorkspace();
    const coupon = "coupon_credit_checkout_preview";
    stripeCustomer(admin.orgId ?? "", coupon);
    subscriptionPaymentMethod(SAVED_CARD);
    stripePreview(1800);
    stripeSavedBillingInvoice({ amountCents: 1800, payment: "succeeds" });
    const previewedAt = Date.parse("2026-03-02T10:00:00.000Z");
    mockNow(previewedAt);

    const preview = await accept(
      requestCheckout({ previewExistingBilling: true }),
      [200],
    );
    expect(preview.body).toMatchObject({
      status: "preview",
      credits: 20_000,
      amountCents: 1800,
      currency: "usd",
      expiresAt: expect.any(String),
      previewToken: expect.any(String),
    });
    if (!("previewToken" in preview.body)) {
      throw new Error("Expected a credit purchase preview");
    }
    const previewToken = preview.body.previewToken;
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    const previewRequest =
      context.mocks.stripe.invoices.createPreview.mock.calls[0]?.[0];
    expect(previewRequest).toMatchObject({ discounts: [{ coupon }] });
    expect(previewRequest).not.toHaveProperty("customer");
    expect(previewRequest).not.toHaveProperty("subscription");

    // The final base64url character can carry unused padding bits, so alter the first one.
    const tamperedToken = `${previewToken.startsWith("A") ? "B" : "A"}${previewToken.slice(1)}`;
    const tampered = await accept(
      creditCheckoutApi().confirm({
        headers,
        body: { previewToken: tamperedToken },
      }),
      [400],
    );
    expect(tampered.body.error.code).toBe("BAD_REQUEST");
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();

    mockNow(previewedAt + 60_000);
    const confirmed = await accept(
      creditCheckoutApi().confirm({ headers, body: { previewToken } }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        default_payment_method: SAVED_CARD,
        discounts: [{ coupon }],
        metadata: expect.objectContaining({
          type: "credit_purchase",
          purpose: "credit_purchase",
          orgId: admin.orgId,
          purchaseCreatedAt: new Date(previewedAt).toISOString(),
        }),
      }),
      {
        idempotencyKey: expect.stringMatching(/^credit-purchase:/),
      },
    );
    const [invoiceParams] =
      context.mocks.stripe.invoices.create.mock.calls[0] ?? [];
    expect(context.mocks.stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: (invoiceParams as { customer: string }).customer,
        pricing: { price: CREDIT_UNIT_PRICE },
        quantity: 20,
      }),
      { idempotencyKey: expect.stringMatching(/^credit-purchase:/) },
    );
  });

  it("billing-credit-checkout-008 returns the hosted invoice when the saved card needs authentication", async () => {
    const admin = await proWorkspace();
    stripeCustomer(admin.orgId ?? "");
    subscriptionPaymentMethod(SAVED_CARD);
    stripePreview(2000);
    const hostedInvoiceUrl =
      "https://invoice.stripe.com/saved-billing-authentication";
    stripeSavedBillingInvoice({
      amountCents: 2000,
      payment: "requires_action",
      hostedInvoiceUrl,
    });

    const preview = await accept(
      requestCheckout({ previewExistingBilling: true }),
      [200],
    );
    if (!("previewToken" in preview.body)) {
      throw new Error("Expected a credit purchase preview");
    }
    const confirmed = await accept(
      creditCheckoutApi().confirm({
        headers,
        body: { previewToken: preview.body.previewToken },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      expect.any(String),
      {},
      { idempotencyKey: expect.stringMatching(/^billing-operation:credit:/) },
    );
    expect(context.mocks.stripe.invoices.retrieve).toHaveBeenCalledTimes(2);
  });

  it("billing-credit-checkout-009 falls back to hosted checkout without saved billing", async () => {
    const admin = await proWorkspace();
    stripeCustomer(admin.orgId ?? "");
    subscriptionPaymentMethod(null);
    const url = stripeHostedCheckout();

    const response = await accept(
      requestCheckout({ previewExistingBilling: true }),
      [200],
    );

    expect(response.body).toStrictEqual({ url });
  });

  it("billing-credit-checkout-011 lets a Free workspace buy credits without changing its plan", async () => {
    const admin = newAdmin();
    const orgId = admin.orgId ?? "";
    await createBddApi(context).provisionWorkspace(admin);
    signIn(admin);
    context.mocks.stripe.customers.create.mockResolvedValue({
      id: `cus_credit_checkout_${randomUUID()}`,
      metadata: { orgId },
    });
    stripeCustomer(orgId);
    const url = stripeHostedCheckout();

    await expect(readStatus()).resolves.toMatchObject({
      tier: "limited-free-1",
      canBuyCredits: true,
      hasSubscription: false,
      subscriptionStatus: null,
    });

    const response = await accept(requestCheckout({}), [200]);

    expect(response.body).toStrictEqual({ url });
    expect(onlyCheckoutSession()).toMatchObject({
      mode: "payment",
      line_items: [{ price: CREDIT_UNIT_PRICE, quantity: 20 }],
      metadata: { purpose: "credit_purchase", orgId },
    });
    await expect(readStatus()).resolves.toMatchObject({
      tier: "limited-free-1",
      hasSubscription: false,
      subscriptionStatus: null,
      autoRechargeAllowed: false,
      restrictedBuiltInModels: true,
    });
  });
});
