import { randomUUID } from "node:crypto";

import { billingAutoRechargeContract } from "@okouai/api-contracts/contracts/billing";
import StripeSDK from "stripe";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import { billingAutoRechargeRoutes } from "../billing-auto-recharge";

const context = testContext();
const bdd = createBddApi(context);
const billingApi = createBillingMediaApi(context);
const runsApi = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createRouteMocks(context);

const defaultAutoRechargeConfig = Object.freeze({
  enabled: false,
  threshold: null,
  amount: null,
});

type AutoRechargeActor = ApiTestUser & { readonly orgId: string };

function autoRechargeClient() {
  return setupApp({ context, routes: billingAutoRechargeRoutes })(
    billingAutoRechargeContract,
  );
}

function createActor(
  options: {
    readonly orgId?: string;
    readonly orgRole?: NonNullable<ApiTestUser["orgRole"]>;
  } = {},
): AutoRechargeActor {
  const user = bdd.user(options);
  if (!user.orgId) {
    throw new Error("Expected auto-recharge test actor to have an org");
  }
  return { ...user, orgId: user.orgId };
}

async function createOnboardedActor(): Promise<AutoRechargeActor> {
  const admin = createActor();
  const completed = await bdd.completeOnboarding(admin);
  expect(completed.status).toBe(200);
  await seedOrgMetadata({
    orgId: admin.orgId,
    tier: "limited-free-1",
    credits: 0,
  });
  return admin;
}

async function createProActor(
  options?: Parameters<typeof runsApi.grantProEntitlement>[1],
): Promise<{
  readonly admin: AutoRechargeActor;
  readonly entitlement: {
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly invoiceId: string;
  };
}> {
  const admin = createActor();
  const entitlement = await runsApi.grantProEntitlement(admin, options);
  return { admin, entitlement };
}

function acceptAutoRechargeStripeInvoice(customerId: string): string {
  const invoiceId = `in_auto_recharge_${randomUUID().slice(0, 8)}`;
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    deleted: false,
    metadata: {},
    invoice_settings: { default_payment_method: "pm_test" },
  });
  context.mocks.stripe.invoices.create.mockResolvedValue({ id: invoiceId });
  context.mocks.stripe.invoiceItems.create.mockResolvedValue({
    id: `ii_auto_recharge_${randomUUID().slice(0, 8)}`,
  });
  context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
    id: invoiceId,
    status: "open",
  });
  context.mocks.stripe.invoices.pay.mockResolvedValue({
    id: invoiceId,
    status: "paid",
  });
  return invoiceId;
}

describe("GET /api/billing/auto-recharge", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = autoRechargeClient();

    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the user has no active org", async () => {
    const user = bdd.user({ orgId: null });
    mocks.clerk.session(user.userId, null);

    const client = autoRechargeClient();

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
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

  it("returns the org auto-recharge config after a public api update", async () => {
    const { admin } = await createProActor();
    await billingApi.updateAutoRecharge(
      admin,
      {
        enabled: true,
        threshold: 2000,
        amount: 10_000,
      },
      [200],
    );

    const response = await billingApi.readAutoRecharge(admin);

    expect(response).toStrictEqual({
      enabled: true,
      threshold: 2000,
      amount: 10_000,
    });
  });

  it("returns default config for a new org metadata row", async () => {
    const admin = await createOnboardedActor();
    const response = await billingApi.readAutoRecharge(admin);

    expect(response).toStrictEqual(defaultAutoRechargeConfig);
  });

  it("returns the legacy default when the org metadata row does not exist", async () => {
    const admin = createActor();
    const response = await billingApi.readAutoRecharge(admin);

    expect(response).toStrictEqual(defaultAutoRechargeConfig);
  });
});

