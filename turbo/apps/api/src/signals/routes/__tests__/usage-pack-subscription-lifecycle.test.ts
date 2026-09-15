import { randomUUID } from "node:crypto";

import { testBillingReconciliationStateContract } from "@okouai/api-contracts/contracts/test-billing-reconciliation-state";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import type StripeSDK from "stripe";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createRouteMocks } from "./helpers/route-test";
import { mockStripeClient } from "../../external/stripe-client";
import { createDeferredPromise } from "../../utils";
import { testBillingReconciliationStateRoutes } from "../test-billing-reconciliation-state";
import {
  testUsagePackSubscriptionStateContract,
  testUsagePackSubscriptionStateRoutes,
  type TestUsagePackSubscriptionStateAction,
  type TestUsagePackSubscriptionStateResponse,
} from "../test-usage-pack-subscription-state";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { billingStatusRoutes } from "../billing-status";

const context = testContext();
const routeMocks = createRouteMocks(context);

const TEST_PRICE_PRO = "price_usage_pack_lifecycle_pro";
const TEST_PRICE_TEAM = "price_usage_pack_lifecycle_team";
const TEST_PRICE_PLAN_PRO = "price_usage_pack_lifecycle_plan_pro";
const TEST_PRICE_PLAN_TEAM = "price_usage_pack_lifecycle_plan_team";
const TEST_PRICE_PACK_20 = "price_usage_pack_lifecycle_20";
const TEST_PRICE_PACK_50 = "price_usage_pack_lifecycle_50";
const TEST_PRICE_PACK_100 = "price_usage_pack_lifecycle_100";
const TEST_PRICE_PACK_200 = "price_usage_pack_lifecycle_200";
const TEST_PRICE_ATOM_GRANT = "price_usage_pack_lifecycle_atom_grant";

type UsagePackUsd = 20 | 50 | 100 | 200;

interface UsagePackLifecycleFixture {
  readonly orgId: string;
  readonly tier: "pro" | "team";
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly usagePackSubscriptionId: string;
  readonly checkoutSessionId: string;
  readonly userId: string;
  readonly invitationId: string | null;
}

interface UsagePackSelection {
  readonly usagePackUsd: UsagePackUsd;
  readonly userId?: string;
  readonly invitationId?: string;
}

function priceIdForUsagePack(usagePackUsd: UsagePackUsd): string {
  switch (usagePackUsd) {
    case 20: {
      return TEST_PRICE_PACK_20;
    }
    case 50: {
      return TEST_PRICE_PACK_50;
    }
    case 100: {
      return TEST_PRICE_PACK_100;
    }
    case 200: {
      return TEST_PRICE_PACK_200;
    }
  }
}

function usagePackForPriceId(priceId: string): {
  readonly usagePackUsd: UsagePackUsd;
  readonly bonusCredits: number;
} {
  switch (priceId) {
    case TEST_PRICE_PACK_20: {
      return { usagePackUsd: 20, bonusCredits: 400 };
    }
    case TEST_PRICE_PACK_50: {
      return { usagePackUsd: 50, bonusCredits: 2600 };
    }
    case TEST_PRICE_PACK_100: {
      return { usagePackUsd: 100, bonusCredits: 8700 };
    }
    case TEST_PRICE_PACK_200: {
      return { usagePackUsd: 200, bonusCredits: 22_200 };
    }
    default: {
      throw new Error(`Unexpected usage pack Price: ${priceId}`);
    }
  }
}

function configureUsagePackEnvironment(): void {
  mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
  mockEnv("OKOU_PRICE_PRO", TEST_PRICE_PRO);
  mockEnv("OKOU_PRICE_TEAM", TEST_PRICE_TEAM);
  mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_PRO", TEST_PRICE_PLAN_PRO);
  mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_TEAM", TEST_PRICE_PLAN_TEAM);
  mockEnv("OKOU_PRICE_USAGE_PACK_20", TEST_PRICE_PACK_20);
  mockEnv("OKOU_PRICE_USAGE_PACK_50", TEST_PRICE_PACK_50);
  mockEnv("OKOU_PRICE_USAGE_PACK_100", TEST_PRICE_PACK_100);
  mockEnv("OKOU_PRICE_USAGE_PACK_200", TEST_PRICE_PACK_200);
  mockEnv("ATOM_GRANT_PRICE", TEST_PRICE_ATOM_GRANT);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_usage_pack_lifecycle");
}

function usagePackMetadata(fixture: UsagePackLifecycleFixture) {
  const priceId =
    fixture.tier === "team" ? TEST_PRICE_PLAN_TEAM : TEST_PRICE_PLAN_PRO;
  return {
    orgId: fixture.orgId,
    tier: fixture.tier,
    priceId,
    purpose: "usage_pack_subscription",
    usagePackSubscriptionId: fixture.usagePackSubscriptionId,
  };
}

function period(offsetDays: number): {
  readonly start: number;
  readonly end: number;
} {
  const start = Math.floor(now() / 1000) + offsetDays * 86_400;
  return { start, end: start + 30 * 86_400 };
}

function stripeSubscription(
  fixture: UsagePackLifecycleFixture,
  paidPeriod: { readonly start: number; readonly end: number },
  quantities: ReadonlyMap<string, number>,
  options?: {
    readonly cancelAtPeriodEnd?: boolean;
    readonly status?: string;
  },
) {
  const cancelAtPeriodEnd = options?.cancelAtPeriodEnd ?? false;
  return {
    id: fixture.subscriptionId,
    customer: fixture.customerId,
    status: options?.status ?? "active",
    cancel_at: cancelAtPeriodEnd ? paidPeriod.end : null,
    cancel_at_period_end: cancelAtPeriodEnd,
    schedule: null,
    trial_end: null,
    metadata: usagePackMetadata(fixture),
    items: {
      data: [
        {
          price: {
            id:
              fixture.tier === "team"
                ? TEST_PRICE_PLAN_TEAM
                : TEST_PRICE_PLAN_PRO,
          },
          quantity: 1,
          current_period_start: paidPeriod.start,
          current_period_end: paidPeriod.end,
        },
        ...[...quantities].map(([priceId, quantity]) => {
          return {
            price: { id: priceId },
            quantity,
            current_period_start: paidPeriod.start,
            current_period_end: paidPeriod.end,
          };
        }),
      ],
    },
  };
}

