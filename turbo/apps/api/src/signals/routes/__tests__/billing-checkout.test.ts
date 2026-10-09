import { randomUUID } from "node:crypto";
import { billingCheckoutContract } from "@okouai/api-contracts/contracts/billing";
import StripeSDK from "stripe";
import { onTestFinished } from "vitest";
import { z } from "zod";
import { accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, nowDate } from "../../../lib/time";
import { mockStripeClient } from "../../external/stripe-client";
import { createDeferredPromise } from "../../utils";
import { billingCheckoutRoutes } from "../billing-checkout";

import { createBillingCheckoutFixture } from "./helpers/billing-checkout-fixture";

const {
  context,
  mocks,
  APP_ORIGIN,
  TEST_PRICE_PRO,
  TEST_PRICE_TEAM,
  setTierPrices,
  currentSecond,
  stripeInputMetadata,
  createOrgFixture,
  authenticateOrg,
  readBillingStatus,
  createSubscriptionOrg,
  createPublicBillingOrg,
  createUsagePackAtomGrantOrg,
} = createBillingCheckoutFixture();

describe("POST /api/billing/checkout", () => {
  beforeEach(() => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    setTierPrices();
    mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
  });

  function trackedSeed(): { orgId: string; userId: string } {
    return createOrgFixture();
  }

  function trackedBillingSeed(values: {
    readonly stripeCustomerId: string;
    readonly stripeSubscriptionId: string;
    readonly subscriptionStatus: string;
    readonly tier: "pro" | "team";
  }): Promise<{ orgId: string; userId: string }> {
    return createSubscriptionOrg({
      customerId: values.stripeCustomerId,
      subscriptionId: values.stripeSubscriptionId,
      subscriptionStatus: values.subscriptionStatus,
      tier: values.tier,
    });
  }

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
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
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: {},
      }),
      [401],
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 for invalid tier", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await client.create({
      body: {
        // typed contract z.enum(["pro","team"]) rejects this at parse time
        tier: "enterprise" as "pro",
        successUrl: `${APP_ORIGIN}/billing?billing=success`,
        cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
      },
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(400);
  });

  it("returns 400 before calling Stripe for an oversized return URL", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );
    const oversizedSuccessUrl = `${APP_ORIGIN}/billing?state=`.padEnd(
      5001,
      "x",
    );
    expect(oversizedSuccessUrl).toHaveLength(5001);
    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: oversizedSuccessUrl,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.status).toBe(400);
    expect(context.mocks.stripe.customers.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin org member", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
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

  it("returns checkout URL on success", async () => {
    const okouPricePro = "price_okou_pro";
    mockEnv("OKOU_PRICE_PRO", okouPricePro);
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/test",
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/test",
    });

    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith(
      {
        metadata: { orgId: fixture.orgId },
      },
      { idempotencyKey: `stripe-customer:development::${fixture.orgId}` },
    );
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: okouPricePro, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${APP_ORIGIN}/billing?billing=success`,
      cancel_url: `${APP_ORIGIN}/billing?billing=canceled`,
      metadata: {
        orgId: fixture.orgId,
        tier: "pro",
        priceId: okouPricePro,
        purchaseCreatedAt: expect.any(String),
      },
      subscription_data: {
        metadata: {
          orgId: fixture.orgId,
          tier: "pro",
          priceId: okouPricePro,
          purchaseCreatedAt: expect.any(String),
        },
      },
    });
  });

  it.each(["success", "lost_response"] as const)(
    "shares a published customer while another candidate returns %s",
    async (firstOutcome) => {
      const fixture = createOrgFixture();
      authenticateOrg(fixture);
      const firstStarted = createDeferredPromise<void>(context.signal);
      const firstResponse = createDeferredPromise<
        { readonly id: string } | "lost_response"
      >(context.signal);
      const candidate = { id: `cus_${randomUUID()}` };
      context.mocks.stripe.customers.create
        .mockImplementationOnce(async () => {
          firstStarted.resolve();
          const outcome = await firstResponse.promise;
          if (outcome === "lost_response") {
            throw new Error("Stripe customer response lost");
          }
          return outcome;
        })
        .mockResolvedValueOnce({ id: `cus_${randomUUID()}` });
      context.mocks.stripe.checkout.sessions.create.mockImplementation(
        (params) => {
          const { customer } = z.object({ customer: z.string() }).parse(params);
          return Promise.resolve({
            url: `https://checkout.stripe.com/session/${customer}`,
          });
        },
      );
      const client = setupApp({ context, routes: billingCheckoutRoutes })(
        billingCheckoutContract,
      );
      const request = {
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tier: "pro" as const,
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
      };
      const first = accept(client.create(request), [200]);
      onTestFinished(async () => {
        if (!firstResponse.settled()) {
          firstResponse.resolve(candidate);
        }
        if (!firstStarted.settled()) {
          firstStarted.resolve();
        }
        await Promise.allSettled([first]);
      });
      await firstStarted.promise;
      const second = await accept(client.create(request), [200]);
      if (firstOutcome === "lost_response") {
        firstResponse.resolve("lost_response");
      } else {
        firstResponse.resolve(candidate);
      }
      const recovered = await first;
      expect(recovered.body).toStrictEqual(second.body);
      await expect(readBillingStatus(fixture)).resolves.toMatchObject({
        tier: "limited-free-1",
        hasSubscription: false,
      });

      context.mocks.stripe.customers.create.mockRejectedValue(
        new Error("An existing customer must remain usable"),
      );
      const repeated = await accept(client.create(request), [200]);
      expect(repeated.body).toStrictEqual(second.body);
    },
  );

  it("recovers a customer after Stripe created it but its response was lost", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const customers = new Map<string, string>();
    let loseFirstResponse = true;
    context.mocks.stripe.customers.create.mockImplementation(
      (_params, options) => {
        const { idempotencyKey } = z
          .object({ idempotencyKey: z.string() })
          .parse(options);
        const id = customers.get(idempotencyKey) ?? `cus_${randomUUID()}`;
        customers.set(idempotencyKey, id);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          return Promise.reject(new Error("Stripe customer response lost"));
        }
        return Promise.resolve({ id });
      },
    );
    context.mocks.stripe.checkout.sessions.create.mockImplementation(
      (params) => {
        const { customer } = z.object({ customer: z.string() }).parse(params);
        return Promise.resolve({
          url: `https://checkout.stripe.com/session/${customer}`,
        });
      },
    );
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );
    const request = {
      headers: { authorization: "Bearer clerk-session" },
      body: {
        tier: "pro" as const,
        successUrl: `${APP_ORIGIN}/billing?billing=success`,
        cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
      },
    };
    await accept(client.create(request), [500]);
    const createdCustomer = [...customers.values()][0];
    expect(createdCustomer).toBeDefined();
    const recovered = await accept(client.create(request), [200]);
    expect(recovered.body).toStrictEqual({
      url: `https://checkout.stripe.com/session/${createdCustomer}`,
    });
    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      tier: "limited-free-1",
      hasSubscription: false,
    });
  });

  it.each(["admission", "creation"] as const)(
    "releases an unpublished Plan claim after a Stripe %s failure",
    async (failureStage) => {
      const fixture = createOrgFixture();
      authenticateOrg(fixture);
      const customerId = `cus_${randomUUID()}`;
      context.mocks.stripe.customers.create.mockResolvedValue({
        id: customerId,
      });
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        invoice_settings: { default_payment_method: `pm_${randomUUID()}` },
      });
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.invoices.createPreview.mockResolvedValue({
        amount_due: 2000,
        currency: "usd",
      });
      context.mocks.stripe.subscriptions.create.mockResolvedValue({
        id: `sub_${randomUUID()}`,
        latest_invoice: null,
      });
      const client = setupApp({ context, routes: billingCheckoutRoutes })(
        billingCheckoutContract,
      );
      const headers = { authorization: "Bearer clerk-session" };
      const preview = await accept(
        client.create({
          headers,
          body: {
            tier: "pro",
            supportsInAppPreview: true,
            successUrl: `${APP_ORIGIN}/billing?billing=success`,
            cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
          },
        }),
        [200],
      );
      if (!("previewToken" in preview.body)) {
        throw new Error("Expected a Plan purchase preview");
      }
      const failedProviderCall =
        failureStage === "admission"
          ? context.mocks.stripe.subscriptions.list
          : context.mocks.stripe.subscriptions.create;
      failedProviderCall.mockRejectedValueOnce(new Error("Stripe unavailable"));
      const request = {
        headers,
        body: { previewToken: preview.body.previewToken },
      };

      await accept(client.confirm(request), [500]);
      const retried = await accept(client.confirm(request), [200]);
      expect(retried.body).toStrictEqual({
        status: "completed",
        hostedInvoiceUrl: null,
      });
      await expect(readBillingStatus(fixture)).resolves.toMatchObject({
        tier: "limited-free-1",
        hasSubscription: false,
      });
    },
  );

  it("pays a saved-card Plan preview through the rollout-safe checkout route", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const paymentMethodId = `pm_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const periodStart = currentSecond();
    const periodEnd = periodStart + 30 * 86_400;
    const hostedInvoiceUrl =
      "https://invoice.stripe.com/plan-purchase-authentication";
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID().slice(0, 8)}`,
      hosted_invoice_url: null,
      customer: customerId,
      metadata: {},
      amount_due: 2000,
      currency: "usd",
      status: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    const operationInvoice = {
      id: `in_${randomUUID().slice(0, 8)}`,
      hosted_invoice_url: hostedInvoiceUrl,
      customer: customerId,
      metadata: {},
      amount_due: 2000,
      currency: "usd",
      status: "open",
      lines: {
        has_more: false,
        data: [
          {
            amount: 2000,
            price: { id: TEST_PRICE_PRO },
            parent: { type: "subscription_item_details" as const },
            period: { start: periodStart, end: periodEnd },
          },
        ],
      },
      parent: {
        subscription_details: {
          subscription: subscriptionId,
          metadata: {},
        },
      },
    };
    context.mocks.stripe.subscriptions.create.mockResolvedValue({
      id: subscriptionId,
      customer: customerId,
      status: "incomplete",
      metadata: {},
      latest_invoice: operationInvoice,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
      customer: customerId,
      status: "active",
      metadata: {},
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      items: {
        data: [
          {
            price: { id: TEST_PRICE_PRO },
            current_period_end: periodEnd,
          },
        ],
      },
    });
    context.mocks.stripe.invoices.pay.mockResolvedValue({
      ...operationInvoice,
      hosted_invoice_url: null,
      status: "paid",
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );
    const purchaseBody = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      successUrl: `${APP_ORIGIN}/billing?billing=success`,
      cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
    };
    const previewedAt = nowDate();
    mockNow(previewedAt);
    const start = await accept(
      client.create({
        body: purchaseBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(start.body).toMatchObject({
      status: "preview",
      purchaseType: "plan",
      tier: "pro",
      immediateAmountCents: 2000,
      nextRecurringAmountCents: 2000,
      currency: "usd",
      previewToken: expect.any(String),
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    if (!("previewToken" in start.body)) {
      throw new Error("Expected a Plan purchase preview");
    }

    mockNow(new Date(previewedAt.getTime() + 60_000));
    const confirmation = await accept(
      client.create({
        body: { ...purchaseBody, previewToken: start.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      2,
    );
    expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: customerId,
        default_payment_method: paymentMethodId,
        payment_behavior: "default_incomplete",
        metadata: expect.objectContaining({
          purchaseCreatedAt: previewedAt.toISOString(),
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("plan-purchase:"),
      }),
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      operationInvoice.id,
      {},
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("billing-operation:plan:"),
      }),
    );
    const billing = await readBillingStatus(fixture);
    expect(billing.tier).toBe("pro");
    expect(billing.subscriptionStatus).toBe("active");
    expect(billing.hasSubscription).toBeTruthy();
  });

  it("keeps an Atom grant when a confirmed Plan purchase fails to create its subscription", async () => {
    const fixture = await createUsagePackAtomGrantOrg("pro");
    await fixture.run(async () => {
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const customerId = `cus_${randomUUID().slice(0, 8)}`;
      const paymentMethodId = `pm_${randomUUID().slice(0, 8)}`;
      const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
      const periodStart = currentSecond();
      const periodEnd = periodStart + 30 * 86_400;
      context.mocks.stripe.customers.create.mockResolvedValue({
        id: customerId,
      });
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        invoice_settings: { default_payment_method: paymentMethodId },
      });
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.invoices.createPreview.mockResolvedValue({
        id: `in_preview_${randomUUID().slice(0, 8)}`,
        hosted_invoice_url: null,
        customer: customerId,
        metadata: {},
        amount_due: 20_000,
        currency: "usd",
        status: null,
        lines: { has_more: false, data: [] },
        parent: null,
      });
      // The Atom grant already bound a Stripe customer; the purchase uses it.
      const operationInvoice = (customer: string) => {
        return {
          id: `in_${subscriptionId}`,
          hosted_invoice_url: null,
          customer,
          metadata: {},
          amount_due: 20_000,
          currency: "usd",
          status: "open",
          lines: {
            has_more: false,
            data: [
              {
                amount: 20_000,
                price: { id: TEST_PRICE_TEAM },
                parent: { type: "subscription_item_details" as const },
                period: { start: periodStart, end: periodEnd },
              },
            ],
          },
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: {},
            },
          },
        };
      };
      context.mocks.stripe.subscriptions.create
        .mockRejectedValueOnce(new Error("Stripe subscription create failed"))
        .mockImplementation((params) => {
          const { customer } = z.object({ customer: z.string() }).parse(params);
          context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
            id: subscriptionId,
            customer,
            status: "active",
            metadata: {},
            cancel_at_period_end: false,
            cancel_at: null,
            schedule: null,
            trial_end: null,
            items: {
              data: [
                {
                  price: { id: TEST_PRICE_TEAM },
                  current_period_end: periodEnd,
                },
              ],
            },
          });
          context.mocks.stripe.invoices.pay.mockResolvedValue({
            ...operationInvoice(customer),
            status: "paid",
          });
          return Promise.resolve({
            id: subscriptionId,
            customer,
            status: "incomplete",
            metadata: {},
            latest_invoice: operationInvoice(customer),
          });
        });
      const client = setupApp({ context, routes: billingCheckoutRoutes })(
        billingCheckoutContract,
      );
      const purchaseBody = {
        tier: "team" as const,
        supportsInAppPreview: true,
        successUrl: `${APP_ORIGIN}/billing?billing=success`,
        cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
      };
      const preview = await accept(
        client.create({
          body: purchaseBody,
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      if (!("previewToken" in preview.body)) {
        throw new Error("Expected a Plan purchase preview");
      }
      const confirmRequest = {
        body: { ...purchaseBody, previewToken: preview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      };

      await accept(client.create(confirmRequest), [500]);

      await expect(readBillingStatus(fixture)).resolves.toMatchObject({
        tier: "pro",
        subscriptionStatus: "atom_grant",
        hasSubscription: false,
      });

      const confirmation = await accept(client.create(confirmRequest), [200]);

      expect(confirmation.body).toStrictEqual({
        status: "completed",
        hostedInvoiceUrl: null,
      });
      expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledTimes(
        2,
      );
      await expect(readBillingStatus(fixture)).resolves.toMatchObject({
        tier: "team",
        subscriptionStatus: "active",
        hasSubscription: true,
      });
    });
  });

  it("resumes a pending Team purchase and applies it before returning", async () => {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const pendingTeamSubscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const activeProSubscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const fixture = await trackedBillingSeed({
      stripeCustomerId: customerId,
      stripeSubscriptionId: pendingTeamSubscriptionId,
      subscriptionStatus: "incomplete",
      tier: "pro",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const paymentMethodId = `pm_${randomUUID().slice(0, 8)}`;
    const periodStart = currentSecond();
    const periodEnd = periodStart + 30 * 86_400;
    const invoiceId = `in_${randomUUID().slice(0, 8)}`;
    const pendingPurchaseMetadata = {
      orgId: fixture.orgId,
      tier: "team",
      priceId: TEST_PRICE_TEAM,
      billingPurchaseId: `purchase_${randomUUID().slice(0, 8)}`,
    };
    let teamPaid = false;

    const teamInvoice = () => {
      return {
        id: invoiceId,
        hosted_invoice_url: teamPaid
          ? null
          : "https://invoice.stripe.com/pending-team",
        customer: customerId,
        metadata: {},
        amount_due: 20_000,
        currency: "usd",
        status: teamPaid ? ("paid" as const) : ("open" as const),
        lines: {
          has_more: false,
          data: [
            {
              amount: 20_000,
              price: { id: TEST_PRICE_TEAM },
              parent: { type: "subscription_item_details" as const },
              period: { start: periodStart, end: periodEnd },
            },
          ],
        },
        parent: {
          subscription_details: {
            subscription: pendingTeamSubscriptionId,
            metadata: pendingPurchaseMetadata,
          },
        },
      };
    };
    const pendingTeamSubscription = () => {
      return {
        id: pendingTeamSubscriptionId,
        customer: customerId,
        status: teamPaid ? "active" : "incomplete",
        metadata: pendingPurchaseMetadata,
        default_payment_method: paymentMethodId,
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: null,
        trial_end: null,
        items: {
          data: [
            {
              price: { id: TEST_PRICE_TEAM },
              current_period_end: periodEnd,
            },
          ],
        },
        latest_invoice: teamInvoice(),
      };
    };
    const activeProSubscription = {
      id: activeProSubscriptionId,
      customer: customerId,
      status: "active",
      metadata: { orgId: fixture.orgId },
      default_payment_method: paymentMethodId,
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      items: {
        data: [
          {
            price: { id: TEST_PRICE_PRO },
            current_period_end: periodEnd,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (subscriptionId) => {
        if (subscriptionId === pendingTeamSubscriptionId) {
          return Promise.resolve(pendingTeamSubscription());
        }
        if (subscriptionId === activeProSubscriptionId) {
          return Promise.resolve(activeProSubscription);
        }
        throw new Error(`Unexpected Stripe subscription ${subscriptionId}`);
      },
    );
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [pendingTeamSubscription(), activeProSubscription],
      has_more: false,
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID().slice(0, 8)}`,
      hosted_invoice_url: null,
      customer: customerId,
      metadata: {},
      amount_due: 20_000,
      currency: "usd",
      status: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    context.mocks.stripe.invoices.pay.mockImplementation(() => {
      teamPaid = true;
      return Promise.resolve(teamInvoice());
    });
    context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
      id: activeProSubscriptionId,
      status: "canceled",
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );
    const purchaseBody = {
      tier: "team" as const,
      supportsInAppPreview: true,
      successUrl: `${APP_ORIGIN}/billing?billing=success`,
      cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
    };
    const start = await accept(
      client.create({
        body: purchaseBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in start.body)) {
      throw new Error("Expected a Team purchase preview");
    }

    const confirmation = await accept(
      client.create({
        body: { ...purchaseBody, previewToken: start.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.subscriptions.create).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      invoiceId,
      {},
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("billing-operation:plan:"),
      }),
    );
    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      activeProSubscriptionId,
      { invoice_now: false, prorate: false },
    );
    const billing = await readBillingStatus(fixture);
    expect(billing.tier).toBe("team");
    expect(billing.subscriptionStatus).toBe("active");
    expect(billing.hasSubscription).toBeTruthy();
  });

  it("rejects a resumable Plan purchase after its saved card changes", async () => {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const pendingSubscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const fixture = await trackedBillingSeed({
      stripeCustomerId: customerId,
      stripeSubscriptionId: pendingSubscriptionId,
      subscriptionStatus: "incomplete",
      tier: "pro",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const previewPaymentMethodId = `pm_${randomUUID().slice(0, 8)}`;
    const replacementPaymentMethodId = `pm_${randomUUID().slice(0, 8)}`;
    const periodStart = currentSecond();
    const periodEnd = periodStart + 30 * 86_400;
    const invoiceId = `in_${randomUUID().slice(0, 8)}`;
    let currentPaymentMethodId = previewPaymentMethodId;
    const metadata = {
      orgId: fixture.orgId,
      tier: "team",
      priceId: TEST_PRICE_TEAM,
      billingPurchaseId: `purchase_${randomUUID().slice(0, 8)}`,
    };
    const invoice = {
      id: invoiceId,
      hosted_invoice_url: "https://invoice.stripe.com/pending-team",
      customer: customerId,
      metadata: {},
      amount_due: 20_000,
      currency: "usd",
      status: "open" as const,
      lines: {
        has_more: false,
        data: [
          {
            amount: 20_000,
            price: { id: TEST_PRICE_TEAM },
            parent: { type: "subscription_item_details" as const },
            period: { start: periodStart, end: periodEnd },
          },
        ],
      },
      parent: {
        subscription_details: {
          subscription: pendingSubscriptionId,
          metadata,
        },
      },
    };
    const pendingSubscription = () => {
      return {
        id: pendingSubscriptionId,
        customer: customerId,
        status: "incomplete",
        metadata,
        default_payment_method: currentPaymentMethodId,
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: null,
        trial_end: null,
        items: {
          data: [
            {
              price: { id: TEST_PRICE_TEAM },
              current_period_end: periodEnd,
            },
          ],
        },
        latest_invoice: invoice,
      };
    };
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (subscriptionId) => {
        if (subscriptionId !== pendingSubscriptionId) {
          throw new Error(`Unexpected Stripe subscription ${subscriptionId}`);
        }
        return Promise.resolve(pendingSubscription());
      },
    );
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [pendingSubscription()],
      has_more: false,
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID().slice(0, 8)}`,
      hosted_invoice_url: null,
      customer: customerId,
      metadata: {},
      amount_due: 20_000,
      currency: "usd",
      status: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );
    const start = await accept(
      client.create({
        body: {
          tier: "team",
          supportsInAppPreview: true,
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in start.body)) {
      throw new Error("Expected a Team purchase preview");
    }
    currentPaymentMethodId = replacementPaymentMethodId;

    const confirmation = await accept(
      client.confirm({
        body: { previewToken: start.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(confirmation.body).toStrictEqual({
      error: {
        message: "Plan purchase preview is no longer valid",
        code: "CONFLICT",
      },
    });
    expect(context.mocks.stripe.invoices.pay).not.toHaveBeenCalled();
  });

  it("refreshes an invalid Plan preview through the rollout-safe checkout route", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const initialPaymentMethodId = `pm_${randomUUID().slice(0, 8)}`;
    const currentPaymentMethodId = `pm_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve
      .mockResolvedValueOnce({
        id: customerId,
        invoice_settings: {
          default_payment_method: initialPaymentMethodId,
        },
      })
      .mockResolvedValue({
        id: customerId,
        invoice_settings: { default_payment_method: currentPaymentMethodId },
      });
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID().slice(0, 8)}`,
      hosted_invoice_url: null,
      customer: customerId,
      metadata: {},
      amount_due: 2000,
      currency: "usd",
      status: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );
    const purchaseBody = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      successUrl: `${APP_ORIGIN}/billing?billing=success`,
      cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
    };
    const start = await accept(
      client.create({
        body: purchaseBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in start.body)) {
      throw new Error("Expected a Plan purchase preview");
    }

    const refreshed = await accept(
      client.create({
        body: { ...purchaseBody, previewToken: start.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
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
      previewToken: expect.any(String),
    });
    if (!("previewToken" in refreshed.body)) {
      throw new Error("Expected a refreshed Plan purchase preview");
    }
    expect(refreshed.body.previewToken).not.toBe(start.body.previewToken);
    expect(context.mocks.stripe.customers.retrieve).toHaveBeenCalledTimes(3);
    expect(context.mocks.stripe.subscriptions.create).not.toHaveBeenCalled();
  });

  it("rejects competing Plan previews and stale purchase replays", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const paymentMethodId = `pm_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID().slice(0, 8)}`,
      hosted_invoice_url: null,
      customer: customerId,
      metadata: {},
      amount_due: 2000,
      currency: "usd",
      status: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    interface CreatedSubscription {
      readonly id: string;
      readonly customer: string;
      status: string;
      readonly metadata: Readonly<Record<string, string>>;
      readonly items: {
        readonly data: readonly {
          readonly price: { readonly id: string };
        }[];
      };
    }
    // Stripe state is cumulative: every creation stays listable.
    const stripeSubscriptions: CreatedSubscription[] = [];
    context.mocks.stripe.subscriptions.list.mockImplementation(() => {
      const data = stripeSubscriptions.map((subscription) => {
        return { ...subscription };
      });
      return Promise.resolve({ data, has_more: false });
    });
    context.mocks.stripe.subscriptions.create.mockImplementation((input) => {
      const subscription: CreatedSubscription = {
        id: `sub_${randomUUID().slice(0, 8)}`,
        customer: customerId,
        status: "active",
        metadata: stripeInputMetadata(input),
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      };
      stripeSubscriptions.push(subscription);
      return Promise.resolve({ ...subscription, latest_invoice: null });
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );
    const purchaseBody = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      successUrl: `${APP_ORIGIN}/billing?billing=success`,
      cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
    };
    const firstPreview = await accept(
      client.create({
        body: purchaseBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const secondPreview = await accept(
      client.create({
        body: purchaseBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const laterTierPreview = await accept(
      client.create({
        body: { ...purchaseBody, tier: "team" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (
      !("previewToken" in firstPreview.body) ||
      !("previewToken" in secondPreview.body) ||
      !("previewToken" in laterTierPreview.body)
    ) {
      throw new Error("Expected two Plan purchase previews");
    }

    const confirmations = await Promise.all([
      client.confirm({
        body: { previewToken: firstPreview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      client.confirm({
        body: { previewToken: secondPreview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
    ]);

    expect(
      confirmations
        .map(({ status }) => {
          return status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    // The Pro creation is visible at Stripe before its paid webhook binds it
    // locally. A Team preview made against the old state cannot ignore it.
    const staleUpgrade = await accept(
      client.confirm({
        body: { previewToken: laterTierPreview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    expect(staleUpgrade.body).toStrictEqual({
      error: {
        message: "Plan purchase preview is no longer valid",
        code: "CONFLICT",
      },
    });
    // The local claim decided the winner before any provider write: the
    // loser never reached Stripe, so nothing had to be released.
    expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    const [createdSubscription] = stripeSubscriptions;
    if (!createdSubscription) {
      throw new Error("Expected the winning Pro subscription");
    }
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [
        createdSubscription,
        {
          ...createdSubscription,
          id: `sub_later_${randomUUID()}`,
          metadata: { orgId: fixture.orgId },
          items: { data: [{ price: { id: TEST_PRICE_TEAM } }] },
        },
      ],
      has_more: false,
    });
    // Even the original winning preview cannot resume an older purchase while
    // a different paid subscription now exists for this organization.
    const winningPreviewToken =
      confirmations[0]?.status === 200
        ? firstPreview.body.previewToken
        : secondPreview.body.previewToken;
    const replay = await accept(
      client.confirm({
        body: { previewToken: winningPreviewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    expect(replay.body).toStrictEqual(staleUpgrade.body);
    expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.pay).not.toHaveBeenCalled();
  });

  it("uses hosted Checkout when an opted-in plan purchase has no saved card", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/plan-no-card",
    });

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingCheckoutContract,
      ).create({
        body: {
          tier: "pro",
          supportsInAppPreview: true,
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/plan-no-card",
    });
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
  });

  it("tags preview Stripe checkout objects with the current job ref", async () => {
    mockEnv("ENV", "preview");
    mockOptionalEnv("OKOU_PREVIEW_JOB_REF", "pr-123");
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/preview",
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/preview",
    });
    const expectedPreviewMetadata = {
      vm0_environment: "preview",
      job_ref: "pr-123",
    };
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith(
      {
        metadata: {
          orgId: fixture.orgId,
          ...expectedPreviewMetadata,
        },
      },
      { idempotencyKey: `stripe-customer:preview:pr-123:${fixture.orgId}` },
    );
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          orgId: fixture.orgId,
          tier: "pro",
          priceId: TEST_PRICE_PRO,
          purchaseCreatedAt: expect.any(String),
          ...expectedPreviewMetadata,
        },
        subscription_data: expect.objectContaining({
          metadata: {
            orgId: fixture.orgId,
            tier: "pro",
            priceId: TEST_PRICE_PRO,
            purchaseCreatedAt: expect.any(String),
            ...expectedPreviewMetadata,
          },
        }),
      }),
    );
  });

  it("returns 400 when checkout would downgrade the current tier", async () => {
    const fixture = await trackedBillingSeed({
      stripeCustomerId: `cus_${randomUUID().slice(0, 8)}`,
      stripeSubscriptionId: `sub_${randomUUID().slice(0, 8)}`,
      subscriptionStatus: "active",
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Cannot create Pro checkout while current tier is Team; use billing management to change plans",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 when checkout would duplicate the current tier", async () => {
    const fixture = await trackedBillingSeed({
      stripeCustomerId: `cus_${randomUUID().slice(0, 8)}`,
      stripeSubscriptionId: `sub_${randomUUID().slice(0, 8)}`,
      subscriptionStatus: "active",
      tier: "pro",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Cannot create Pro checkout while current tier is Pro; use billing management to change plans",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 for subscription checkout when current tier is custom", async () => {
    const fixture = await createPublicBillingOrg("custom");
    await fixture.run(async () => {
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

      const client = setupApp({ context, routes: billingCheckoutRoutes })(
        billingCheckoutContract,
      );

      for (const tier of ["pro", "team"] as const) {
        const response = await accept(
          client.create({
            body: {
              tier,
              successUrl: `${APP_ORIGIN}/billing?billing=success`,
              cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
            },
            headers: { authorization: "Bearer clerk-session" },
          }),
          [400],
        );

        expect(response.body).toStrictEqual({
          error: {
            message: `Cannot create ${tier === "pro" ? "Pro" : "Team"} checkout while current tier is Custom; use billing management to change plans`,
            code: "BAD_REQUEST",
          },
        });
      }
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).not.toHaveBeenCalled();
    });
  });

  it("attaches billing identity to the customer, checkout and subscription", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/plan",
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );
    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/plan",
    });
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith(
      {
        metadata: { orgId: fixture.orgId },
      },
      { idempotencyKey: `stripe-customer:development::${fixture.orgId}` },
    );
    const expectedMetadata = {
      orgId: fixture.orgId,
      tier: "pro",
      priceId: TEST_PRICE_PRO,
      purchaseCreatedAt: expect.any(String),
    };
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expectedMetadata,
        subscription_data: expect.objectContaining({
          metadata: expectedMetadata,
        }),
      }),
    );
  });

  it("rejects Pro trial checkout outside onboarding payment", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          trialDays: 7,
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Pro trial checkout is only available during onboarding",
        code: "BAD_REQUEST",
      },
    });
  });

  it("rejects trial checkout for non-Pro tiers", async () => {
    const fixture = createOrgFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "team",
          trialDays: 7,
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Trial checkout is only available for Pro tier",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 400 when successUrl origin does not match APP_URL", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: "https://evil.example.com/billing?billing=success",
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "successUrl and cancelUrl must match the platform origin",
        code: "BAD_REQUEST",
      },
    });
  });

  it("accepts successUrl on a first-party www.okou.ai origin", async () => {
    const fixture = createOrgFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/so-trial",
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: "https://www.okou.ai/billing?billing=pro",
          cancelUrl: "https://www.okou.ai/billing?billing=canceled",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/so-trial",
    });
  });

  it("returns 401 when caller has no org", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 when the tier price is unset", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    // Override the beforeEach setTierPrices() so activePriceId(tier) returns
    // undefined and the route falls into the "Price not configured" branch.
    mockEnv("OKOU_PRICE_PRO", undefined);

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Price not configured for pro tier",
        code: "BAD_REQUEST",
      },
    });
  });
});
