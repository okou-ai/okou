import { randomUUID } from "node:crypto";
import StripeSDK from "stripe";
import { describe, expect, it } from "vitest";
import {
  billingAutoRechargeContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { billingAutoRechargeRoutes } from "../billing-auto-recharge";
import { billingStatusRoutes } from "../billing-status";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function autoRechargeApi() {
  return setupApp({ context, routes: billingAutoRechargeRoutes })(
    billingAutoRechargeContract,
  );
}

function billingStatusApi() {
  return setupApp({ context, routes: billingStatusRoutes })(
    billingStatusContract,
  );
}

function signIn(admin: ApiTestUser): void {
  createRouteMocks(context).clerk.session(
    admin.userId,
    admin.orgId,
    "org:admin",
  );
}

async function freeWorkspace(): Promise<ApiTestUser> {
  const bdd = createBddApi(context);
  const admin = bdd.user();
  await bdd.provisionWorkspace(admin);
  signIn(admin);
  return admin;
}

async function proWorkspace(): Promise<ApiTestUser> {
  const admin = createBddApi(context).user();
  signIn(admin);
  await publicPlanLifecycle(context, admin, "pro").update("active");
  signIn(admin);
  return admin;
}

/** Stripe customer with a default card; invoices are created and finalized open. */
function stripeInvoicing(paymentMethod: string | null = "pm_test"): void {
  context.mocks.stripe.customers.retrieve.mockImplementation(
    (customerId: unknown) => {
      return Promise.resolve({
        id: customerId,
        metadata: {},
        invoice_settings: { default_payment_method: paymentMethod },
      });
    },
  );
  // Each recharge attempt is a distinct Stripe invoice echoing its request.
  context.mocks.stripe.invoices.create.mockImplementation((params: unknown) => {
    return Promise.resolve({
      ...(typeof params === "object" && params !== null ? params : {}),
      id: `in_auto_${randomUUID()}`,
    });
  });
  context.mocks.stripe.invoiceItems.create.mockResolvedValue({
    id: `ii_auto_${randomUUID()}`,
  });
  context.mocks.stripe.invoices.finalizeInvoice.mockImplementation(
    (invoiceId: unknown) => {
      return Promise.resolve({ id: invoiceId, status: "open" });
    },
  );
  context.mocks.stripe.invoices.pay.mockImplementation((invoiceId: unknown) => {
    return Promise.resolve({ id: invoiceId, status: "paid" });
  });
}

function cardDeclined(): Error {
  return new StripeSDK.errors.StripeCardError({
    type: "card_error",
    code: "card_declined",
    message: "Your card was declined.",
  });
}

function declineEveryPayment(): void {
  context.mocks.stripe.invoices.pay.mockRejectedValue(cardDeclined());
}

async function readStatus() {
  const response = await accept(billingStatusApi().get({ headers }), [200]);
  return response.body;
}

async function readCredits(): Promise<number> {
  return (await readStatus()).credits;
}

async function readConfig() {
  const response = await accept(autoRechargeApi().get({ headers }), [200]);
  return response.body;
}

async function enable(threshold: number, amount: number) {
  const response = await accept(
    autoRechargeApi().update({
      headers,
      body: { enabled: true, threshold, amount },
    }),
    [200],
  );
  return response.body;
}

async function lastCreatedInvoiceId(): Promise<string> {
  const results = context.mocks.stripe.invoices.create.mock.results;
  const invoice = (await results[results.length - 1]?.value) as {
    id: string;
  };
  return invoice.id;
}

async function deliverAutoRechargePaid(args: {
  readonly invoiceId: string;
  readonly orgId: string;
  readonly credits: number;
}): Promise<void> {
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();
  await webhooks.postStripeEvent(
    {
      id: `evt_${randomUUID()}`,
      type: "invoice.paid",
      created: Math.floor(now() / 1000),
      data: {
        object: {
          id: args.invoiceId,
          customer: null,
          subtotal: 0,
          metadata: {
            type: "auto_recharge",
            orgId: args.orgId,
            creditsAmount: String(args.credits),
          },
          parent: null,
          lines: { has_more: false, data: [] },
        },
      },
    },
    [200],
  );
  await flushWaitUntilForTest();
}

describe("GET /api/billing/auto-recharge", () => {
  it("billing-auto-recharge-004 shows auto-recharge off for a new Limited Free workspace", async () => {
    await freeWorkspace();

    await expect(readConfig()).resolves.toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
  });
});

describe("PUT /api/billing/auto-recharge", () => {
  it("billing-auto-recharge-007 enables auto-recharge for a Pro workspace", async () => {
    await proWorkspace();
    // Enabling below the threshold starts a recharge against the default card.
    stripeInvoicing();

    const response = await accept(
      autoRechargeApi().update({
        headers,
        body: { enabled: true, threshold: 1000, amount: 5000 },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: true,
      threshold: 1000,
      amount: 5000,
    });
    await expect(readConfig()).resolves.toStrictEqual({
      enabled: true,
      threshold: 1000,
      amount: 5000,
    });
  });

  it("billing-auto-recharge-008 charges the default card when enabled below the threshold", async () => {
    const admin = await proWorkspace();
    stripeInvoicing();
    const credits = await readCredits();
    const threshold = credits + 1000;
    const amount = threshold + 5000;

    await expect(enable(threshold, amount)).resolves.toStrictEqual({
      enabled: true,
      threshold,
      amount,
    });

    const invoiceId = await lastCreatedInvoiceId();
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: expect.stringMatching(/^cus_/),
        auto_advance: false,
        default_payment_method: "pm_test",
        metadata: expect.objectContaining({
          type: "auto_recharge",
          orgId: admin.orgId,
          creditsAmount: String(amount),
        }),
      }),
    );
    expect(context.mocks.stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: invoiceId,
        currency: "usd",
        amount: Math.ceil(amount / 1000) * 100,
      }),
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(invoiceId);
  });

  it("billing-auto-recharge-009 falls back to an attached card when no default payment method exists", async () => {
    const admin = await proWorkspace();
    stripeInvoicing(null);
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (subscriptionId: unknown) => {
        return Promise.resolve({
          id: subscriptionId,
          status: "active",
          default_payment_method: null,
        });
      },
    );
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({
      data: [{ id: "pm_attached_card" }],
    });
    const credits = await readCredits();
    const threshold = credits + 1000;
    const amount = threshold + 5000;

    await enable(threshold, amount);

    expect(context.mocks.stripe.paymentMethods.list).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: expect.stringMatching(/^cus_/),
        type: "card",
        limit: 1,
      }),
    );
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        default_payment_method: "pm_attached_card",
        metadata: expect.objectContaining({
          type: "auto_recharge",
          orgId: admin.orgId,
          creditsAmount: String(amount),
        }),
      }),
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      await lastCreatedInvoiceId(),
    );
  });

  it("billing-auto-recharge-010 grants a zero-due recharge invoice only once through its webhook", async () => {
    const admin = await proWorkspace();
    stripeInvoicing();
    context.mocks.stripe.invoices.finalizeInvoice.mockImplementation(
      (invoiceId: unknown) => {
        return Promise.resolve({
          id: invoiceId,
          status: "paid",
          amount_due: 0,
        });
      },
    );
    context.mocks.stripe.invoices.pay.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        code: "invoice_already_paid",
        message: "Invoice is already paid",
      }),
    );
    const credits = await readCredits();
    const threshold = credits + 1000;
    const amount = threshold + 5000;

    await enable(threshold, amount);
    await enable(threshold, amount);

    await expect(readCredits()).resolves.toBe(credits);
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.invoices.pay).not.toHaveBeenCalled();

    const invoiceId = await lastCreatedInvoiceId();
    await deliverAutoRechargePaid({
      invoiceId,
      orgId: admin.orgId ?? "",
      credits: amount,
    });
    await deliverAutoRechargePaid({
      invoiceId,
      orgId: admin.orgId ?? "",
      credits: amount,
    });

    const status = await readStatus();
    expect(status.credits).toBe(credits + amount);
    expect(
      status.creditGrants.filter((grant) => {
        return grant.source === "auto_recharge";
      }),
    ).toStrictEqual([expect.objectContaining({ amount, remaining: amount })]);

    await enable(credits + amount + 1000, credits + amount + 6000);
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(2);
    await expect(readCredits()).resolves.toBe(credits + amount);
  });

  it("billing-auto-recharge-011 grants a paid recharge invoice only once through its webhook", async () => {
    const admin = await proWorkspace();
    stripeInvoicing();
    const credits = await readCredits();
    const threshold = credits + 1000;
    const amount = threshold + 5000;

    await enable(threshold, amount);
    await enable(threshold, amount);

    await expect(readCredits()).resolves.toBe(credits);
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledOnce();
    const invoiceId = await lastCreatedInvoiceId();
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(invoiceId);

    await deliverAutoRechargePaid({
      invoiceId,
      orgId: admin.orgId ?? "",
      credits: amount,
    });
    await deliverAutoRechargePaid({
      invoiceId,
      orgId: admin.orgId ?? "",
      credits: amount,
    });

    const status = await readStatus();
    expect(status.credits).toBe(credits + amount);
    expect(
      status.creditGrants.filter((grant) => {
        return grant.source === "auto_recharge";
      }),
    ).toStrictEqual([expect.objectContaining({ amount, remaining: amount })]);

    await enable(credits + amount + 1000, credits + amount + 6000);
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(2);
    await expect(readCredits()).resolves.toBe(credits + amount);
  });

  it("billing-auto-recharge-014 grants no credits when the recharge payment is declined", async () => {
    await proWorkspace();
    stripeInvoicing();
    declineEveryPayment();
    const credits = await readCredits();
    const threshold = credits + 1000;
    const amount = credits + 6000;

    await enable(threshold, amount);
    await expect(readCredits()).resolves.toBe(credits);

    stripeInvoicing();
    await enable(threshold, amount);
    await expect(readCredits()).resolves.toBe(credits);
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(2);
  });

  it("billing-auto-recharge-019 turns off after three declined recharges and restarts the streak when re-enabled", async () => {
    await proWorkspace();
    stripeInvoicing();
    declineEveryPayment();
    const credits = await readCredits();
    const threshold = credits + 1000;
    const amount = threshold + 5000;
    const enabledConfig = { enabled: true, threshold, amount };
    const disabledConfig = {
      enabled: false,
      threshold,
      amount,
      disabledReason: "consecutive_failures",
    };

    await expect(enable(threshold, amount)).resolves.toStrictEqual(
      enabledConfig,
    );
    await expect(enable(threshold, amount)).resolves.toStrictEqual(
      enabledConfig,
    );
    await expect(enable(threshold, amount)).resolves.toStrictEqual(
      disabledConfig,
    );
    await expect(readConfig()).resolves.toStrictEqual(disabledConfig);
    const status = await readStatus();
    expect(status.autoRecharge).toStrictEqual(disabledConfig);
    expect(status.credits).toBe(credits);

    await expect(enable(threshold, amount)).resolves.toStrictEqual(
      enabledConfig,
    );
    await expect(enable(threshold, amount)).resolves.toStrictEqual(
      enabledConfig,
    );
    await expect(enable(threshold, amount)).resolves.toStrictEqual(
      disabledConfig,
    );
  });

  it("billing-auto-recharge-020 starts a new failure streak after a paid recharge", async () => {
    const admin = await proWorkspace();
    stripeInvoicing();
    context.mocks.stripe.invoices.pay
      .mockRejectedValueOnce(cardDeclined())
      .mockRejectedValueOnce(cardDeclined());
    const credits = await readCredits();
    const threshold = credits + 1000;
    const amount = threshold + 5000;

    await enable(threshold, amount);
    await enable(threshold, amount);
    await enable(threshold, amount);
    await deliverAutoRechargePaid({
      invoiceId: await lastCreatedInvoiceId(),
      orgId: admin.orgId ?? "",
      credits: amount,
    });
    await expect(readCredits()).resolves.toBe(credits + amount);

    declineEveryPayment();
    const nextThreshold = credits + amount + 1000;
    const nextAmount = nextThreshold + 5000;
    await enable(nextThreshold, nextAmount);
    await expect(enable(nextThreshold, nextAmount)).resolves.toStrictEqual({
      enabled: true,
      threshold: nextThreshold,
      amount: nextAmount,
    });
  });

  it("billing-auto-recharge-022 turns auto-recharge off after it triggered a recharge", async () => {
    await proWorkspace();
    stripeInvoicing();
    const credits = await readCredits();
    await enable(credits + 1000, credits + 6000);
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledOnce();

    const response = await accept(
      autoRechargeApi().update({ headers, body: { enabled: false } }),
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
    await expect(readConfig()).resolves.toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
  });

  it("billing-auto-recharge-023 rejects enabling for a Limited Free workspace", async () => {
    await freeWorkspace();

    const response = await accept(
      autoRechargeApi().update({
        headers,
        body: { enabled: true, threshold: 1000, amount: 5000 },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Auto-recharge is only available for Pro or Team workspaces",
        code: "BAD_REQUEST",
      },
    });
  });

  it("billing-auto-recharge-024 rejects enabling without threshold and amount", async () => {
    await proWorkspace();

    const response = await accept(
      autoRechargeApi().update({ headers, body: { enabled: true } }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "threshold and amount are required when enabling auto-recharge",
        code: "BAD_REQUEST",
      },
    });
  });

  it("billing-auto-recharge-025 rejects an amount below the minimum", async () => {
    await proWorkspace();

    const response = await accept(
      autoRechargeApi().update({
        headers,
        body: { enabled: true, threshold: 1000, amount: 500 },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "amount: Too small: expected number to be >=1000",
        code: "BAD_REQUEST",
      },
    });
  });

  it("billing-auto-recharge-028 rejects a threshold equal to the amount", async () => {
    await proWorkspace();

    const response = await accept(
      autoRechargeApi().update({
        headers,
        body: { enabled: true, threshold: 5000, amount: 5000 },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "threshold must be less than amount to avoid recharge loops",
    );
  });

  it("billing-auto-recharge-030 forbids a non-admin member from changing settings", async () => {
    const admin = await proWorkspace();
    createRouteMocks(context).clerk.session(
      `user_${randomUUID()}`,
      admin.orgId,
      "org:member",
    );

    const response = await accept(
      autoRechargeApi().update({
        headers,
        body: { enabled: true, threshold: 1000, amount: 5000 },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can update auto-recharge settings",
        code: "FORBIDDEN",
      },
    });
  });
});
