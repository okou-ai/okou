import { randomUUID } from "node:crypto";
import {
  billingCheckoutContract,
  billingUsagePackCheckoutContract,
  billingUsagePackCreditsContract,
  type UsagePackCreditsResponse,
} from "@okouai/api-contracts/contracts/billing";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import StripeSDK from "stripe";
import { accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import {
  mockStripeClient,
  type StripeInvoice,
} from "../../external/stripe-client";
import { createDeferredPromise } from "../../utils";
import { billingCheckoutRoutes } from "../billing-checkout";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { webhooksStripeRoutes } from "../webhooks-stripe";

import { createBillingCheckoutFixture } from "./helpers/billing-checkout-fixture";

const {
  context,
  mocks,
  APP_ORIGIN,
  TEST_PRICE_PRO,
  TEST_PRICE_USAGE_PACK_PLAN_PRO,
  TEST_PRICE_USAGE_PACK_20,
  STRIPE_WEBHOOK_SECRET,
  setTierPrices,
  setUsagePackPrices,
  mockUsagePackCatalog,
  currentSecond,
  stripeInputMetadata,
  createOrgFixture,
  usagePackCheckoutBody,
  authenticateOrg,
  mockClerkOrganization,
  readBillingStatus,
  createStripeCustomerOrgForFixture,
  createSubscriptionOrg,
} = createBillingCheckoutFixture();

describe("POST /api/billing/checkout/complete", () => {
  function normalizeCreditGrants(
    credits: UsagePackCreditsResponse,
  ): UsagePackCreditsResponse {
    return {
      ...credits,
      creditGrants: [...credits.creditGrants].sort((a, b) => {
        return a.id.localeCompare(b.id);
      }),
      ...(credits.memberCredits === undefined
        ? {}
        : {
            memberCredits: credits.memberCredits.map((member) => {
              return {
                ...member,
                creditGrants: [...member.creditGrants].sort((a, b) => {
                  return a.id.localeCompare(b.id);
                }),
              };
            }),
          }),
    };
  }

  beforeEach(() => {
    setTierPrices();
  });

  it.each(["plan", "usage pack"] as const)(
    "reconciles a paid %s checkout before its webhook arrives without duplicating credits",
    async (purchaseType) => {
      mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
      mockNow(now());
      setUsagePackPrices();
      mockUsagePackCatalog();
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
      const fixture = createOrgFixture();
      authenticateOrg(fixture);
      mockClerkOrganization(fixture);
      const customerId = `cus_${randomUUID()}`;
      const subscriptionId = `sub_${randomUUID()}`;
      const sessionId = `cs_${randomUUID()}`;
      const period = {
        start: currentSecond(),
        end: currentSecond() + 30 * 86_400,
      };
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [
            {
              role: "org:admin",
              publicUserData: { userId: fixture.userId },
              createdAt: now(),
            },
          ],
        },
      );
      context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
        { data: [] },
      );
      context.mocks.stripe.customers.create.mockResolvedValue({
        id: customerId,
      });
      let metadata: Readonly<Record<string, string>> = {};
      context.mocks.stripe.checkout.sessions.create.mockImplementation(
        (input) => {
          metadata = stripeInputMetadata(input);
          return Promise.resolve({
            id: sessionId,
            url: `https://checkout.stripe.com/session/${sessionId}`,
          });
        },
      );
      const app = setupApp({ context, routes: billingCheckoutRoutes });
      if (purchaseType === "usage pack") {
        await accept(
          app(billingUsagePackCheckoutContract).create({
            body: usagePackCheckoutBody(fixture.userId),
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200],
        );
      } else {
        await accept(
          app(billingCheckoutContract).create({
            body: {
              tier: "pro",
              successUrl: `${APP_ORIGIN}/billing?billing=success`,
              cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
            },
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200],
        );
      }

      const items =
        purchaseType === "usage pack"
          ? [
              { priceId: TEST_PRICE_USAGE_PACK_PLAN_PRO, amount: 0 },
              { priceId: TEST_PRICE_USAGE_PACK_20, amount: 2000 },
            ]
          : [{ priceId: TEST_PRICE_PRO, amount: 2000 }];
      const paidInvoice: StripeInvoice = {
        id: `in_${randomUUID()}`,
        customer: customerId,
        metadata,
        status: "paid",
        amount_due: 2000,
        amount_paid: 2000,
        currency: "usd",
        parent: {
          subscription_details: { subscription: subscriptionId, metadata },
        },
        lines: {
          has_more: false,
          data: items.map(({ priceId, amount }) => {
            return {
              id: `il_${randomUUID()}`,
              amount,
              subtotal: amount,
              quantity: 1,
              price: { id: priceId },
              period,
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: false },
              },
            };
          }),
        },
      };
      const subscription = {
        id: subscriptionId,
        customer: customerId,
        status: "active",
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: null,
        trial_end: null,
        metadata,
        latest_invoice: paidInvoice,
        items: {
          data: items.map(({ priceId }) => {
            return {
              id: `si_${randomUUID()}`,
              price: { id: priceId },
              quantity: 1,
              current_period_start: period.start,
              current_period_end: period.end,
            };
          }),
        },
      };
      context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
        id: sessionId,
        mode: "subscription",
        status: "complete",
        customer: customerId,
        subscription: subscriptionId,
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        ...subscription,
        latest_invoice: { ...paidInvoice, status: "open", amount_paid: 0 },
      });
      const complete = async () => {
        return await accept(
          app(billingCheckoutContract).complete({
            body: { sessionId },
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200],
        );
      };
      expect((await complete()).body).toStrictEqual({ completed: false });
      expect((await readBillingStatus(fixture)).tier).not.toBe("pro");

      // Both requests must observe the unpaid local plan before either can
      // project the newly paid invoice.
      const bothRetrieving = createDeferredPromise<void>(context.signal);
      let retrieves = 0;
      context.mocks.stripe.subscriptions.retrieve.mockImplementation(
        async () => {
          retrieves += 1;
          if (retrieves === 2) {
            bothRetrieving.resolve();
          }
          await bothRetrieving.promise;
          return subscription;
        },
      );
      const responses = await Promise.all([complete(), complete()]);
      const completedBody = {
        completed: true,
      };
      for (const response of responses) {
        expect(response.body).toStrictEqual(completedBody);
      }
      const statusBeforeWebhook = await readBillingStatus(fixture);
      expect(statusBeforeWebhook).toMatchObject({
        tier: "pro",
        hasSubscription: true,
        subscriptionStatus: "active",
        currentPeriodEnd: new Date(period.end * 1000).toISOString(),
        ...(purchaseType === "plan" ? { credits: 20_000 } : {}),
      });
      const readCredits = async () => {
        return await accept(
          setupApp({ context, routes: billingUsagePackCreditsRoutes })(
            billingUsagePackCreditsContract,
          ).get({ headers: { authorization: "Bearer clerk-session" } }),
          [200],
        );
      };
      const creditsBeforeWebhook = await readCredits();
      if (purchaseType === "usage pack") {
        expect(creditsBeforeWebhook.body).toMatchObject({
          hasUsagePack: true,
          totalCredits: 20_400,
          purchasedCredits: 20_000,
          bonusCredits: 400,
        });
        expect(creditsBeforeWebhook.body.creditGrants).toHaveLength(2);
      }

      expect((await complete()).body).toStrictEqual(completedBody);
      const event = {
        id: `evt_${randomUUID()}`,
        created: currentSecond(),
        type: "invoice.paid",
        data: { object: paidInvoice },
      };
      context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
      await accept(
        setupApp({ context, routes: webhooksStripeRoutes })(
          webhookStripeContract,
        ).post({
          body: JSON.stringify(event),
          extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
        }),
        [200],
      );
      await expect(readBillingStatus(fixture)).resolves.toStrictEqual(
        statusBeforeWebhook,
      );
      // Equal creation timestamps do not define a stable grant order.
      expect(normalizeCreditGrants((await readCredits()).body)).toStrictEqual(
        normalizeCreditGrants(creditsBeforeWebhook.body),
      );
    },
  );

  async function trackedSeed(values?: {
    readonly stripeCustomerId?: string;
    readonly stripeSubscriptionId?: string;
    readonly subscriptionStatus?: string;
    readonly tier?: "pro" | "team";
  }): Promise<{ orgId: string; userId: string }> {
    if (values?.stripeSubscriptionId && values.tier) {
      return createSubscriptionOrg({
        customerId: values.stripeCustomerId,
        subscriptionId: values.stripeSubscriptionId,
        subscriptionStatus: values.subscriptionStatus,
        tier: values.tier,
      });
    }
    if (values?.stripeCustomerId) {
      const fixture = createOrgFixture();
      authenticateOrg(fixture);
      await createStripeCustomerOrgForFixture(fixture, values.stripeCustomerId);
      return fixture;
    }
    return createOrgFixture();
  }

  it("finds the plan item in a completed multi-item subscription", async () => {
    setUsagePackPrices();
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const fixture = await trackedSeed({
      stripeCustomerId: customerId,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_completed",
      mode: "subscription",
      status: "complete",
      customer: customerId,
      subscription: subscriptionId,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
      status: "trialing",
      cancel_at_period_end: false,
      items: {
        data: [
          {
            price: { id: TEST_PRICE_USAGE_PACK_20 },
            current_period_end: 1_800_000_000,
          },
          {
            price: { id: TEST_PRICE_USAGE_PACK_PLAN_PRO },
            current_period_end: 1_800_000_000,
          },
        ],
      },
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.complete({
        body: { sessionId: "cs_test_completed" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ completed: false });

    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("limited-free-1");
    expect(status.hasSubscription).toBeTruthy();
    expect(status.subscriptionStatus).toBe("trialing");
    expect(status.currentPeriodEnd).toBeNull();
  });

  it("keeps checkout pending when the subscription is incomplete", async () => {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const fixture = await trackedSeed({
      stripeCustomerId: customerId,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_completed",
      mode: "subscription",
      status: "complete",
      customer: customerId,
      subscription: subscriptionId,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
      status: "incomplete",
      cancel_at_period_end: false,
      items: {
        data: [
          {
            price: { id: TEST_PRICE_PRO },
            current_period_end: 1_800_000_000,
          },
        ],
      },
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.complete({
        body: { sessionId: "cs_test_completed" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ completed: false });

    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("limited-free-1");
    expect(status.hasSubscription).toBeTruthy();
    expect(status.subscriptionStatus).toBe("incomplete");
    expect(status.currentPeriodEnd).toBeNull();
  });

  it("returns 400 when completed checkout would downgrade the current tier", async () => {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const existingSubscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const checkoutSubscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const fixture = await trackedSeed({
      stripeCustomerId: customerId,
      stripeSubscriptionId: existingSubscriptionId,
      subscriptionStatus: "active",
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_completed",
      mode: "subscription",
      status: "complete",
      customer: customerId,
      subscription: checkoutSubscriptionId,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: checkoutSubscriptionId,
      status: "active",
      cancel_at_period_end: false,
      items: {
        data: [
          {
            price: { id: TEST_PRICE_PRO },
            current_period_end: 1_800_000_000,
          },
        ],
      },
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.complete({
        body: { sessionId: "cs_test_completed" },
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

    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("team");
    expect(status.hasSubscription).toBeTruthy();
    expect(status.subscriptionStatus).toBe("active");
  });

  it("returns completed false while Stripe has not completed the session", async () => {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const fixture = await trackedSeed({
      stripeCustomerId: customerId,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_open",
      mode: "subscription",
      status: "open",
      customer: customerId,
      subscription: null,
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.complete({
        body: { sessionId: "cs_test_open" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ completed: false });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("rejects an expired checkout instead of reporting it as pending", async () => {
    const customerId = `cus_${randomUUID()}`;
    const sessionId = `cs_${randomUUID()}`;
    const fixture = await trackedSeed({ stripeCustomerId: customerId });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: sessionId,
      mode: "subscription",
      status: "expired",
      customer: customerId,
      subscription: null,
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );
    const response = await accept(
      client.complete({
        body: { sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { code: "BAD_REQUEST", message: "Checkout session expired" },
    });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it.each(["complete", "expired"])(
    "rejects %s checkout sessions from another customer",
    async (status) => {
      const fixture = await trackedSeed({
        stripeCustomerId: `cus_${randomUUID().slice(0, 8)}`,
      });
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

      context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
        id: "cs_test_other_customer",
        mode: "subscription",
        status,
        customer: `cus_${randomUUID().slice(0, 8)}`,
        subscription: `sub_${randomUUID().slice(0, 8)}`,
      });

      const client = setupApp({ context, routes: billingCheckoutRoutes })(
        billingCheckoutContract,
      );

      const response = await accept(
        client.complete({
          body: { sessionId: "cs_test_other_customer" },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [400],
      );

      expect(response.body).toStrictEqual({
        error: {
          message: "Checkout session does not belong to current organization",
          code: "BAD_REQUEST",
        },
      });
    },
  );
});