function paidInvoice(
  fixture: UsagePackLifecycleFixture,
  args: {
    readonly invoiceId: string;
    readonly paidPeriod: { readonly start: number; readonly end: number };
    readonly quantities: ReadonlyMap<string, number>;
    readonly fraction?: number;
    readonly fullyDiscounted?: boolean;
    readonly linePeriodEnd?: number;
  },
) {
  const metadata = usagePackMetadata(fixture);
  return {
    id: args.invoiceId,
    customer: fixture.customerId,
    metadata,
    status: "paid",
    paid: true,
    parent: {
      subscription_details: {
        subscription: fixture.subscriptionId,
        metadata,
      },
    },
    lines: {
      has_more: false,
      data: [...args.quantities].map(([priceId, quantity]) => {
        const configuration = usagePackForPriceId(priceId);
        const fullAmount = configuration.usagePackUsd * 100 * quantity;
        const amount = Math.round(fullAmount * (args.fraction ?? 1));
        return {
          id: `il_${randomUUID()}`,
          amount,
          discount_amounts: args.fullyDiscounted ? [{ amount }] : [],
          subtotal: amount,
          quantity,
          price: { id: priceId },
          period: {
            start: args.paidPeriod.start,
            end: args.linePeriodEnd ?? args.paidPeriod.end,
          },
          parent: {
            type: "subscription_item_details",
            subscription_item_details: {
              proration: (args.fraction ?? 1) < 1,
            },
          },
        };
      }),
    },
  };
}

function stripeEvent(type: string, object: object) {
  return {
    id: `evt_${randomUUID()}`,
    type,
    created: Math.floor(now() / 1000),
    data: { object },
  };
}

async function postStripeEvent(
  event: object,
  expectedStatus: 200 | 500,
): Promise<void> {
  context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
  const response = await createApp({
    signal: context.signal,
    routes: webhooksStripeRoutes,
  }).request("/api/webhooks/stripe", {
    method: "POST",
    body: JSON.stringify(event),
    headers: { "stripe-signature": "t=1,v1=usage-pack-lifecycle" },
  });
  expect(response.status).toBe(expectedStatus);
}

async function reconcileBillingOrganization(orgId: string) {
  const response = await accept(
    setupApp({
      context,
      routes: testBillingReconciliationStateRoutes,
    })(testBillingReconciliationStateContract).reconcile({
      body: { orgIds: [orgId] },
    }),
    [200],
  );
  return response.body;
}

async function usagePackStateAction(
  body: TestUsagePackSubscriptionStateAction,
): Promise<TestUsagePackSubscriptionStateResponse> {
  const response = await accept(
    setupApp({
      context,
      routes: testUsagePackSubscriptionStateRoutes,
    })(testUsagePackSubscriptionStateContract).action({ body }),
    [200],
  );
  return response.body;
}

async function readUsagePackState(fixture: UsagePackLifecycleFixture) {
  const response = await usagePackStateAction({
    action: "read",
    orgId: fixture.orgId,
    usagePackSubscriptionId: fixture.usagePackSubscriptionId,
  });
  if (response.action !== "read") {
    throw new Error("Usage pack test state did not return a read response");
  }
  return response.state;
}

