import { randomUUID } from "node:crypto";
import { mockClerkUsers } from "./helpers/clerk-users";
import { billingCreditCheckoutContract } from "@okouai/api-contracts/contracts/billing";
import StripeSDK from "stripe";
import { accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, nowDate } from "../../../lib/time";
import { billingCreditCheckoutRoutes } from "../billing-credit-checkout";

import { createBillingCheckoutFixture } from "./helpers/billing-checkout-fixture";

const {
  context,
  mocks,
  APP_ORIGIN,
  TEST_PRICE_CUSTOM_CREDIT_UNIT,
  setTierPrices,
  currentSecond,
  okouToken,
  createOrgFixture,
  createSubscriptionOrg,
  createPublicBillingOrg,
  seedMemberRole,
} = createBillingCheckoutFixture();

describe("POST /api/billing/credit-checkout", () => {
  beforeEach(() => {
    setTierPrices();
    mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      discount: null,
    });
  });

  function trackedSeed(): { orgId: string; userId: string } {
    return createOrgFixture();
  }

  function mockCreditPurchasePreview(customerId: string): void {
    context.mocks.stripe.invoices.createPreview.mockImplementation(
      (rawParams) => {
        const params = rawParams as {
          readonly customer?: string;
          readonly discounts?: "" | readonly { readonly coupon: string }[];
          readonly invoice_items?: readonly {
            readonly metadata?: Readonly<Record<string, string>>;
          }[];
        };
        const purchaseId =
          params.invoice_items?.[0]?.metadata?.credit_purchase_preview_id;
        if (!purchaseId) {
          throw new Error("Expected a credit purchase preview ID");
        }
        const subscriptionRenewalLines =
          params.customer === customerId
            ? [
                {
                  id: `il_renewal_${randomUUID()}`,
                  amount: 10_000,
                  subtotal: 10_000,
                  metadata: {},
                  period: {
                    start: currentSecond(),
                    end: currentSecond(),
                  },
                  parent: {
                    type: "subscription_item_details",
                    subscription_item_details: {
                      proration: false,
                      proration_details: null,
                    },
                  },
                },
              ]
            : [];
        const discounted =
          Array.isArray(params.discounts) && params.discounts.length > 0;
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          hosted_invoice_url: null,
          customer: params.customer ?? null,
          metadata: {},
          amount_due:
            (discounted ? 1800 : 2000) +
            (subscriptionRenewalLines.length > 0 ? 10_000 : 0),
          currency: "usd",
          status: null,
          lines: {
            has_more: false,
            data: [
              ...subscriptionRenewalLines,
              {
                id: `il_preview_${randomUUID()}`,
                amount: 2000,
                subtotal: 2000,
                metadata: {
                  credit_purchase_preview_id: purchaseId,
                },
                period: { start: currentSecond(), end: currentSecond() },
                parent: null,
              },
            ],
          },
          parent: null,
        });
      },
    );
  }

  it("returns 403 for non-admin org member", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({
      context,
      routes: billingCreditCheckoutRoutes,
    })(billingCreditCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          credits: 20_000,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can buy credits",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 403 for agent tokens without billing write capability", async () => {
    const token = okouToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: ["billing:read"],
    });

    const client = setupApp({
      context,
      routes: billingCreditCheckoutRoutes,
    })(billingCreditCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          credits: 20_000,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "Missing required capability: billing:write",
      code: "FORBIDDEN",
    });
  });

  it("allows promotion codes when the customer has no discount", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/credit",
    });

    const client = setupApp({
      context,
      routes: billingCreditCheckoutRoutes,
    })(billingCreditCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          credits: 20_000,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/credit",
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer: customerId,
        line_items: [{ price: TEST_PRICE_CUSTOM_CREDIT_UNIT, quantity: 20 }],
        allow_promotion_codes: true,
        invoice_creation: {
          enabled: true,
          invoice_data: {
            metadata: {
              type: "credit_purchase",
              purpose: "credit_purchase",
              orgId: fixture.orgId,
              purchaseCreatedAt: expect.any(String),
              creditsAmountMode: "amount_subtotal",
              requestedCreditsAmount: "20000",
            },
          },
        },
        metadata: {
          purpose: "credit_purchase",
          orgId: fixture.orgId,
          purchaseCreatedAt: expect.any(String),
          creditsAmountMode: "amount_subtotal",
          requestedCreditsAmount: "20000",
        },
      }),
    );
  });

  it("keeps credit Checkout billing attribution in Marketing", async () => {
    const fixture = await createSubscriptionOrg({ tier: "pro" });
    const impact = {
      clickId: "credit-partner",
      capturedAt: nowDate().toISOString(),
    };
    mockClerkUsers(context, [
      {
        id: fixture.userId,
        privateMetadata: { impact_attribution: impact },
      },
    ]);
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: fixture.customerId,
      metadata: {},
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/impact-credit",
    });
    await accept(
      setupApp({ context, routes: billingCreditCheckoutRoutes })(
        billingCreditCheckoutContract,
      ).create({
        body: {
          credits: 20_000,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const snapshot = expect.not.objectContaining({
      impact_click_id: expect.anything(),
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: snapshot,
        invoice_creation: {
          enabled: true,
          invoice_data: { metadata: snapshot },
        },
        payment_intent_data: expect.objectContaining({ metadata: snapshot }),
      }),
    );
  });

  it("automatically applies the customer's coupon", async () => {
    const fixture = await createSubscriptionOrg({ tier: "pro" });
    const { customerId } = fixture;
    const couponId = `coupon_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      discount: {
        source: {
          type: "coupon",
          coupon: couponId,
        },
      },
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/discounted-credit",
    });

    const response = await accept(
      setupApp({ context, routes: billingCreditCheckoutRoutes })(
        billingCreditCheckoutContract,
      ).create({
        body: {
          credits: 20_000,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/discounted-credit",
    });
    expect(context.mocks.stripe.customers.retrieve).toHaveBeenCalledWith(
      customerId,
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer: customerId,
        line_items: [{ price: TEST_PRICE_CUSTOM_CREDIT_UNIT, quantity: 20 }],
        discounts: [{ coupon: couponId }],
      }),
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).toHaveBeenLastCalledWith(
      expect.not.objectContaining({
        allow_promotion_codes: true,
      }),
    );
  });

  it("preserves the credit purchase preview timestamp at confirmation", async () => {
    const fixture = await createSubscriptionOrg({ tier: "pro" });
    const paymentMethodId = `pm_credit_${randomUUID().slice(0, 8)}`;
    const couponId = `coupon_${randomUUID().slice(0, 8)}`;
    const invoiceId = `in_credit_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      default_payment_method: paymentMethodId,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: fixture.customerId,
      discount: {
        source: {
          type: "coupon",
          coupon: couponId,
        },
      },
    });
    const capturedAt = new Date("2026-09-09T04:00:00.000Z");
    mockNow(capturedAt);
    const impact = {
      clickId: "credit-preview-partner",
      capturedAt: capturedAt.toISOString(),
    };
    mockClerkUsers(context, [
      {
        id: fixture.userId,
        privateMetadata: { impact_attribution: impact },
      },
    ]);
    mockCreditPurchasePreview(fixture.customerId);

    const client = setupApp({
      context,
      routes: billingCreditCheckoutRoutes,
    })(billingCreditCheckoutContract);
    const preview = await accept(
      client.create({
        body: {
          credits: 20_000,
          previewExistingBilling: true,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
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
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        discounts: [{ coupon: couponId }],
      }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.not.objectContaining({ customer: fixture.customerId }),
    );
    if (!("previewToken" in preview.body)) {
      throw new Error("Expected a credit purchase preview");
    }

    const invalidConfirmation = await accept(
      client.confirm({
        body: { previewToken: `${preview.body.previewToken}invalid` },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(invalidConfirmation.body.error.code).toBe("BAD_REQUEST");
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();

    const draftInvoice = {
      id: invoiceId,
      hosted_invoice_url: null,
      customer: fixture.customerId,
      metadata: { purpose: "credit_purchase" },
      amount_due: 1800,
      currency: "usd",
      status: "draft",
      lines: { has_more: false, data: [] },
      parent: null,
    };
    context.mocks.stripe.invoices.create.mockResolvedValue(draftInvoice);
    let confirmedPurchaseId: string | null = null;
    context.mocks.stripe.invoiceItems.create.mockImplementation((rawParams) => {
      const params = rawParams as {
        readonly metadata?: Readonly<Record<string, string>>;
      };
      confirmedPurchaseId = params.metadata?.credit_purchase_preview_id ?? null;
      return Promise.resolve({
        id: `ii_credit_${randomUUID().slice(0, 8)}`,
      });
    });
    context.mocks.stripe.invoices.retrieve.mockImplementation(() => {
      if (!confirmedPurchaseId) {
        throw new Error("Expected a confirmed credit purchase ID");
      }
      return Promise.resolve({
        ...draftInvoice,
        lines: {
          has_more: false,
          data: [
            {
              id: `il_credit_${randomUUID().slice(0, 8)}`,
              amount: 2000,
              subtotal: 2000,
              metadata: {
                credit_purchase_preview_id: confirmedPurchaseId,
              },
              period: { start: currentSecond(), end: currentSecond() },
              parent: null,
            },
          ],
        },
      });
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      ...draftInvoice,
      status: "open",
    });
    context.mocks.stripe.invoices.pay.mockResolvedValue({
      ...draftInvoice,
      status: "paid",
    });

    mockNow(new Date(capturedAt.getTime() + 60_000));
    impact.clickId = "partner-after-preview";
    impact.capturedAt = new Date(capturedAt.getTime() + 60_000).toISOString();
    const confirmation = await accept(
      client.confirm({
        body: { previewToken: preview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: fixture.customerId,
        default_payment_method: paymentMethodId,
        discounts: [{ coupon: couponId }],
        metadata: expect.objectContaining({
          purpose: "credit_purchase",
          orgId: fixture.orgId,
          requestedCreditsAmount: "20000",
          purchaseCreatedAt: capturedAt.toISOString(),
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("credit-purchase:"),
      }),
    );
    expect(
      JSON.stringify(context.mocks.stripe.invoices.create.mock.calls),
    ).not.toContain("impact_");
    expect(context.mocks.stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: invoiceId,
        customer: fixture.customerId,
        pricing: { price: TEST_PRICE_CUSTOM_CREDIT_UNIT },
        quantity: 20,
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("credit-purchase:"),
      }),
    );
  });

  it("uses a legacy subscription source when no higher-priority card exists", async () => {
    const fixture = await createSubscriptionOrg({ tier: "pro" });
    const subscriptionSourceId = `card_${randomUUID().slice(0, 8)}`;
    const customerSourceId = `card_${randomUUID().slice(0, 8)}`;
    const invoiceId = `in_credit_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      default_payment_method: null,
      default_source: subscriptionSourceId,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: fixture.customerId,
      discount: null,
      invoice_settings: { default_payment_method: null },
      default_source: customerSourceId,
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    mockCreditPurchasePreview(fixture.customerId);

    const client = setupApp({
      context,
      routes: billingCreditCheckoutRoutes,
    })(billingCreditCheckoutContract);
    const preview = await accept(
      client.create({
        body: {
          credits: 20_000,
          supportsInAppPreview: true,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in preview.body)) {
      throw new Error("Expected a credit purchase preview");
    }

    const draftInvoice = {
      id: invoiceId,
      hosted_invoice_url: null,
      customer: fixture.customerId,
      metadata: { purpose: "credit_purchase" },
      amount_due: 2000,
      currency: "usd",
      status: "draft",
      lines: { has_more: false, data: [] },
      parent: null,
    };
    context.mocks.stripe.invoices.create.mockResolvedValue(draftInvoice);
    let purchaseId: string | null = null;
    context.mocks.stripe.invoiceItems.create.mockImplementation((rawParams) => {
      const params = rawParams as {
        readonly metadata?: Readonly<Record<string, string>>;
      };
      purchaseId = params.metadata?.credit_purchase_preview_id ?? null;
      return Promise.resolve({ id: `ii_${randomUUID().slice(0, 8)}` });
    });
    context.mocks.stripe.invoices.retrieve.mockImplementation(() => {
      if (!purchaseId) {
        throw new Error("Expected a confirmed credit purchase ID");
      }
      return Promise.resolve({
        ...draftInvoice,
        status: "paid",
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${randomUUID().slice(0, 8)}`,
              amount: 2000,
              subtotal: 2000,
              metadata: { credit_purchase_preview_id: purchaseId },
              period: { start: currentSecond(), end: currentSecond() },
              parent: null,
            },
          ],
        },
      });
    });

    const confirmation = await accept(
      client.confirm({
        body: { previewToken: preview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: fixture.customerId,
        default_source: subscriptionSourceId,
      }),
      expect.any(Object),
    );
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.not.objectContaining({
        default_payment_method: expect.anything(),
      }),
      expect.any(Object),
    );
  });

  it("rejects payment when the finalized invoice amount differs from the preview", async () => {
    const fixture = await createSubscriptionOrg({ tier: "pro" });
    const paymentMethodId = `pm_credit_${randomUUID().slice(0, 8)}`;
    const invoiceId = `in_credit_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      default_payment_method: paymentMethodId,
    });
    mockCreditPurchasePreview(fixture.customerId);

    const client = setupApp({
      context,
      routes: billingCreditCheckoutRoutes,
    })(billingCreditCheckoutContract);
    const preview = await accept(
      client.create({
        body: {
          credits: 20_000,
          previewExistingBilling: true,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in preview.body)) {
      throw new Error("Expected a credit purchase preview");
    }

    const draftInvoice = {
      id: invoiceId,
      hosted_invoice_url: null,
      customer: fixture.customerId,
      metadata: { purpose: "credit_purchase" },
      amount_due: 2000,
      currency: "usd",
      status: "draft",
      lines: { has_more: false, data: [] },
      parent: null,
    };
    context.mocks.stripe.invoices.create.mockResolvedValue(draftInvoice);
    let confirmedPurchaseId: string | null = null;
    context.mocks.stripe.invoiceItems.create.mockImplementation((rawParams) => {
      const params = rawParams as {
        readonly metadata?: Readonly<Record<string, string>>;
      };
      confirmedPurchaseId = params.metadata?.credit_purchase_preview_id ?? null;
      return Promise.resolve({
        id: `ii_credit_${randomUUID().slice(0, 8)}`,
      });
    });
    context.mocks.stripe.invoices.retrieve.mockImplementation(() => {
      if (!confirmedPurchaseId) {
        throw new Error("Expected a confirmed credit purchase ID");
      }
      return Promise.resolve({
        ...draftInvoice,
        lines: {
          has_more: false,
          data: [
            {
              id: `il_credit_${randomUUID().slice(0, 8)}`,
              amount: 2000,
              subtotal: 2000,
              metadata: {
                credit_purchase_preview_id: confirmedPurchaseId,
              },
              period: { start: currentSecond(), end: currentSecond() },
              parent: null,
            },
          ],
        },
      });
    });
    const changedInvoice = {
      ...draftInvoice,
      amount_due: 1900,
      status: "open",
    };
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue(
      changedInvoice,
    );
    context.mocks.stripe.invoices.voidInvoice.mockResolvedValue({
      ...changedInvoice,
      status: "void",
    });

    const confirmation = await accept(
      client.confirm({
        body: { previewToken: preview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(confirmation.body.error.code).toBe("BAD_REQUEST");
    expect(context.mocks.stripe.invoices.voidInvoice).toHaveBeenCalledWith(
      invoiceId,
      {},
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("credit-purchase:"),
      }),
    );
    expect(context.mocks.stripe.invoices.pay).not.toHaveBeenCalled();
  });

  it("returns completed when customer balance pays the invoice during finalization", async () => {
    const fixture = await createSubscriptionOrg({ tier: "pro" });
    const paymentMethodId = `pm_credit_${randomUUID().slice(0, 8)}`;
    const invoiceId = `in_credit_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      default_payment_method: paymentMethodId,
    });
    mockCreditPurchasePreview(fixture.customerId);

    const client = setupApp({
      context,
      routes: billingCreditCheckoutRoutes,
    })(billingCreditCheckoutContract);
    const preview = await accept(
      client.create({
        body: {
          credits: 20_000,
          previewExistingBilling: true,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in preview.body)) {
      throw new Error("Expected a credit purchase preview");
    }

    const draftInvoice = {
      id: invoiceId,
      hosted_invoice_url: null,
      customer: fixture.customerId,
      metadata: { purpose: "credit_purchase" },
      amount_due: 2000,
      currency: "usd",
      status: "draft",
      lines: { has_more: false, data: [] },
      parent: null,
    };
    context.mocks.stripe.invoices.create.mockResolvedValue(draftInvoice);
    let confirmedPurchaseId: string | null = null;
    context.mocks.stripe.invoiceItems.create.mockImplementation((rawParams) => {
      const params = rawParams as {
        readonly metadata?: Readonly<Record<string, string>>;
      };
      confirmedPurchaseId = params.metadata?.credit_purchase_preview_id ?? null;
      return Promise.resolve({
        id: `ii_credit_${randomUUID().slice(0, 8)}`,
      });
    });
    context.mocks.stripe.invoices.retrieve.mockImplementation(() => {
      if (!confirmedPurchaseId) {
        throw new Error("Expected a confirmed credit purchase ID");
      }
      return Promise.resolve({
        ...draftInvoice,
        lines: {
          has_more: false,
          data: [
            {
              id: `il_credit_${randomUUID().slice(0, 8)}`,
              amount: 2000,
              subtotal: 2000,
              metadata: {
                credit_purchase_preview_id: confirmedPurchaseId,
              },
              period: { start: currentSecond(), end: currentSecond() },
              parent: null,
            },
          ],
        },
      });
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      ...draftInvoice,
      amount_due: 0,
      status: "paid",
    });

    const confirmation = await accept(
      client.confirm({
        body: { previewToken: preview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.invoices.pay).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.voidInvoice).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.del).not.toHaveBeenCalled();
  });

  it("returns the hosted invoice when saved-billing payment requires authentication", async () => {
    const fixture = await createSubscriptionOrg({ tier: "pro" });
    const paymentMethodId = `pm_credit_${randomUUID().slice(0, 8)}`;
    const invoiceId = `in_credit_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      default_payment_method: paymentMethodId,
    });
    mockCreditPurchasePreview(fixture.customerId);

    const client = setupApp({
      context,
      routes: billingCreditCheckoutRoutes,
    })(billingCreditCheckoutContract);
    const preview = await accept(
      client.create({
        body: {
          credits: 20_000,
          previewExistingBilling: true,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in preview.body)) {
      throw new Error("Expected a credit purchase preview");
    }

    const draftInvoice = {
      id: invoiceId,
      hosted_invoice_url: null,
      customer: fixture.customerId,
      metadata: { purpose: "credit_purchase" },
      amount_due: 2000,
      currency: "usd",
      status: "draft",
      lines: { has_more: false, data: [] },
      parent: null,
    };
    context.mocks.stripe.invoices.create.mockResolvedValue(draftInvoice);
    let confirmedPurchaseId: string | null = null;
    context.mocks.stripe.invoiceItems.create.mockImplementation((rawParams) => {
      const params = rawParams as {
        readonly metadata?: Readonly<Record<string, string>>;
      };
      confirmedPurchaseId = params.metadata?.credit_purchase_preview_id ?? null;
      return Promise.resolve({
        id: `ii_credit_${randomUUID().slice(0, 8)}`,
      });
    });
    const finalizedInvoice = {
      ...draftInvoice,
      status: "open",
      hosted_invoice_url:
        "https://invoice.stripe.com/saved-billing-authentication",
    };
    context.mocks.stripe.invoices.retrieve
      .mockImplementationOnce(() => {
        if (!confirmedPurchaseId) {
          throw new Error("Expected a confirmed credit purchase ID");
        }
        return Promise.resolve({
          ...draftInvoice,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_credit_${randomUUID().slice(0, 8)}`,
                amount: 2000,
                subtotal: 2000,
                metadata: {
                  credit_purchase_preview_id: confirmedPurchaseId,
                },
                period: { start: currentSecond(), end: currentSecond() },
                parent: null,
              },
            ],
          },
        });
      })
      .mockResolvedValueOnce(finalizedInvoice);
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue(
      finalizedInvoice,
    );
    context.mocks.stripe.invoices.pay.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        code: "invoice_payment_intent_requires_action",
        message: "This payment requires customer authentication",
      }),
    );

    const confirmation = await accept(
      client.confirm({
        body: { previewToken: preview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl:
        "https://invoice.stripe.com/saved-billing-authentication",
    });
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      invoiceId,
      {},
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("billing-operation:credit:"),
      }),
    );
    expect(context.mocks.stripe.invoices.retrieve).toHaveBeenCalledTimes(2);
  });

  it("falls back to Stripe checkout when saved billing is unavailable", async () => {
    const fixture = await createSubscriptionOrg({ tier: "pro" });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      default_payment_method: null,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: fixture.customerId,
      discount: null,
      invoice_settings: { default_payment_method: null },
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/credit-fallback",
    });

    const response = await accept(
      setupApp({ context, routes: billingCreditCheckoutRoutes })(
        billingCreditCheckoutContract,
      ).create({
        body: {
          credits: 20_000,
          previewExistingBilling: true,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/credit-fallback",
    });
  });

  it("returns Checkout when all saved cards are removed after preview", async () => {
    const fixture = await createSubscriptionOrg({ tier: "pro" });
    const paymentMethodId = `pm_credit_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      default_payment_method: paymentMethodId,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: fixture.customerId,
      discount: null,
    });
    mockCreditPurchasePreview(fixture.customerId);
    const client = setupApp({
      context,
      routes: billingCreditCheckoutRoutes,
    })(billingCreditCheckoutContract);
    const previewedAt = nowDate();
    mockNow(previewedAt);
    const preview = await accept(
      client.create({
        body: {
          credits: 20_000,
          supportsInAppPreview: true,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in preview.body)) {
      throw new Error("Expected a credit purchase preview");
    }

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      default_payment_method: null,
      default_source: null,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: fixture.customerId,
      discount: null,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/cards-removed",
    });

    mockNow(new Date(previewedAt.getTime() + 60_000));
    const confirmation = await accept(
      client.confirm({
        body: { previewToken: preview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toStrictEqual({
      status: "checkout_required",
      checkoutUrl: "https://checkout.stripe.com/session/cards-removed",
    });
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          purchaseCreatedAt: previewedAt.toISOString(),
        }),
        invoice_creation: expect.objectContaining({
          invoice_data: expect.objectContaining({
            metadata: expect.objectContaining({
              purchaseCreatedAt: previewedAt.toISOString(),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("credit-purchase:"),
      }),
    );
  });

  it("rejects credit checkout when the plan capability is disabled", async () => {
    const fixture = await createPublicBillingOrg();
    await fixture.run(async () => {
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

      const response = await accept(
        setupApp({ context, routes: billingCreditCheckoutRoutes })(
          billingCreditCheckoutContract,
        ).create({
          body: {
            credits: 20_000,
            successUrl: `${APP_ORIGIN}/billing?credit=success`,
            cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [400],
      );

      expect(response.body.error).toStrictEqual({
        message: "Credit purchases are not available for this workspace",
        code: "BAD_REQUEST",
      });
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).not.toHaveBeenCalled();
    });
  });

  it("creates credit checkout for agent tokens with billing write capability", async () => {
    const fixture = await trackedSeed();
    await seedMemberRole({
      orgId: fixture.orgId,
      userId: fixture.userId,
      role: "admin",
    });

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/zero-credit",
    });
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["billing:write"],
    });

    const client = setupApp({
      context,
      routes: billingCreditCheckoutRoutes,
    })(billingCreditCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          credits: 20_000,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/zero-credit",
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer: customerId,
      }),
    );
  });

  it("creates custom amount credit checkout with the configured Stripe price", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/custom-credit",
    });

    const client = setupApp({
      context,
      routes: billingCreditCheckoutRoutes,
    })(billingCreditCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          credits: 150_000,
          customAmount: true,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/custom-credit",
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer: customerId,
        line_items: [{ price: TEST_PRICE_CUSTOM_CREDIT_UNIT, quantity: 150 }],
        allow_promotion_codes: true,
        invoice_creation: {
          enabled: true,
          invoice_data: {
            metadata: {
              type: "credit_purchase",
              purpose: "credit_purchase",
              orgId: fixture.orgId,
              purchaseCreatedAt: expect.any(String),
              creditsAmountMode: "amount_subtotal",
              requestedCreditsAmount: "150000",
            },
          },
        },
        metadata: {
          purpose: "credit_purchase",
          orgId: fixture.orgId,
          purchaseCreatedAt: expect.any(String),
          creditsAmountMode: "amount_subtotal",
          requestedCreditsAmount: "150000",
        },
        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata: {
            type: "credit_purchase",
            purpose: "credit_purchase",
            orgId: fixture.orgId,
            purchaseCreatedAt: expect.any(String),
            creditsAmountMode: "amount_subtotal",
            requestedCreditsAmount: "150000",
          },
        },
      }),
    );
  });

  it("returns 400 when credit price is not configured", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockEnv("OKOU_PRICE_CUSTOM_CREDIT_UNIT", undefined);

    const client = setupApp({
      context,
      routes: billingCreditCheckoutRoutes,
    })(billingCreditCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          credits: 100_000,
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Custom credit price not configured",
        code: "BAD_REQUEST",
      },
    });
  });
});
