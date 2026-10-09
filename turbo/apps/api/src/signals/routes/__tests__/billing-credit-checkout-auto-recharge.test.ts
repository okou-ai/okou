import {
  billingAutoRechargeContract,
  billingCreditCheckoutContract,
} from "@okouai/api-contracts/contracts/billing";
import { accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { billingAutoRechargeRoutes } from "../billing-auto-recharge";
import { billingCreditCheckoutRoutes } from "../billing-credit-checkout";
import { createBillingCheckoutFixture } from "./helpers/billing-checkout-fixture";

const {
  context,
  mocks,
  APP_ORIGIN,
  setTierPrices,
  createOrgFixture,
  createPublicBillingOrg,
  readBillingStatus,
  currentSecond,
} = createBillingCheckoutFixture();

const checkoutUrl = "https://checkout.stripe.com/session/credit-auto-recharge";
const enabledConfig = Object.freeze({
  enabled: true,
  threshold: 5000,
  amount: 20_000,
});
const checkoutBody = Object.freeze({
  credits: 20_000,
  successUrl: `${APP_ORIGIN}/billing?credit=success`,
  cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
});
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function creditClient() {
  return setupApp({ context, routes: billingCreditCheckoutRoutes })(
    billingCreditCheckoutContract,
  );
}

async function readAutoRecharge() {
  const response = await accept(
    setupApp({ context, routes: billingAutoRechargeRoutes })(
      billingAutoRechargeContract,
    ).get({ headers }),
    [200],
  );
  return response.body;
}

describe("credit checkout auto-recharge ownership", () => {
  beforeEach(() => {
    setTierPrices();
    mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      discount: null,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: checkoutUrl,
    });
  });

  it("publishes a default Plan before rejecting auto-recharge for a new workspace", async () => {
    const fixture = createOrgFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = creditClient();
    const response = await accept(
      client.create({
        body: { ...checkoutBody, autoRecharge: enabledConfig },
        headers,
      }),
      [400],
    );
    expect(response.body.error).toStrictEqual({
      message:
        "Auto-recharge is only available for Pro, Team, or Custom workspaces",
      code: "BAD_REQUEST",
    });
    await expect(readAutoRecharge()).resolves.toStrictEqual({
      enabled: false,
      threshold: null,
      amount: null,
    });
    const subsequent = await accept(
      client.create({ body: checkoutBody, headers }),
      [400],
    );
    expect(subsequent.body.error).toStrictEqual({
      message: "Credit purchases are not available for this workspace",
      code: "BAD_REQUEST",
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("updates repeated enabled checkout config without replacing the existing Plan, then disables after hosted checkout", async () => {
    const fixture = await createPublicBillingOrg("pro");
    await fixture.run(async () => {
      const client = creditClient();
      for (const config of [
        enabledConfig,
        { enabled: true, threshold: 10_000, amount: 50_000 },
      ]) {
        const response = await accept(
          client.create({
            body: { ...checkoutBody, autoRecharge: config },
            headers,
          }),
          [200],
        );
        expect(response.body).toStrictEqual({ url: checkoutUrl });
        await expect(readAutoRecharge()).resolves.toStrictEqual(config);
        await expect(readBillingStatus(fixture)).resolves.toMatchObject({
          tier: "pro",
          canBuyCredits: true,
          autoRechargeAllowed: true,
        });
      }
      const disabled = await accept(
        client.create({
          body: { ...checkoutBody, autoRecharge: { enabled: false } },
          headers,
        }),
        [200],
      );
      expect(disabled.body).toStrictEqual({ url: checkoutUrl });
      await expect(readAutoRecharge()).resolves.toStrictEqual({
        enabled: false,
        threshold: null,
        amount: null,
      });
    });
  });

  it.each([true, false])(
    "preserves config commit ordering when hosted Checkout fails (enabled=%s)",
    async (enabled) => {
      const fixture = await createPublicBillingOrg("pro");
      await fixture.run(async () => {
        const client = creditClient();
        await accept(
          client.create({
            body: { ...checkoutBody, autoRecharge: enabledConfig },
            headers,
          }),
          [200],
        );
        const nextConfig = {
          enabled,
          threshold: 10_000,
          amount: 50_000,
        };
        context.mocks.stripe.checkout.sessions.create.mockRejectedValueOnce(
          new Error("Stripe Checkout unavailable"),
        );
        const failed = await accept(
          client.create({
            body: { ...checkoutBody, autoRecharge: nextConfig },
            headers,
          }),
          [500],
        );
        expect(failed.body).toStrictEqual({ error: "Internal server error" });
        await expect(readAutoRecharge()).resolves.toStrictEqual(
          enabled ? nextConfig : enabledConfig,
        );
        const recovered = await accept(
          client.create({ body: checkoutBody, headers }),
          [200],
        );
        expect(recovered.body).toStrictEqual({ url: checkoutUrl });
        await expect(readAutoRecharge()).resolves.toStrictEqual(
          enabled ? nextConfig : enabledConfig,
        );
      });
    },
  );

  it("leaves auto-recharge enabled when a disable request returns an in-app preview", async () => {
    const fixture = await createPublicBillingOrg("pro");
    await fixture.run(async () => {
      const client = creditClient();
      await accept(
        client.create({
          body: { ...checkoutBody, autoRecharge: enabledConfig },
          headers,
        }),
        [200],
      );
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: fixture.subscriptionId,
        customer: fixture.customerId,
        default_payment_method: "pm_credit_preview",
      });
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: fixture.customerId,
        discount: null,
      });
      context.mocks.stripe.invoices.createPreview.mockImplementation(
        (rawParams) => {
          const params = rawParams as {
            readonly invoice_items: readonly {
              readonly metadata: Readonly<Record<string, string>>;
            }[];
          };
          return Promise.resolve({
            id: "in_credit_preview",
            amount_due: 2000,
            currency: "usd",
            status: null,
            lines: {
              has_more: false,
              data: [
                {
                  id: "il_credit_preview",
                  amount: 2000,
                  subtotal: 2000,
                  metadata: params.invoice_items[0]?.metadata,
                  period: { start: currentSecond(), end: currentSecond() },
                  parent: null,
                },
              ],
            },
            parent: null,
          });
        },
      );
      context.mocks.stripe.checkout.sessions.create.mockClear();
      const preview = await accept(
        client.create({
          body: {
            ...checkoutBody,
            supportsInAppPreview: true,
            autoRecharge: { enabled: false },
          },
          headers,
        }),
        [200],
      );
      expect(preview.body).toMatchObject({
        status: "preview",
        credits: 20_000,
        amountCents: 2000,
        previewToken: expect.any(String),
      });
      await expect(readAutoRecharge()).resolves.toStrictEqual(enabledConfig);
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).not.toHaveBeenCalled();
    });
  });

  it("rejects confirmation for a workspace without credit-purchase capability", async () => {
    const fixture = await createPublicBillingOrg();
    await fixture.run(async () => {
      const response = await accept(
        creditClient().confirm({
          body: { previewToken: "not-a-valid-preview" },
          headers,
        }),
        [400],
      );
      expect(response.body.error).toStrictEqual({
        message: "Credit purchases are not available for this workspace",
        code: "BAD_REQUEST",
      });
      expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();
    });
  });

  it.each([
    { enabled: true, amount: 20_000 },
    { enabled: true, threshold: 5000 },
    { enabled: true, threshold: 20_000, amount: 20_000 },
  ])(
    "rejects invalid enabled config without changing persisted settings (%j)",
    async (autoRecharge) => {
      const fixture = await createPublicBillingOrg("pro");
      await fixture.run(async () => {
        const response = await accept(
          creditClient().create({
            body: { ...checkoutBody, autoRecharge },
            headers,
          }),
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
    },
  );

  it("returns the provider-config guard before authentication for both routes", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);
    const client = creditClient();
    const unauthenticated = { authorization: "Bearer unavailable-session" };
    const created = await accept(
      client.create({ body: checkoutBody, headers: unauthenticated }),
      [503],
    );
    const confirmed = await accept(
      client.confirm({
        body: { previewToken: "not-a-valid-preview" },
        headers: unauthenticated,
      }),
      [503],
    );
    for (const response of [created, confirmed]) {
      expect(response.body.error).toStrictEqual({
        message: "Billing not configured",
        code: "PROVIDER_UNAVAILABLE",
      });
    }
  });
});