async function readBillingStatus(fixture: UsagePackLifecycleFixture) {
  routeMocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  const response = await accept(
    setupApp({ context, routes: billingStatusRoutes })(
      billingStatusContract,
    ).get({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
  return response.body;
}

async function seedUsagePackLifecycle(
  selections: readonly UsagePackSelection[],
  tier: "pro" | "team" = "pro",
  credits = 0,
): Promise<UsagePackLifecycleFixture> {
  const orgId = `org_usage_pack_${randomUUID()}`;
  const customerId = `cus_${randomUUID()}`;
  const subscriptionId = `sub_${randomUUID()}`;
  const checkoutSessionId = `cs_${randomUUID()}`;
  const userId =
    selections.find((selection) => {
      return selection.userId !== undefined;
    })?.userId ?? `user_${randomUUID()}`;
  const invitationId =
    selections.find((selection) => {
      return selection.invitationId !== undefined;
    })?.invitationId ?? null;

  await seedOrgMetadata({ orgId, tier: "limited-free-1", credits });
  const seeded = await usagePackStateAction({
    action: "seed",
    orgId,
    tier,
    stripePlanPriceId:
      tier === "team" ? TEST_PRICE_PLAN_TEAM : TEST_PRICE_PLAN_PRO,
    stripeCustomerId: customerId,
    stripeCheckoutSessionId: checkoutSessionId,
    allocations: selections.map((selection) => {
      return {
        userId: selection.userId ?? null,
        invitationId: selection.invitationId ?? null,
        usagePackUsd: selection.usagePackUsd,
        stripePriceId: priceIdForUsagePack(selection.usagePackUsd),
      };
    }),
  });
  if (seeded.action !== "seeded") {
    throw new Error("Failed to seed usage pack subscription");
  }
  const usagePackSubscriptionId = seeded.usagePackSubscriptionId;
  onTestFinished(async () => {
    await usagePackStateAction({
      action: "cleanup",
      orgId,
      usagePackSubscriptionId,
      deleteGrants: true,
      deleteOrgMetadata: true,
    });
  });
  return {
    orgId,
    tier,
    customerId,
    subscriptionId,
    usagePackSubscriptionId,
    checkoutSessionId,
    userId,
    invitationId,
  };
}

function mockUsagePackPriceCatalog(
  bonusCredits: (priceId: string) => string = (priceId) => {
    return String(usagePackForPriceId(priceId).bonusCredits);
  },
): void {
  context.mocks.stripe.prices.retrieve.mockImplementation((priceId) => {
    if (typeof priceId !== "string") {
      throw new Error("Expected a Stripe Price ID");
    }
    const configuration = usagePackForPriceId(priceId);
    return Promise.resolve({
      id: priceId,
      active: false,
      currency: "usd",
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
      unit_amount: configuration.usagePackUsd * 100,
      product: {
        id: `prod_${configuration.usagePackUsd}`,
        metadata: { bonusCredits: bonusCredits(priceId) },
      },
    });
  });
}

async function grantRows(fixture: UsagePackLifecycleFixture) {
  return (await readUsagePackState(fixture)).grants;
}

async function fulfillFirstUsagePackInvoice(
  fixture: UsagePackLifecycleFixture,
) {
  const paidPeriod = period(0);
  const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
    stripeSubscription(fixture, paidPeriod, quantities),
  );
  await postStripeEvent(
    stripeEvent(
      "invoice.paid",
      paidInvoice(fixture, {
        invoiceId: `in_${randomUUID()}`,
        paidPeriod,
        quantities,
      }),
    ),
    200,
  );
  return await readUsagePackState(fixture);
}

describe("usage pack subscription Stripe lifecycle", () => {
  beforeEach(() => {
    configureUsagePackEnvironment();
    mockUsagePackPriceCatalog();
    context.mocks.stripe.checkout.sessions.retrieve.mockImplementation(
      (sessionId) => {
        return Promise.resolve({
          id: typeof sessionId === "string" ? sessionId : "cs_unknown",
          status: "expired",
          customer: null,
          subscription: null,
          metadata: null,
        });
      },
    );
  });

  it.each(["initial payment", "renewal"] as const)(
    "grants usage pack buckets once for %s while the switch is off",
    async (phase) => {
      const userId = `user_${randomUUID()}`;
      const invitationId = `inv_${randomUUID()}`;
      const fixture = await seedUsagePackLifecycle([
        { userId, usagePackUsd: 20 },
        { invitationId, usagePackUsd: 20 },
      ]);
      const quantities = new Map([[TEST_PRICE_PACK_20, 2]]);
      let paidPeriod = period(0);
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        stripeSubscription(fixture, paidPeriod, quantities),
      );

      await postStripeEvent(
        stripeEvent("checkout.session.completed", {
          id: fixture.checkoutSessionId,
          customer: fixture.customerId,
          subscription: fixture.subscriptionId,
          metadata: usagePackMetadata(fixture),
        }),
        200,
      );
      await postStripeEvent(
        stripeEvent(
          "customer.subscription.created",
          stripeSubscription(fixture, paidPeriod, quantities),
        ),
        200,
      );

      if (phase === "initial payment") {
        await expect(grantRows(fixture)).resolves.toHaveLength(0);
        const beforePayment = (await readUsagePackState(fixture)).org;
        expect(beforePayment).toStrictEqual(
          expect.objectContaining({
            tier: "limited-free-1",
            stripeSubscriptionId: fixture.subscriptionId,
          }),
        );
      }

      const firstInvoiceId = `in_${randomUUID()}`;
      const firstInvoice = paidInvoice(fixture, {
        invoiceId: firstInvoiceId,
        paidPeriod,
        quantities,
      });
      await postStripeEvent(stripeEvent("invoice.paid", firstInvoice), 200);
      if (phase === "initial payment") {
        await postStripeEvent(stripeEvent("invoice.paid", firstInvoice), 200);

        await expect(grantRows(fixture)).resolves.toStrictEqual([
          {
            userId,
            grantType: "bonus",
            originalAmount: 400,
            expiresAt: new Date(paidPeriod.end * 1000).toISOString(),
          },
          {
            userId,
            grantType: "purchased",
            originalAmount: 20_000,
            expiresAt: new Date(paidPeriod.end * 1000).toISOString(),
          },
        ]);
        const allocationRows = (await readUsagePackState(fixture)).allocations;
        expect(allocationRows).toStrictEqual(
          expect.arrayContaining([
            expect.objectContaining({
              userId,
              invitationId: null,
              status: "active",
            }),
            expect.objectContaining({
              userId: null,
              invitationId,
              status: "pending_invitation",
            }),
          ]),
        );
        const activatedOrg = (await readUsagePackState(fixture)).org;
        expect(activatedOrg).toStrictEqual(
          expect.objectContaining({ tier: "pro", credits: 0 }),
        );

        return;
      }

      paidPeriod = period(30);
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        stripeSubscription(fixture, paidPeriod, quantities),
      );
      const renewalInvoice = paidInvoice(fixture, {
        invoiceId: `in_${randomUUID()}`,
        paidPeriod,
        quantities,
      });
      await postStripeEvent(stripeEvent("invoice.paid", renewalInvoice), 200);
      await expect(grantRows(fixture)).resolves.toHaveLength(4);
      const renewalGrantRows = await grantRows(fixture);
      expect(
        renewalGrantRows.filter((grant) => {
          return (
            grant.expiresAt === new Date(paidPeriod.end * 1000).toISOString()
          );
        }),
      ).toHaveLength(2);
      expect(
        (await readUsagePackState(fixture)).fulfillmentInvoiceIds,
      ).toHaveLength(2);
    },
  );

  it("floors prorated purchased and bonus grants independently", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 50 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_50, 1]]);
    const paidPeriod = period(0);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, paidPeriod, quantities),
    );

    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_${randomUUID()}`,
          paidPeriod,
          quantities,
          fraction: 1667 / 5000,
        }),
      ),
      200,
    );

    await expect(grantRows(fixture)).resolves.toStrictEqual([
      {
        userId,
        grantType: "bonus",
        originalAmount: 866,
        expiresAt: new Date(paidPeriod.end * 1000).toISOString(),
      },
      {
        userId,
        grantType: "purchased",
        originalAmount: 16_670,
        expiresAt: new Date(paidPeriod.end * 1000).toISOString(),
      },
    ]);
  });

  it("grants fully discounted renewal credits without a refundable amount", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(0);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, paidPeriod, quantities),
    );

    await postStripeEvent(
      stripeEvent(
        "customer.subscription.created",
        stripeSubscription(fixture, paidPeriod, quantities),
      ),
      200,
    );
    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_discounted_${randomUUID()}`,
          paidPeriod,
          quantities,
          fullyDiscounted: true,
        }),
      ),
      200,
    );

    const state = await readUsagePackState(fixture);
    expect(state.grants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId,
          grantType: "purchased",
          originalAmount: 20_000,
        }),
        expect.objectContaining({
          userId,
          grantType: "bonus",
          originalAmount: 400,
        }),
      ]),
    );
    expect(state.refunds).toContainEqual(
      expect.objectContaining({
        userId,
        sourceType: "invoice",
        sourceAmountCents: 0,
        status: "available",
      }),
    );
  });

  it.each(["pro", "team"] as const)(
    "shows usage packs after purchasing the new %s plan",
    async (tier) => {
      const fixture = await seedUsagePackLifecycle(
        [{ usagePackUsd: 20, userId: `user_${randomUUID()}` }],
        tier,
      );
      await fulfillFirstUsagePackInvoice(fixture);
      await expect(readBillingStatus(fixture)).resolves.toMatchObject({
        tier,
        showUsagePack: true,
      });
    },
  );

  it.each([
    { tier: "pro", planVersion: "usagePack", showUsagePack: true },
    { tier: "team", planVersion: "usagePack", showUsagePack: true },
    { tier: "pro", planVersion: "legacy", showUsagePack: false },
    { tier: "team", planVersion: "legacy", showUsagePack: false },
  ] as const)(
    "sets package visibility for an Atom $planVersion $tier grant without credits or allocations",
    async ({ tier, planVersion, showUsagePack }) => {
      const fixture: UsagePackLifecycleFixture = {
        orgId: `org_atom_visibility_${randomUUID()}`,
        tier,
        customerId: `cus_${randomUUID()}`,
        subscriptionId: `unused_sub_${randomUUID()}`,
        usagePackSubscriptionId: randomUUID(),
        checkoutSessionId: `cs_${randomUUID()}`,
        userId: `user_${randomUUID()}`,
        invitationId: null,
      };
      await seedOrgMetadata({
        orgId: fixture.orgId,
        tier: "limited-free-1",
        credits: 0,
      });
      onTestFinished(async () => {
        await usagePackStateAction({
          action: "cleanup",
          orgId: fixture.orgId,
          usagePackSubscriptionId: fixture.usagePackSubscriptionId,
          deleteGrants: true,
          deleteOrgMetadata: true,
        });
      });
      const grantPeriod = period(0);
      await postStripeEvent(
        stripeEvent("invoice.paid", {
          id: `in_${randomUUID()}`,
          customer: fixture.customerId,
          status: "paid",
          paid: true,
          parent: null,
          metadata: {
            type: "atom_grant",
            purpose: "atom_grant",
            source: "atom_entitlement",
            planVersion,
            operationId: `sub_${randomUUID()}`,
            orgId: fixture.orgId,
            tier,
            planId: tier,
            duration: "30d",
            atomGrantExpiresAt: new Date(grantPeriod.end * 1000).toISOString(),
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 0,
                subtotal: 0,
                quantity: 1,
                price: { id: TEST_PRICE_ATOM_GRANT },
                period: grantPeriod,
                parent: { type: "invoice_item_details" },
              },
            ],
          },
        }),
        200,
      );

      await expect(readBillingStatus(fixture)).resolves.toMatchObject({
        tier,
        showUsagePack,
        subscriptionStatus: "atom_grant",
      });
      const state = await readUsagePackState(fixture);
      expect(state.subscription).toBeNull();
      expect(state.allocations).toHaveLength(0);
      expect(state.grants).toHaveLength(0);
    },
  );

  it("grants independent one-time Atom member credits for Atom and subscribed plans", async () => {
    const orgId = `org_atom_usage_pack_${randomUUID()}`;
    const customerId = `cus_${randomUUID()}`;
    const subscriptionId = `unused_sub_${randomUUID()}`;
    const usagePackSubscriptionId = randomUUID();
    let cleanupUsagePackSubscriptionId: string = usagePackSubscriptionId;
    const grantedUserId = `user_${randomUUID()}`;
    const delayedRedeemUserId = `user_${randomUUID()}`;
    const paidPeriod = period(0);
    const grantPeriod = {
      start: paidPeriod.start,
      end: paidPeriod.start + 7 * 86_400,
    };
    const creditPeriod = {
      start: paidPeriod.start,
      end: paidPeriod.start + 3 * 86_400,
    };
    const fixture: UsagePackLifecycleFixture = {
      orgId,
      tier: "pro",
      customerId,
      subscriptionId,
      usagePackSubscriptionId,
      checkoutSessionId: `cs_${randomUUID()}`,
      userId: grantedUserId,
      invitationId: null,
    };
    await seedOrgMetadata({ orgId, tier: "limited-free-1", credits: 0 });
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId,
        usagePackSubscriptionId: cleanupUsagePackSubscriptionId,
        deleteGrants: true,
        deleteOrgMetadata: true,
      });
    });
    const planInvoiceId = `in_atom_usage_pack_plan_${randomUUID()}`;
    const metadata = {
      type: "atom_grant",
      purpose: "atom_grant",
      source: "atom_redeem_code",
      planVersion: "usagePack",
      operationId: `sub_${randomUUID()}`,
      orgId,
      tier: "pro",
      planId: "pro",
      duration: "7d",
      atomGrantExpiresAt: new Date(grantPeriod.end * 1000).toISOString(),
      userId: grantedUserId,
      creditsAmount: "20000",
      creditsExpiresAt: new Date(grantPeriod.end * 1000).toISOString(),
    };
    const planInvoice = {
      id: planInvoiceId,
      customer: customerId,
      metadata,
      status: "paid",
      paid: true,
      parent: null,
      lines: {
        has_more: false,
        data: [
          {
            id: `il_${randomUUID()}`,
            amount: 0,
            subtotal: 0,
            quantity: 1,
            price: { id: TEST_PRICE_ATOM_GRANT },
            period: grantPeriod,
            parent: { type: "invoice_item_details" },
          },
        ],
      },
    };
    const grantInvoiceId = `in_atom_member_pack_${randomUUID()}`;
    const grantInvoice = {
      id: grantInvoiceId,
      customer: customerId,
      subtotal: 0,
      metadata: {
        type: "atom_grant",
        purpose: "atom_grant",
        source: "atom_usage_pack_credits",
        grantType: "usage_pack_credits",
        orgId,
        userId: grantedUserId,
        creditsAmount: "6000",
        creditsExpiresAt: new Date(creditPeriod.end * 1000).toISOString(),
      },
      parent: null,
      lines: {
        has_more: false,
        data: [
          {
            id: `il_${randomUUID()}`,
            quantity: 1,
            price: { id: TEST_PRICE_ATOM_GRANT },
            period: creditPeriod,
            parent: { type: "invoice_item_details" },
          },
        ],
      },
    };
    await postStripeEvent(stripeEvent("invoice.paid", grantInvoice), 500);
    await expect(grantRows(fixture)).resolves.toStrictEqual([]);

    await postStripeEvent(stripeEvent("invoice.paid", planInvoice), 200);
    await postStripeEvent(stripeEvent("invoice.paid", planInvoice), 200);

    const planState = await readUsagePackState(fixture);
    expect(planState.subscription).toBeNull();
    expect(planState.allocations).toStrictEqual([]);
    expect(planState.grants).toStrictEqual([
      {
        userId: grantedUserId,
        grantType: "bonus",
        originalAmount: 20_000,
        expiresAt: new Date(grantPeriod.end * 1000).toISOString(),
      },
    ]);
    expect(planState.org).toStrictEqual(
      expect.objectContaining({
        tier: "pro",
        credits: 0,
        stripeSubscriptionId: null,
        subscriptionStatus: "atom_grant",
        currentPeriodEnd: new Date(grantPeriod.end * 1000).toISOString(),
        showUsagePack: true,
      }),
    );
    expect(planState.legacyCredits).toStrictEqual([]);
    expect(planState.fulfillmentInvoiceIds).toStrictEqual([]);
    const atomBillingStatus = await readBillingStatus(fixture);
    expect(atomBillingStatus.showUsagePack).toBeTruthy();
    expect(atomBillingStatus.scheduledChange).toStrictEqual({
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: new Date(grantPeriod.end * 1000).toISOString(),
    });
    expect(atomBillingStatus.canRestorePlan).toBeFalsy();

    const renewedGrantPeriod = {
      start: grantPeriod.start,
      end: grantPeriod.start + 14 * 86_400,
    };
    const renewedPlanInvoice = {
      ...planInvoice,
      id: `in_atom_usage_pack_plan_${randomUUID()}`,
      metadata: {
        type: "atom_grant",
        purpose: "atom_grant",
        source: "atom_entitlement",
        planVersion: "usagePack",
        operationId: metadata.operationId,
        orgId,
        tier: "pro",
        planId: "pro",
        duration: "14d",
        atomGrantExpiresAt: new Date(
          renewedGrantPeriod.end * 1000,
        ).toISOString(),
      },
      lines: {
        has_more: false,
        data: [
          {
            ...planInvoice.lines.data[0],
            id: `il_${randomUUID()}`,
            period: renewedGrantPeriod,
          },
        ],
      },
    };
    const delayedRedeemPlanInvoice = {
      ...planInvoice,
      id: `in_atom_usage_pack_plan_${randomUUID()}`,
      metadata: {
        ...metadata,
        operationId: `sub_${randomUUID()}`,
        userId: delayedRedeemUserId,
      },
      lines: {
        has_more: false,
        data: [
          {
            ...planInvoice.lines.data[0],
            id: `il_${randomUUID()}`,
          },
        ],
      },
    };
    await postStripeEvent(stripeEvent("invoice.paid", renewedPlanInvoice), 200);
    await postStripeEvent(stripeEvent("invoice.paid", planInvoice), 200);
    await postStripeEvent(
      stripeEvent("invoice.paid", delayedRedeemPlanInvoice),
      200,
    );
    await postStripeEvent(
      stripeEvent("invoice.paid", delayedRedeemPlanInvoice),
      200,
    );
    const renewedState = await readUsagePackState(fixture);
    expect(renewedState.org).toStrictEqual(
      expect.objectContaining({
        currentPeriodEnd: new Date(renewedGrantPeriod.end * 1000).toISOString(),
      }),
    );
    expect(renewedState.grants).toHaveLength(2);
    expect(renewedState.grants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: grantedUserId }),
        expect.objectContaining({ userId: delayedRedeemUserId }),
      ]),
    );

    await postStripeEvent(stripeEvent("invoice.paid", grantInvoice), 200);
    await postStripeEvent(stripeEvent("invoice.paid", grantInvoice), 200);

    const grantedState = await readUsagePackState(fixture);
    expect(grantedState.allocations).toStrictEqual([]);
    expect(grantedState.grants).toHaveLength(3);
    expect(grantedState.grants).toStrictEqual(
      expect.arrayContaining([
        {
          userId: grantedUserId,
          grantType: "bonus",
          originalAmount: 20_000,
          expiresAt: new Date(grantPeriod.end * 1000).toISOString(),
        },
        {
          userId: delayedRedeemUserId,
          grantType: "bonus",
          originalAmount: 20_000,
          expiresAt: new Date(grantPeriod.end * 1000).toISOString(),
        },
        {
          userId: grantedUserId,
          grantType: "bonus",
          originalAmount: 6000,
          expiresAt: new Date(creditPeriod.end * 1000).toISOString(),
        },
      ]),
    );
    expect(grantedState.org?.credits).toBe(0);
    expect(grantedState.legacyCredits).toStrictEqual([]);
    expect(grantedState.fulfillmentInvoiceIds).toStrictEqual([]);

    const checkoutSessionId = `cs_${randomUUID()}`;
    const seededSubscription = await usagePackStateAction({
      action: "seed",
      orgId,
      tier: "team",
      stripePlanPriceId: TEST_PRICE_PLAN_TEAM,
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: checkoutSessionId,
      allocations: [
        {
          userId: grantedUserId,
          invitationId: null,
          usagePackUsd: 20,
          stripePriceId: TEST_PRICE_PACK_20,
        },
      ],
    });
    if (seededSubscription.action !== "seeded") {
      throw new Error("Failed to seed the replacement usage pack subscription");
    }
    const subscribedFixture: UsagePackLifecycleFixture = {
      ...fixture,
      tier: "team",
      subscriptionId: `sub_${randomUUID()}`,
      usagePackSubscriptionId: seededSubscription.usagePackSubscriptionId,
      checkoutSessionId,
    };
    cleanupUsagePackSubscriptionId = seededSubscription.usagePackSubscriptionId;
    const subscriptionPeriod = period(0);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const subscription = stripeSubscription(
      subscribedFixture,
      subscriptionPeriod,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);

    await postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: checkoutSessionId,
        customer: customerId,
        subscription: subscribedFixture.subscriptionId,
        metadata: usagePackMetadata(subscribedFixture),
      }),
      200,
    );
    await postStripeEvent(
      stripeEvent("customer.subscription.created", subscription),
      200,
    );
    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(subscribedFixture, {
          invoiceId: `in_${randomUUID()}`,
          paidPeriod: subscriptionPeriod,
          quantities,
        }),
      ),
      200,
    );

    const subscriptionBillingStatus =
      await readBillingStatus(subscribedFixture);
    expect(subscriptionBillingStatus.tier).toBe("team");
    expect(subscriptionBillingStatus.hasSubscription).toBeTruthy();
    expect(subscriptionBillingStatus.scheduledChange).toBeNull();
    expect(subscriptionBillingStatus.canRestorePlan).toBeFalsy();

    const subscribedCreditPeriod = {
      start: subscriptionPeriod.start,
      end: subscriptionPeriod.start + 15 * 86_400,
    };
    await postStripeEvent(
      stripeEvent("invoice.paid", {
        ...grantInvoice,
        id: `in_atom_subscribed_member_pack_${randomUUID()}`,
        metadata: {
          ...grantInvoice.metadata,
          creditsAmount: "7000",
          creditsExpiresAt: new Date(
            subscribedCreditPeriod.end * 1000,
          ).toISOString(),
        },
        lines: {
          has_more: false,
          data: [
            {
              ...grantInvoice.lines.data[0],
              id: `il_${randomUUID()}`,
              period: subscribedCreditPeriod,
            },
          ],
        },
      }),
      200,
    );
    await expect(grantRows(subscribedFixture)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: grantedUserId,
          grantType: "bonus",
          originalAmount: 7000,
          expiresAt: new Date(subscribedCreditPeriod.end * 1000).toISOString(),
        }),
      ]),
    );
  });

  it("retries a one-time Atom usage-pack grant after the old Team subscription is deleted", async () => {
    const grantedUserId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle(
      [{ userId: grantedUserId, usagePackUsd: 20 }],
      "team",
    );
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(0);
    const currentSubscription = stripeSubscription(
      fixture,
      paidPeriod,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );

    await postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: fixture.checkoutSessionId,
        customer: fixture.customerId,
        subscription: fixture.subscriptionId,
        metadata: usagePackMetadata(fixture),
      }),
      200,
    );
    await postStripeEvent(
      stripeEvent("customer.subscription.created", currentSubscription),
      200,
    );
    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_team_${randomUUID()}`,
          paidPeriod,
          quantities,
        }),
      ),
      200,
    );

    const grantPeriod = {
      start: paidPeriod.start,
      end: paidPeriod.start + 7 * 86_400,
    };
    const planInvoiceId = `in_atom_usage_pack_plan_${randomUUID()}`;
    const metadata = {
      type: "atom_grant",
      purpose: "atom_grant",
      source: "atom_entitlement",
      planVersion: "usagePack",
      operationId: `sub_${randomUUID()}`,
      orgId: fixture.orgId,
      tier: "pro",
      planId: "pro",
      duration: "7d",
      atomGrantExpiresAt: new Date(grantPeriod.end * 1000).toISOString(),
    };
    const planInvoice = {
      id: planInvoiceId,
      customer: fixture.customerId,
      metadata,
      status: "paid",
      paid: true,
      parent: null,
      lines: {
        has_more: false,
        data: [
          {
            id: `il_${randomUUID()}`,
            amount: 0,
            subtotal: 0,
            quantity: 1,
            price: { id: TEST_PRICE_ATOM_GRANT },
            period: grantPeriod,
            parent: { type: "invoice_item_details" },
          },
        ],
      },
    };

    await postStripeEvent(stripeEvent("invoice.paid", planInvoice), 500);
    expect((await readUsagePackState(fixture)).org).toStrictEqual(
      expect.objectContaining({
        tier: "team",
        stripeSubscriptionId: fixture.subscriptionId,
        showUsagePack: true,
      }),
    );

    await postStripeEvent(
      stripeEvent("customer.subscription.deleted", {
        id: fixture.subscriptionId,
        metadata: usagePackMetadata(fixture),
      }),
      200,
    );
    expect((await readUsagePackState(fixture)).org).toStrictEqual(
      expect.objectContaining({
        tier: "limited-free-1",
        stripeSubscriptionId: null,
      }),
    );

    await postStripeEvent(stripeEvent("invoice.paid", planInvoice), 200);
    const retriedState = await readUsagePackState(fixture);
    expect(retriedState.org).toStrictEqual(
      expect.objectContaining({
        tier: "pro",
        stripeSubscriptionId: null,
        subscriptionStatus: "atom_grant",
        currentPeriodEnd: new Date(grantPeriod.end * 1000).toISOString(),
        showUsagePack: true,
      }),
    );
    expect(retriedState.subscription).toStrictEqual(
      expect.objectContaining({ subscriptionStatus: "canceled" }),
    );
  });

  it("rejects an invoice line that extends beyond the current Stripe period", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(0);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, paidPeriod, quantities),
    );
    const invoiceId = `in_${randomUUID()}`;

    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId,
          paidPeriod,
          quantities,
          fraction: 0.5,
          linePeriodEnd: paidPeriod.end + 1,
        }),
      ),
      500,
    );
    await expect(grantRows(fixture)).resolves.toHaveLength(0);
    expect(
      (await readUsagePackState(fixture)).fulfillmentInvoiceIds,
    ).toHaveLength(0);

    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId,
          paidPeriod,
          quantities,
          fraction: 0.5,
        }),
      ),
      200,
    );
    await expect(grantRows(fixture)).resolves.toHaveLength(2);
  });

  it("fulfills an older paid invoice without rewinding the current period", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const olderPeriod = period(0);
    const currentPeriod = period(30);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, currentPeriod, quantities),
    );

    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_${randomUUID()}`,
          paidPeriod: currentPeriod,
          quantities,
        }),
      ),
      200,
    );
    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_${randomUUID()}`,
          paidPeriod: olderPeriod,
          quantities,
        }),
      ),
      200,
    );

    await expect(grantRows(fixture)).resolves.toHaveLength(4);
    const subscription = (await readUsagePackState(fixture)).subscription;
    expect(subscription).toStrictEqual(
      expect.objectContaining({
        currentPeriodStart: new Date(currentPeriod.start * 1000).toISOString(),
        currentPeriodEnd: new Date(currentPeriod.end * 1000).toISOString(),
      }),
    );
  });

  it("keeps paid grants through scheduled cancellation and uses the existing terminal fallback", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(0);
    let currentSubscription = stripeSubscription(
      fixture,
      paidPeriod,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_${randomUUID()}`,
          paidPeriod,
          quantities,
        }),
      ),
      200,
    );

    currentSubscription = stripeSubscription(fixture, paidPeriod, quantities, {
      cancelAtPeriodEnd: true,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent("customer.subscription.updated", currentSubscription),
      200,
    );
    const scheduledOrg = (await readUsagePackState(fixture)).org;
    expect(scheduledOrg).toStrictEqual(
      expect.objectContaining({ tier: "pro", cancelAtPeriodEnd: true }),
    );
    await expect(grantRows(fixture)).resolves.toHaveLength(2);

    await postStripeEvent(
      stripeEvent("customer.subscription.deleted", {
        id: fixture.subscriptionId,
        metadata: usagePackMetadata(fixture),
      }),
      200,
    );
    const canceledState = await readUsagePackState(fixture);
    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      showUsagePack: false,
    });
    expect(canceledState.org).toStrictEqual(
      expect.objectContaining({
        tier: "limited-free-1",
        stripeSubscriptionId: null,
      }),
    );
    const [allocation] = canceledState.allocations;
    expect(allocation?.status).toBe("inactive");
    await expect(grantRows(fixture)).resolves.toHaveLength(2);
  });

  it("settles a paid invoice delivered after deletion without reactivating the subscription", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(0);
    let currentSubscription = stripeSubscription(
      fixture,
      paidPeriod,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: fixture.checkoutSessionId,
        customer: fixture.customerId,
        subscription: fixture.subscriptionId,
        metadata: usagePackMetadata(fixture),
      }),
      200,
    );

    currentSubscription = stripeSubscription(fixture, paidPeriod, quantities, {
      status: "canceled",
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent("customer.subscription.deleted", {
        id: fixture.subscriptionId,
        metadata: usagePackMetadata(fixture),
      }),
      200,
    );

    const invoiceId = `in_${randomUUID()}`;
    const invoice = paidInvoice(fixture, {
      invoiceId,
      paidPeriod,
      quantities,
    });
    await postStripeEvent(stripeEvent("invoice.paid", invoice), 200);
    await postStripeEvent(stripeEvent("invoice.paid", invoice), 200);

    const state = await readUsagePackState(fixture);
    expect(state.grants).toHaveLength(2);
    expect(state.fulfillmentInvoiceIds).toStrictEqual([invoiceId]);
    expect(state.subscription).toStrictEqual(
      expect.objectContaining({
        subscriptionStatus: "canceled",
        currentPeriodStart: null,
        currentPeriodEnd: null,
      }),
    );
    const [allocation] = state.allocations;
    expect(allocation).toStrictEqual(
      expect.objectContaining({
        status: "inactive",
        currentPeriodStart: null,
        currentPeriodEnd: null,
      }),
    );
    expect(state.org).toStrictEqual(
      expect.objectContaining({
        tier: "limited-free-1",
        stripeSubscriptionId: null,
      }),
    );
  });

  it("clears debt for a new organization that only received free onboarding credits", async () => {
    const fixture = await seedUsagePackLifecycle([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
    ]);
    const authOrgApi = createAuthOrgAgentsBddApi(context);
    const actor = authOrgApi.user({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });
    authOrgApi.acceptAgentStorageWrites();
    authOrgApi.mockClerkOrg(actor);
    await authOrgApi.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "First purchase agent",
      sound: "calm",
    });
    expect((await readUsagePackState(fixture)).legacyCredits).toContainEqual(
      expect.objectContaining({
        stripeInvoiceId: "limited-free-onboarding",
        amount: 1000,
      }),
    );
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "limited-free-1",
      credits: -5000,
    });

    const state = await fulfillFirstUsagePackInvoice(fixture);

    expect(state.org).toMatchObject({ tier: "pro", credits: 0 });
    expect(state.grants).toHaveLength(2);
  });

  it.each([0, 5000])(
    "preserves a first-upgrade balance of %i and does not waive later renewal debt",
    async (credits) => {
      const fixture = await seedUsagePackLifecycle(
        [{ userId: `user_${randomUUID()}`, usagePackUsd: 20 }],
        "pro",
        credits,
      );
      const firstUpgrade = await fulfillFirstUsagePackInvoice(fixture);

      expect(firstUpgrade.org).toMatchObject({ tier: "pro", credits });
      expect(firstUpgrade.grants).toHaveLength(2);
      expect(firstUpgrade.fulfillmentInvoiceIds).toHaveLength(1);

      await seedOrgMetadata({
        orgId: fixture.orgId,
        tier: "pro",
        credits: -3000,
      });
      const paidPeriod = period(30);
      const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        stripeSubscription(fixture, paidPeriod, quantities),
      );
      await postStripeEvent(
        stripeEvent(
          "invoice.paid",
          paidInvoice(fixture, {
            invoiceId: `in_${randomUUID()}`,
            paidPeriod,
            quantities,
          }),
        ),
        200,
      );

      const renewed = await readUsagePackState(fixture);
      expect(renewed.org).toMatchObject({ tier: "pro", credits: -3000 });
      expect(renewed.grants).toHaveLength(4);
      expect(renewed.fulfillmentInvoiceIds).toHaveLength(2);
    },
  );

  it("fulfills concurrent first invoices once and preserves new debt when the invoice is replayed", async () => {
    const fixture = await seedUsagePackLifecycle(
      [{ userId: `user_${randomUUID()}`, usagePackUsd: 20 }],
      "pro",
      -5000,
    );
    const paidPeriod = period(0);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const invoice = paidInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      paidPeriod,
      quantities,
    });
    const bothRequestsStarted = createDeferredPromise<void>(context.signal);
    let startedRequests = 0;
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(async () => {
      startedRequests += 1;
      if (startedRequests === 2) {
        bothRequestsStarted.resolve(undefined);
      }
      await bothRequestsStarted.promise;
      return stripeSubscription(fixture, paidPeriod, quantities);
    });

    await Promise.all([
      postStripeEvent(stripeEvent("invoice.paid", invoice), 200),
      postStripeEvent(stripeEvent("invoice.paid", invoice), 200),
    ]);

    const fulfilled = await readUsagePackState(fixture);
    expect(fulfilled.org).toMatchObject({ tier: "pro", credits: 0 });
    expect(fulfilled.grants).toHaveLength(2);
    expect(fulfilled.fulfillmentInvoiceIds).toStrictEqual([invoice.id]);

    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "pro",
      credits: -3000,
    });
    await postStripeEvent(stripeEvent("invoice.paid", invoice), 200);

    const replayed = await readUsagePackState(fixture);
    expect(replayed.org).toMatchObject({ tier: "pro", credits: -3000 });
    expect(replayed.grants).toStrictEqual(fulfilled.grants);
    expect(replayed.fulfillmentInvoiceIds).toStrictEqual([invoice.id]);
  });

  it("rolls back debt forgiveness and grants when the subscription cannot be persisted", async () => {
    const fixture = await seedUsagePackLifecycle(
      [{ userId: `user_${randomUUID()}`, usagePackUsd: 20 }],
      "pro",
      -5000,
    );
    const paidPeriod = period(0);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const invoice = paidInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      paidPeriod,
      quantities,
    });
    // An oversized provider status fails during plan persistence, after the
    // debt waiver and member grant writes have executed in the transaction.
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, paidPeriod, quantities, {
        status: "invalid_subscription_status_from_stripe",
      }),
    );
    const beforePayment = await readUsagePackState(fixture);

    await postStripeEvent(stripeEvent("invoice.paid", invoice), 500);

    await expect(readUsagePackState(fixture)).resolves.toStrictEqual(
      beforePayment,
    );

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, paidPeriod, quantities),
    );
    await postStripeEvent(stripeEvent("invoice.paid", invoice), 200);

    const retried = await readUsagePackState(fixture);
    expect(retried.org).toMatchObject({ tier: "pro", credits: 0 });
    expect(retried.grants).toHaveLength(2);
    expect(retried.fulfillmentInvoiceIds).toStrictEqual([invoice.id]);
  });

  it.each(["credit_purchase", "auto_recharge"])(
    "preserves debt after a previous %s even when the organization is free again",
    async (source) => {
      const fixture = await seedUsagePackLifecycle([
        { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
      ]);
      await postStripeEvent(
        stripeEvent("invoice.paid", {
          id: `in_${randomUUID()}`,
          customer: fixture.customerId,
          status: "paid",
          paid: true,
          subtotal: 1000,
          metadata: {
            type: source,
            orgId: fixture.orgId,
            creditsAmount: "10000",
          },
          parent: null,
          lines: { has_more: false, data: [] },
        }),
        200,
      );
      expect((await readUsagePackState(fixture)).org?.credits).toBe(10_000);
      await seedOrgMetadata({
        orgId: fixture.orgId,
        tier: "limited-free-1",
        credits: -5000,
      });

      const state = await fulfillFirstUsagePackInvoice(fixture);

      expect(state.org).toMatchObject({ tier: "pro", credits: -5000 });
      expect(state.grants).toHaveLength(2);
    },
  );

  it.each(["pro", "custom"])(
    "preserves debt for a returning legacy %s subscriber after its old billing period",
    async (tier) => {
      const fixture = await seedUsagePackLifecycle([
        { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
      ]);
      const legacyPriceId =
        tier === "pro" ? TEST_PRICE_PRO : `price_custom_${randomUUID()}`;
      mockEnv("OKOU_PRICE_CUSTOM", legacyPriceId);
      const legacySubscriptionId = `sub_legacy_${randomUUID()}`;
      const legacyPeriod = period(-60);
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: legacySubscriptionId,
        customer: fixture.customerId,
        status: "active",
        cancel_at: null,
        cancel_at_period_end: false,
        schedule: null,
        trial_end: null,
        metadata: { orgId: fixture.orgId, tier },
        items: {
          data: [{ price: { id: legacyPriceId }, quantity: 1 }],
        },
      });
      await postStripeEvent(
        stripeEvent("invoice.paid", {
          id: `in_legacy_${randomUUID()}`,
          customer: fixture.customerId,
          status: "paid",
          paid: true,
          metadata: { orgId: fixture.orgId },
          parent: {
            subscription_details: { subscription: legacySubscriptionId },
          },
          lines: {
            has_more: false,
            data: [
              {
                price: { id: legacyPriceId },
                quantity: 1,
                period: legacyPeriod,
                parent: { type: "subscription_item_details" },
              },
            ],
          },
        }),
        200,
      );
      const legacyState = await readUsagePackState(fixture);
      expect(legacyState.org?.tier).toBe(tier);
      expect(legacyState.legacyCredits).toHaveLength(tier === "pro" ? 1 : 0);
      expect(legacyState.fulfillmentInvoiceIds).toStrictEqual([]);
      await seedOrgMetadata({
        orgId: fixture.orgId,
        tier: "limited-free-1",
        credits: -5000,
      });

      const state = await fulfillFirstUsagePackInvoice(fixture);

      expect(state.org).toMatchObject({ tier: "pro", credits: -5000 });
      expect(state.grants).toHaveLength(2);
    },
  );

  it("preserves debt after a one-time credit purchase has expired", async () => {
    const fixture = await seedUsagePackLifecycle([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
    ]);
    const purchasedAt = now();
    mockEnv(
      "OKOU_ONE_TIME_CAMPAIGN",
      JSON.stringify({
        ZERO100: { priceId: "price_one_time", couponId: "coupon_one_time" },
      }),
    );
    await postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: `cs_one_time_${randomUUID()}`,
        customer: fixture.customerId,
        payment_status: "paid",
        metadata: {
          purpose: "one_time_purchase",
          campaignKey: "ZERO100",
          orgId: fixture.orgId,
        },
      }),
      200,
    );
    expect((await readUsagePackState(fixture)).org?.credits).toBe(100_000);
    mockNow(purchasedAt + 31 * 86_400_000);
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "limited-free-1",
      credits: -5000,
    });

    const state = await fulfillFirstUsagePackInvoice(fixture);

    expect(state.org).toMatchObject({ tier: "pro", credits: -5000 });
    expect(state.grants).toHaveLength(2);
  });

  it("clears negative credits on the first paid upgrade but not after a payment-failure downgrade", async () => {
    mockNow(new Date("2999-02-01T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle(
      [{ userId, usagePackUsd: 20 }],
      "pro",
      -5000,
    );
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(-32);
    let currentSubscription = stripeSubscription(
      fixture,
      paidPeriod,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_${randomUUID()}`,
          paidPeriod,
          quantities,
        }),
      ),
      200,
    );
    const firstUpgradeOrg = (await readUsagePackState(fixture)).org;
    expect(firstUpgradeOrg).toStrictEqual(
      expect.objectContaining({ tier: "pro", credits: 0 }),
    );

    currentSubscription = stripeSubscription(fixture, paidPeriod, quantities, {
      status: "past_due",
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent("customer.subscription.updated", currentSubscription),
      200,
    );
    context.mocks.stripe.invoices.list.mockResolvedValue({ data: [] });

    await expect(
      reconcileBillingOrganization(fixture.orgId),
    ).resolves.toStrictEqual(expect.objectContaining({ success: true }));
    const downgradedOrg = (await readUsagePackState(fixture)).org;
    expect(downgradedOrg).toStrictEqual(
      expect.objectContaining({
        tier: "limited-free-1",
        subscriptionStatus: "past_due",
      }),
    );

    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "limited-free-1",
      credits: -3000,
    });
    const recoveredPeriod = period(0);
    currentSubscription = stripeSubscription(
      fixture,
      recoveredPeriod,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    await postStripeEvent(
      stripeEvent(
        "invoice.paid",
        paidInvoice(fixture, {
          invoiceId: `in_${randomUUID()}`,
          paidPeriod: recoveredPeriod,
          quantities,
        }),
      ),
      200,
    );
    const recoveredOrg = (await readUsagePackState(fixture)).org;
    expect(recoveredOrg).toStrictEqual(
      expect.objectContaining({
        tier: "pro",
        subscriptionStatus: "active",
        credits: -3000,
      }),
    );
  });

  it("reconciles a completed Checkout Session and missed paid invoice without enabling enrollment", async () => {
    mockNow(new Date("2999-03-01T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(0);
    const subscription = stripeSubscription(fixture, paidPeriod, quantities);
    const invoice = paidInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      paidPeriod,
      quantities,
    });
    await usagePackStateAction({
      action: "set-updated-at",
      orgId: fixture.orgId,
      usagePackSubscriptionId: fixture.usagePackSubscriptionId,
      updatedAt: new Date(now() - 10 * 60 * 1000).toISOString(),
    });
    const sentinel = await seedUsagePackLifecycle([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
    ]);
    await usagePackStateAction({
      action: "set-updated-at",
      orgId: sentinel.orgId,
      usagePackSubscriptionId: sentinel.usagePackSubscriptionId,
      updatedAt: new Date(now() - 10 * 60 * 1000).toISOString(),
    });
    const sentinelBefore = await readUsagePackState(sentinel);
    context.mocks.stripe.checkout.sessions.retrieve.mockImplementation(
      (sessionId) => {
        if (sessionId === fixture.checkoutSessionId) {
          return Promise.resolve({
            id: fixture.checkoutSessionId,
            status: "complete",
            customer: fixture.customerId,
            subscription: fixture.subscriptionId,
            metadata: usagePackMetadata(fixture),
          });
        }
        return Promise.resolve({
          id: typeof sessionId === "string" ? sessionId : "cs_unknown",
          status: "expired",
          customer: null,
          subscription: null,
          metadata: null,
        });
      },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.invoices.list.mockResolvedValue({ data: [invoice] });

    await expect(
      reconcileBillingOrganization(fixture.orgId),
    ).resolves.toStrictEqual({ success: true, downgraded: 0 });
    await expect(grantRows(fixture)).resolves.toHaveLength(2);
    const reconciled = (await readUsagePackState(fixture)).subscription;
    expect(reconciled).toStrictEqual(
      expect.objectContaining({
        stripeSubscriptionId: fixture.subscriptionId,
        currentPeriodEnd: new Date(paidPeriod.end * 1000).toISOString(),
      }),
    );
    await expect(readUsagePackState(sentinel)).resolves.toStrictEqual(
      sentinelBefore,
    );
  });

  it("rolls back invalid Product metadata and succeeds when Stripe retries", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedUsagePackLifecycle([
      { userId, usagePackUsd: 20 },
    ]);
    const quantities = new Map([[TEST_PRICE_PACK_20, 1]]);
    const paidPeriod = period(0);
    const invoice = paidInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      paidPeriod,
      quantities,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscription(fixture, paidPeriod, quantities),
    );
    let validProductMetadata = false;
    mockUsagePackPriceCatalog(() => {
      return validProductMetadata ? "400" : "not-an-integer";
    });

    await postStripeEvent(stripeEvent("invoice.paid", invoice), 500);
    await expect(grantRows(fixture)).resolves.toHaveLength(0);
    const pendingState = await readUsagePackState(fixture);
    expect(pendingState.fulfillmentInvoiceIds).toHaveLength(0);
    const [pendingAllocation] = pendingState.allocations;
    expect(pendingAllocation?.status).toBe("pending_payment");

    validProductMetadata = true;
    await postStripeEvent(stripeEvent("invoice.paid", invoice), 200);
    await expect(grantRows(fixture)).resolves.toHaveLength(2);
  });
});