describe("PUT /api/billing/auto-recharge", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = autoRechargeClient();

    const response = await accept(
      client.update({
        body: { enabled: true, threshold: 1000, amount: 5000 },
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

  it("enables auto-recharge for pro tier org", async () => {
    const { admin } = await createProActor();

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 1000, amount: 5000 },
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: true,
      threshold: 1000,
      amount: 5000,
    });

    const readBack = await billingApi.readAutoRecharge(admin);
    expect(readBack).toStrictEqual(response.body);
  });

  it("enables auto-recharge for custom tier org", async () => {
    const admin = await createOnboardedActor();
    await seedOrgMetadata({
      orgId: admin.orgId,
      tier: "custom",
      credits: 0,
    });

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 1000, amount: 5000 },
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: true,
      threshold: 1000,
      amount: 5000,
    });
  });

  it("creates and pays an invoice when enabling auto-recharge below threshold", async () => {
    const { admin, entitlement } = await createProActor();
    const status = await billingApi.readBillingStatus(admin);
    const threshold = status.credits + 1000;
    const amount = threshold + 5000;
    const invoiceId = acceptAutoRechargeStripeInvoice(entitlement.customerId);

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold, amount },
      [200],
    );

    expect(response.body).toStrictEqual({
      enabled: true,
      threshold,
      amount,
    });
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: entitlement.customerId,
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
        customer: entitlement.customerId,
        amount: Math.ceil(amount / 1000) * 100,
        currency: "usd",
      }),
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(invoiceId);
  });

  it("uses an attached card when no default payment method is configured", async () => {
    const { admin, entitlement } = await createProActor();
    const status = await billingApi.readBillingStatus(admin);
    const threshold = status.credits + 1000;
    const amount = threshold + 5000;
    const invoiceId = acceptAutoRechargeStripeInvoice(entitlement.customerId);

    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: entitlement.customerId,
      deleted: false,
      invoice_settings: { default_payment_method: null },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: entitlement.subscriptionId,
      default_payment_method: null,
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({
      data: [{ id: "pm_attached_card" }],
    });

    await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold, amount },
      [200],
    );

    expect(context.mocks.stripe.paymentMethods.list).toHaveBeenCalledWith({
      customer: entitlement.customerId,
      type: "card",
      limit: 1,
    });
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: entitlement.customerId,
        default_payment_method: "pm_attached_card",
        metadata: expect.objectContaining({
          type: "auto_recharge",
          orgId: admin.orgId,
          creditsAmount: String(amount),
        }),
      }),
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(invoiceId);
  });

  it.each([
    "zero-due",
    "payment",
    "already-paid",
    "already-paid-no-code",
  ] as const)(
    "keeps a %s invoice pending until its webhook grants credits exactly once",
    async (outcome) => {
      const { admin, entitlement } = await createProActor();
      const before = await billingApi.readBillingStatus(admin);
      const threshold = before.credits + 1000;
      const amount = threshold + 5000;
      const invoiceId = acceptAutoRechargeStripeInvoice(entitlement.customerId);
      const amountPaid =
        outcome === "zero-due" ? 0 : Math.ceil(amount / 1000) * 100;

      if (outcome === "zero-due") {
        context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
          id: invoiceId,
          status: "paid",
          amount_due: 0,
          amount_paid: 0,
        });
        context.mocks.stripe.invoices.pay.mockRejectedValue(
          new StripeSDK.errors.StripeInvalidRequestError({
            type: "invalid_request_error",
            code: "invoice_already_paid",
            message: "Invoice is already paid",
          }),
        );
      } else if (
        outcome === "already-paid" ||
        outcome === "already-paid-no-code"
      ) {
        context.mocks.stripe.invoices.pay.mockRejectedValue(
          new StripeSDK.errors.StripeInvalidRequestError({
            type: "invalid_request_error",
            ...(outcome === "already-paid"
              ? { code: "invoice_already_paid" }
              : {}),
            message: "Invoice is already paid",
          }),
        );
        context.mocks.stripe.invoices.retrieve.mockResolvedValue({
          id: invoiceId,
          status: "paid",
        });
      }

      const config = { enabled: true, threshold, amount };
      await billingApi.updateAutoRecharge(admin, config, [200]);
      await billingApi.updateAutoRecharge(admin, config, [200]);

      expect((await billingApi.readBillingStatus(admin)).credits).toBe(
        before.credits,
      );
      expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(1);
      expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledTimes(
        outcome === "zero-due" ? 0 : 1,
      );
      if (outcome === "already-paid" || outcome === "already-paid-no-code") {
        expect(context.mocks.stripe.invoices.retrieve).toHaveBeenCalledWith(
          invoiceId,
        );
      }

      webhooks.configureStripeWebhookSecret();
      const event = {
        id: `evt_auto_recharge_${randomUUID()}`,
        type: "invoice.paid",
        data: {
          object: {
            id: invoiceId,
            customer: entitlement.customerId,
            status: "paid",
            amount_paid: amountPaid,
            metadata: {
              type: "auto_recharge",
              orgId: admin.orgId,
              creditsAmount: String(amount),
            },
            lines: { has_more: false, data: [] },
            parent: null,
          },
        },
      };
      await webhooks.postStripeEvent(event, [200]);
      await webhooks.postStripeEvent(
        { ...event, id: `evt_auto_recharge_duplicate_${randomUUID()}` },
        [200],
      );

      const after = await billingApi.readBillingStatus(admin);
      expect(after.credits).toBe(before.credits + amount);
      const grants = after.creditGrants.filter((grant) => {
        return grant.source === "auto_recharge";
      });
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({ amount, remaining: amount });

      acceptAutoRechargeStripeInvoice(entitlement.customerId);
      await billingApi.updateAutoRecharge(
        admin,
        {
          enabled: true,
          threshold: after.credits + 1000,
          amount: after.credits + 6000,
        },
        [200],
      );
      expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(2);
      expect((await billingApi.readBillingStatus(admin)).credits).toBe(
        after.credits,
      );
    },
  );

  it.each([
    "payment-failed",
    "already-paid-but-open",
    "status-lookup-failed",
    "finalized-void",
    "payment-still-open",
  ] as const)(
    "keeps %s on the failure path without granting credits",
    async (outcome) => {
      const { admin, entitlement } = await createProActor();
      const before = await billingApi.readBillingStatus(admin);
      const invoiceId = acceptAutoRechargeStripeInvoice(entitlement.customerId);

      if (outcome === "payment-failed") {
        context.mocks.stripe.invoices.pay.mockRejectedValue(
          new StripeSDK.errors.StripeCardError({
            type: "card_error",
            code: "card_declined",
            message: "Your card was declined",
          }),
        );
      } else if (outcome === "finalized-void") {
        context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
          id: invoiceId,
          status: "void",
        });
      } else if (outcome === "payment-still-open") {
        context.mocks.stripe.invoices.pay.mockResolvedValue({
          id: invoiceId,
          status: "open",
        });
      } else {
        context.mocks.stripe.invoices.pay.mockRejectedValue(
          new StripeSDK.errors.StripeInvalidRequestError({
            type: "invalid_request_error",
            code: "invoice_already_paid",
            message: "Invoice is already paid",
          }),
        );
        if (outcome === "status-lookup-failed") {
          context.mocks.stripe.invoices.retrieve.mockRejectedValue(
            new Error("Stripe temporarily unavailable"),
          );
        } else {
          context.mocks.stripe.invoices.retrieve.mockResolvedValue({
            id: invoiceId,
            status: "open",
          });
        }
      }

      const config = {
        enabled: true,
        threshold: before.credits + 1000,
        amount: before.credits + 6000,
      };
      await billingApi.updateAutoRecharge(admin, config, [200]);
      expect((await billingApi.readBillingStatus(admin)).credits).toBe(
        before.credits,
      );
      if (outcome === "finalized-void") {
        expect(context.mocks.stripe.invoices.pay).not.toHaveBeenCalled();
      }

      acceptAutoRechargeStripeInvoice(entitlement.customerId);
      await billingApi.updateAutoRecharge(admin, config, [200]);
      expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(2);
      expect((await billingApi.readBillingStatus(admin)).credits).toBe(
        before.credits,
      );
    },
  );

  it("disables auto-recharge after a public recharge trigger", async () => {
    const { admin, entitlement } = await createProActor();
    const status = await billingApi.readBillingStatus(admin);
    acceptAutoRechargeStripeInvoice(entitlement.customerId);
    await billingApi.updateAutoRecharge(
      admin,
      {
        enabled: true,
        threshold: status.credits + 1000,
        amount: status.credits + 6000,
      },
      [200],
    );

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: false },
      [200],
    );

    expect(response.body).toStrictEqual(defaultAutoRechargeConfig);

    const readBack = await billingApi.readAutoRecharge(admin);
    expect(readBack).toStrictEqual(response.body);
  });

  it("returns 400 when enabling on a suspended org", async () => {
    const admin = await createOnboardedActor();

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 1000, amount: 5000 },
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Auto-recharge is only available for Pro, Team, or Custom workspaces",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 400 when enabling without threshold and amount", async () => {
    const { admin } = await createProActor();

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true },
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

  it("returns 400 when amount is below minimum", async () => {
    const { admin } = await createProActor();

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 1000, amount: 500 },
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "amount: Too small: expected number to be >=1000",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 400 when amount exceeds the maximum", async () => {
    const { admin } = await createProActor();

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 1000, amount: 10_000_001 },
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "amount: Too big: expected number to be <=10000000",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 400 when threshold exceeds the maximum", async () => {
    const { admin } = await createProActor();

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 10_000_001, amount: 10_000_000 },
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "threshold: Too big: expected number to be <=10000000",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 400 when threshold equals amount", async () => {
    const { admin } = await createProActor();

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 5000, amount: 5000 },
      [400],
    );

    expect(response.body).toMatchObject({
      error: {
        message: "threshold must be less than amount to avoid recharge loops",
      },
    });
  });

  it("returns 400 when threshold is greater than amount", async () => {
    const { admin } = await createProActor();

    const response = await billingApi.updateAutoRecharge(
      admin,
      { enabled: true, threshold: 6000, amount: 5000 },
      [400],
    );

    expect(response.body).toMatchObject({
      error: {
        message: "threshold must be less than amount to avoid recharge loops",
      },
    });
  });

  it("returns 403 for non-admin member", async () => {
    const admin = createActor();
    const member = createActor({
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    await runsApi.grantProEntitlement(admin);

    const response = await billingApi.updateAutoRecharge(
      member,
      { enabled: true, threshold: 1000, amount: 5000 },
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
