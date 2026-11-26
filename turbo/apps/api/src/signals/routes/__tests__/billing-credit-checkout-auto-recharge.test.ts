import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  billingAutoRechargeContract,
  billingCreditCheckoutContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { billingAutoRechargeRoutes } from "../billing-auto-recharge";
import { billingCreditCheckoutRoutes } from "../billing-credit-checkout";
import { billingStatusRoutes } from "../billing-status";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const CREDIT_UNIT_PRICE = "price_auto_recharge_credit_unit";
const SUCCESS_URL = "http://localhost:3002/settings/billing?credits=success";
const CANCEL_URL = "http://localhost:3002/settings/billing?credits=cancel";
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function creditCheckoutApi() {
  return setupApp({ context, routes: billingCreditCheckoutRoutes })(
    billingCreditCheckoutContract,
  );
}

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

function stripeHostedCheckout(): string {
  const sessionId = `cs_auto_recharge_${randomUUID()}`;
  const url = `https://checkout.stripe.test/${sessionId}`;
  context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
    id: sessionId,
    url,
  });
  return url;
}

function stripeCustomerDirectory(orgId: string): void {
  const customerId = `cus_auto_recharge_${randomUUID()}`;
  context.mocks.stripe.customers.create.mockResolvedValue({
    id: customerId,
    metadata: { orgId },
  });
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    metadata: { orgId },
  });
}

async function freeWorkspace(): Promise<ApiTestUser> {
  mockEnv("OKOU_PRICE_CUSTOM_CREDIT_UNIT", CREDIT_UNIT_PRICE);
  const bdd = createBddApi(context);
  const admin = bdd.user();
  await bdd.provisionWorkspace(admin);
  signIn(admin);
  return admin;
}

async function proWorkspace(): Promise<ApiTestUser> {
  mockEnv("OKOU_PRICE_CUSTOM_CREDIT_UNIT", CREDIT_UNIT_PRICE);
  const admin = createBddApi(context).user();
  signIn(admin);
  await publicPlanLifecycle(context, admin, "pro").update("active");
  signIn(admin);
  return admin;
}

async function checkout(autoRecharge?: {
  readonly enabled: boolean;
  readonly threshold?: number;
  readonly amount?: number;
}) {
  return await creditCheckoutApi().create({
    headers,
    body: {
      credits: 20_000,
      successUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
      ...(autoRecharge ? { autoRecharge } : {}),
    },
  });
}

/** Stripe echoes the requested invoice items as preview lines. */
function previewLines(params: unknown): { metadata: unknown }[] {
  const items =
    typeof params === "object" && params !== null && "invoice_items" in params
      ? params.invoice_items
      : [];
  return (Array.isArray(items) ? items : []).map((item: unknown) => {
    return {
      metadata:
        typeof item === "object" && item !== null && "metadata" in item
          ? item.metadata
          : {},
    };
  });
}

async function readAutoRecharge() {
  const response = await accept(autoRechargeApi().get({ headers }), [200]);
  return response.body;
}

describe("credit checkout auto-recharge ownership", () => {
  it("billing-credit-checkout-auto-recharge-001 rejects auto-recharge for a new workspace but still sells credits", async () => {
    mockEnv("OKOU_PRICE_CUSTOM_CREDIT_UNIT", CREDIT_UNIT_PRICE);
    const admin = createBddApi(context).user();
    signIn(admin);
    stripeCustomerDirectory(admin.orgId ?? "");
    const url = stripeHostedCheckout();

    const rejected = await accept(
      checkout({ enabled: true, threshold: 5000, amount: 20_000 }),
      [400],
    );
    expect(rejected.body.error).toStrictEqual({
      code: "BAD_REQUEST",
      message: "Auto-recharge is only available for Pro or Team workspaces",
    });
    await expect(readAutoRecharge()).resolves.toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });

    const plain = await accept(checkout(), [200]);
    expect(plain.body).toStrictEqual({ url });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).toHaveBeenCalledOnce();
  });

  it("billing-credit-checkout-auto-recharge-003 updates enabled settings on repeated checkouts and disables them later", async () => {
    await proWorkspace();
    const url = stripeHostedCheckout();

    for (const config of [
      { threshold: 5000, amount: 20_000 },
      { threshold: 10_000, amount: 50_000 },
    ]) {
      const response = await accept(
        checkout({ enabled: true, ...config }),
        [200],
      );
      expect(response.body).toStrictEqual({ url });
      await expect(readAutoRecharge()).resolves.toStrictEqual({
        enabled: true,
        ...config,
      });
      const status = await accept(billingStatusApi().get({ headers }), [200]);
      expect(status.body).toMatchObject({
        tier: "pro",
        canBuyCredits: true,
        autoRechargeAllowed: true,
      });
    }

    const disabled = await accept(checkout({ enabled: false }), [200]);
    expect(disabled.body).toStrictEqual({ url });
    await expect(readAutoRecharge()).resolves.toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
  });

  it("billing-credit-checkout-auto-recharge-006 keeps auto-recharge enabled when a disable request returns a preview", async () => {
    await proWorkspace();
    stripeHostedCheckout();
    await accept(
      checkout({ enabled: true, threshold: 5000, amount: 20_000 }),
      [200],
    );
    context.mocks.stripe.checkout.sessions.create.mockClear();
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (subscriptionId: unknown) => {
        return Promise.resolve({
          id: subscriptionId,
          status: "active",
          default_payment_method: "pm_auto_recharge_saved_card",
        });
      },
    );
    context.mocks.stripe.invoices.createPreview.mockImplementation(
      (params: unknown) => {
        return Promise.resolve({
          currency: "usd",
          amount_due: 2000,
          lines: { data: previewLines(params) },
        });
      },
    );

    const response = await accept(
      creditCheckoutApi().create({
        headers,
        body: {
          credits: 20_000,
          successUrl: SUCCESS_URL,
          cancelUrl: CANCEL_URL,
          supportsInAppPreview: true,
          autoRecharge: { enabled: false },
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      status: "preview",
      credits: 20_000,
      amountCents: 2000,
      previewToken: expect.any(String),
    });
    await expect(readAutoRecharge()).resolves.toStrictEqual({
      enabled: true,
      threshold: 5000,
      amount: 20_000,
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("billing-credit-checkout-auto-recharge-007 rejects an invalid preview token for a Free workspace", async () => {
    await freeWorkspace();

    const response = await accept(
      creditCheckoutApi().confirm({
        headers,
        body: { previewToken: "not-a-valid-preview" },
      }),
      [400],
    );

    expect(response.body.error).toStrictEqual({
      code: "BAD_REQUEST",
      message: "Credit purchase preview expired or is no longer valid",
    });
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();
  });

  it("billing-credit-checkout-auto-recharge-008 rejects an enabled config without a threshold and keeps settings disabled", async () => {
    await proWorkspace();
    stripeHostedCheckout();

    const response = await accept(
      checkout({ enabled: true, amount: 20_000 }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    await expect(readAutoRecharge()).resolves.toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });
});
