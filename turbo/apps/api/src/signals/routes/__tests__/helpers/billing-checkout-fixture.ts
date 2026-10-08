import { randomUUID } from "node:crypto";
import {
  billingCheckoutContract,
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { accept, testContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import {
  seedOrgMetadata,
  setOnboardingPaymentPendingFixture,
} from "../../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../../auth/tokens";
import { billingCheckoutRoutes } from "../../billing-checkout";
import { billingStatusRoutes } from "../../billing-status";
import {
  testUsagePackSubscriptionStateContract,
  testUsagePackSubscriptionStateRoutes,
  type TestUsagePackSubscriptionStateAction,
  type TestUsagePackSubscriptionStateResponse,
} from "../../test-usage-pack-subscription-state";
import { webhooksStripeRoutes } from "../../webhooks-stripe";
import { createBddApi } from "./api-bdd";
import { seedOrgMembership$ } from "./org-membership";
import { createPublicBillingZeroFixture } from "./public-billing-zero-fixture";
import { createRouteMocks } from "./route-test";

export interface BillingOrgFixture {
  readonly orgId: string;
  readonly userId: string;
}

export interface SubscriptionFixture extends BillingOrgFixture {
  readonly customerId: string;
  readonly subscriptionId: string;
}

type UsagePackCheckoutSessionState = "open" | "expired";

// Install lifecycle hooks and own the in-memory fixtures once per suite module.
export function createBillingCheckoutFixture() {
  const context = testContext();

  const store = createStore();

  const mocks = createRouteMocks(context);

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

  async function readUsagePackState(
    orgId: string,
    usagePackSubscriptionId?: string,
  ) {
    const response = await usagePackStateAction({
      action: "read",
      orgId,
      usagePackSubscriptionId,
    });
    if (response.action !== "read") {
      throw new Error("Usage pack test state did not return a read response");
    }
    return response.state;
  }

  const APP_ORIGIN = "http://localhost:3002";

  // This unshared test tenant collides with the staff-org identity hash so the
  // route exercises the real authorization gate without mutating shared staff
  // billing state used by other integration files.
  const TEST_STAFF_ORG_ID = "org_usage_pack_checkout_test_lgD7Q3";

  const TEST_PRICE_PRO = "price_test_pro";

  const TEST_PRICE_TEAM = "price_test_team";

  const TEST_PRICE_CUSTOM = "price_test_custom";

  const TEST_PRICE_USAGE_PACK_PLAN_PRO = "price_test_usage_pack_plan_pro";

  const TEST_PRICE_USAGE_PACK_PLAN_TEAM = "price_test_usage_pack_plan_team";

  const TEST_PRICE_USAGE_PACK_20 = "price_test_usage_pack_20";

  const TEST_PRICE_USAGE_PACK_50 = "price_test_usage_pack_50";

  const TEST_PRICE_USAGE_PACK_100 = "price_test_usage_pack_100";

  const TEST_PRICE_USAGE_PACK_200 = "price_test_usage_pack_200";

  const TEST_PRICE_ATOM_GRANT = "price_test_atom_grant";

  const TEST_PRICE_USAGE_ALLOWANCE = "price_test_usage_allowance";

  const TEST_PRICE_CUSTOM_CREDIT_UNIT = "price_test_custom_credit_unit";

  const TEST_PRICE_CONCURRENCY = "price_test_concurrency";

  const STRIPE_WEBHOOK_SECRET = "whsec_checkout_test";

  class ClerkApiResponseTestError extends Error {
    static readonly kind = "ClerkAPIResponseError";
    constructor(
      readonly retryAfter: number,
      readonly status = 429,
    ) {
      super(`Clerk Backend API request failed with ${status}`);
    }
  }

  function setTierPrices(): void {
    mockEnv("OKOU_PRICE_PRO", TEST_PRICE_PRO);
    mockEnv("OKOU_PRICE_TEAM", TEST_PRICE_TEAM);
    mockEnv("OKOU_PRICE_CUSTOM_CREDIT_UNIT", TEST_PRICE_CUSTOM_CREDIT_UNIT);
    mockEnv("OKOU_PRICE_CONCURRENCY", TEST_PRICE_CONCURRENCY);
  }

  function setUsagePackPrices(): void {
    mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_PRO", TEST_PRICE_USAGE_PACK_PLAN_PRO);
    mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_TEAM", TEST_PRICE_USAGE_PACK_PLAN_TEAM);
    mockEnv("OKOU_PRICE_USAGE_PACK_20", TEST_PRICE_USAGE_PACK_20);
    mockEnv("OKOU_PRICE_USAGE_PACK_50", TEST_PRICE_USAGE_PACK_50);
    mockEnv("OKOU_PRICE_USAGE_PACK_100", TEST_PRICE_USAGE_PACK_100);
    mockEnv("OKOU_PRICE_USAGE_PACK_200", TEST_PRICE_USAGE_PACK_200);
  }

  function usagePackPriceConfiguration(priceId: string): {
    readonly usagePackUsd: 20 | 50 | 100 | 200;
    readonly bonusCredits: number;
  } {
    switch (priceId) {
      case TEST_PRICE_USAGE_PACK_20: {
        return { usagePackUsd: 20, bonusCredits: 400 };
      }
      case TEST_PRICE_USAGE_PACK_50: {
        return { usagePackUsd: 50, bonusCredits: 2600 };
      }
      case TEST_PRICE_USAGE_PACK_100: {
        return { usagePackUsd: 100, bonusCredits: 8700 };
      }
      case TEST_PRICE_USAGE_PACK_200: {
        return { usagePackUsd: 200, bonusCredits: 22_200 };
      }
      default: {
        throw new Error(`Unexpected usage pack Price: ${priceId}`);
      }
    }
  }

  function mockUsagePackCatalog(): void {
    context.mocks.stripe.prices.retrieve.mockImplementation((priceId) => {
      if (typeof priceId !== "string") {
        throw new Error("Expected a Stripe Price ID");
      }
      if (priceId === TEST_PRICE_CONCURRENCY) {
        return Promise.resolve({
          id: priceId,
          active: true,
          currency: "usd",
          type: "recurring",
          recurring: { interval: "month", interval_count: 1 },
          unit_amount: 10_000,
          product: "prod_concurrency",
        });
      }
      const configuration = usagePackPriceConfiguration(priceId);
      return Promise.resolve({
        id: priceId,
        active: true,
        currency: "usd",
        type: "recurring",
        recurring: { interval: "month", interval_count: 1 },
        unit_amount: configuration.usagePackUsd * 100,
        tax_behavior: "exclusive",
        product: {
          id: `prod_${configuration.usagePackUsd}`,
          name: `$${configuration.usagePackUsd} usage pack`,
          metadata: { bonusCredits: String(configuration.bonusCredits) },
          tax_code: "txcd_10000000",
        },
      });
    });
  }

  function currentSecond(): number {
    return Math.floor(now() / 1000);
  }

  function stripeInputMetadata(
    input: unknown,
  ): Readonly<Record<string, string>> {
    if (
      typeof input !== "object" ||
      input === null ||
      !("metadata" in input) ||
      typeof input.metadata !== "object" ||
      input.metadata === null
    ) {
      throw new Error("Expected Stripe metadata");
    }
    const metadata = Object.entries(input.metadata);
    if (
      metadata.some(([, value]) => {
        return typeof value !== "string";
      })
    ) {
      throw new Error("Expected string Stripe metadata values");
    }
    return Object.fromEntries(metadata) as Readonly<Record<string, string>>;
  }

  function mockStatefulUsagePackCheckoutSessions(): Map<
    string,
    UsagePackCheckoutSessionState
  > {
    const sessionStates = new Map<string, UsagePackCheckoutSessionState>();
    let createdCount = 0;
    context.mocks.stripe.checkout.sessions.create.mockReset();
    context.mocks.stripe.checkout.sessions.create.mockImplementation(() => {
      createdCount += 1;
      const id = `cs_concurrent_${createdCount}_${randomUUID().slice(0, 8)}`;
      sessionStates.set(id, "open");
      return Promise.resolve({
        id,
        url: `https://checkout.stripe.test/${id}`,
      });
    });
    context.mocks.stripe.checkout.sessions.retrieve.mockReset();
    context.mocks.stripe.checkout.sessions.retrieve.mockImplementation(
      (sessionId) => {
        if (typeof sessionId !== "string") {
          throw new Error("Expected a Checkout Session ID");
        }
        const status = sessionStates.get(sessionId);
        if (!status) {
          throw new Error(`Unexpected Checkout Session ${sessionId}`);
        }
        return Promise.resolve({
          id: sessionId,
          status,
          url: `https://checkout.stripe.test/${sessionId}`,
        });
      },
    );
    context.mocks.stripe.checkout.sessions.expire.mockReset();
    context.mocks.stripe.checkout.sessions.expire.mockImplementation(
      (sessionId) => {
        if (typeof sessionId !== "string") {
          throw new Error("Expected a Checkout Session ID");
        }
        if (!sessionStates.has(sessionId)) {
          throw new Error(`Unexpected Checkout Session ${sessionId}`);
        }
        sessionStates.set(sessionId, "expired");
        return Promise.resolve({ id: sessionId, status: "expired" });
      },
    );
    return sessionStates;
  }

  function okouToken(args: {
    readonly userId: string;
    readonly orgId: string;
    readonly capabilities: readonly Capability[];
  }): string {
    const seconds = currentSecond();
    return signSandboxJwtForTests({
      scope: "okou",
      userId: args.userId,
      orgId: args.orgId,
      runId: `run_${randomUUID()}`,
      capabilities: args.capabilities,
      iat: seconds,
      exp: seconds + 600,
    });
  }

  function createOrgFixture(orgId = `org_${randomUUID()}`): BillingOrgFixture {
    return {
      orgId,
      userId: `user_${randomUUID()}`,
    };
  }

  function usagePackCheckoutBody(memberId: string) {
    return {
      tier: "pro" as const,
      memberUsagePacks: [{ memberId, usagePackUsd: 20 as const }],
      successUrl: `${APP_ORIGIN}/billing?billing=success`,
      cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
    };
  }

  function authenticateOrg(
    fixture: BillingOrgFixture,
    role: "org:admin" | "org:member" = "org:admin",
  ): void {
    mocks.clerk.session(fixture.userId, fixture.orgId, role);
  }

  function mockClerkOrganization(fixture: BillingOrgFixture): void {
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: fixture.orgId,
      slug: `billing-${fixture.orgId.slice(-8)}`,
      name: "Billing Checkout Test Org",
      createdBy: fixture.userId,
      createdAt: now(),
    });
  }

  async function readBillingStatus(
    fixture: BillingOrgFixture,
  ): Promise<BillingStatusResponse> {
    authenticateOrg(fixture);
    const response = await accept(
      setupApp({ context, routes: billingStatusRoutes })(
        billingStatusContract,
      ).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    return response.body;
  }

  async function createOnboardingPaymentPendingOrg(): Promise<BillingOrgFixture> {
    const fixture = createOrgFixture();
    const actor = {
      ...fixture,
      orgRole: "org:admin" as const,
      email: `${fixture.userId}@example.test`,
    };
    const completed = await createBddApi(context).completeOnboarding(actor);
    expect(completed.status).toBe(200);
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "limited-free-1",
      credits: 0,
    });
    await setOnboardingPaymentPendingFixture({
      orgId: fixture.orgId,
      onboardingPaymentPending: true,
    });
    return fixture;
  }

  async function createStripeCustomerOrgForFixture(
    fixture: BillingOrgFixture,
    customerId: string,
  ): Promise<void> {
    authenticateOrg(fixture);
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
      url: "https://checkout.stripe.com/session/setup-customer",
    });

    await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingCheckoutContract,
      ).create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
      }),
      [200],
    );
  }

  async function prepareUsagePackCheckoutOrg(
    fixture: BillingOrgFixture,
    customerId: string,
  ): Promise<void> {
    await createStripeCustomerOrgForFixture(fixture, customerId);
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
  }

  async function createSubscriptionOrg(args: {
    readonly tier: "pro" | "team" | "custom";
    readonly customerId?: string;
    readonly subscriptionId?: string;
    readonly subscriptionStatus?: string;
    readonly periodEndUnix?: number;
    readonly cancelAtPeriodEnd?: boolean;
  }): Promise<SubscriptionFixture> {
    const fixture = createOrgFixture();
    const customerId = args.customerId ?? `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId =
      args.subscriptionId ?? `sub_${randomUUID().slice(0, 8)}`;
    const periodEndUnix =
      args.periodEndUnix ?? Math.floor(now() / 1000) + 30 * 86_400;
    const priceId =
      args.tier === "custom"
        ? TEST_PRICE_CUSTOM
        : args.tier === "team"
          ? TEST_PRICE_TEAM
          : TEST_PRICE_PRO;
    const price = {
      id: priceId,
    };
    if (args.tier === "custom") {
      mockEnv("OKOU_PRICE_CUSTOM", TEST_PRICE_CUSTOM);
    }
    mockClerkOrganization(fixture);
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: customerId,
      metadata: { orgId: fixture.orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subscriptionId,
      status: args.subscriptionStatus ?? "active",
      customer: customerId,
      cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            price,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });

    const event = {
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
                price: { id: priceId },
                parent: { type: "subscription_item_details" },
                period: {
                  start: periodEndUnix - 30 * 86_400,
                  end: periodEndUnix,
                },
              },
            ],
          },
        },
      },
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
    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe(args.tier);
    expect(status.subscriptionStatus).toBe(args.subscriptionStatus ?? "active");
    expect(status.hasSubscription).toBeTruthy();
    return { ...fixture, customerId, subscriptionId };
  }

  function createOwnedBillingOrg(
    options: {
      readonly tier?: "pro" | "team" | "custom";
      readonly cleanupUsagePacks?: boolean;
      readonly foreverCustom?: boolean;
    } = {},
  ) {
    const fixture = createOrgFixture();
    const owner = createPublicBillingZeroFixture(
      context,
      {
        ...fixture,
        orgRole: "org:admin",
        email: fixture.userId + "@example.test",
      },
      {
        foreverCustom: options.foreverCustom
          ? {
              priceId: TEST_PRICE_ATOM_GRANT,
              webhookSecret: STRIPE_WEBHOOK_SECRET,
            }
          : undefined,
        plan: options.tier
          ? {
              tier: options.tier,
              priceId:
                options.tier === "pro"
                  ? TEST_PRICE_PRO
                  : options.tier === "team"
                    ? TEST_PRICE_TEAM
                    : TEST_PRICE_CUSTOM,
              webhookSecret: STRIPE_WEBHOOK_SECRET,
            }
          : undefined,
        beforeOrganizationCleanup: options.cleanupUsagePacks
          ? async () => {
              // Covers owned inserts that committed before their response was received.
              await usagePackStateAction({
                action: "cleanup-migration",
                orgId: fixture.orgId,
              });
            }
          : undefined,
      },
    );
    if (options.tier === "custom") {
      mockEnv("OKOU_PRICE_CUSTOM", TEST_PRICE_CUSTOM);
    }
    return { ...fixture, ...owner };
  }

  async function createPublicBillingOrg(tier?: "pro" | "team" | "custom") {
    const fixture = createOwnedBillingOrg({ tier });
    await fixture.initialize();
    return fixture;
  }

  async function createUsagePackAtomGrantOrg(tier: "pro" | "team") {
    const fixture = createOwnedBillingOrg({ cleanupUsagePacks: true });
    await fixture.run(async () => {
      await fixture.initialize();
      const customerId = `cus_${randomUUID().slice(0, 8)}`;
      const currentPeriodStart = currentSecond();
      const currentPeriodEnd = currentPeriodStart + 30 * 86_400;
      mockClerkOrganization(fixture);
      mockEnv("ATOM_GRANT_PRICE", TEST_PRICE_ATOM_GRANT);
      mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
      context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
        data: [],
      });
      const event = {
        type: "invoice.paid",
        data: {
          object: {
            id: `in_atom_${randomUUID().slice(0, 8)}`,
            customer: customerId,
            metadata: {
              type: "atom_grant",
              purpose: "atom_grant",
              source: "atom_entitlement",
              planVersion: "usagePack",
              orgId: fixture.orgId,
              tier,
              planId: tier,
              duration: "1m",
              atomGrantExpiresAt: new Date(
                currentPeriodEnd * 1000,
              ).toISOString(),
            },
            status: "paid",
            paid: true,
            parent: null,
            lines: {
              has_more: false,
              data: [
                {
                  id: `il_atom_${randomUUID().slice(0, 8)}`,
                  amount: 0,
                  subtotal: 0,
                  quantity: 1,
                  price: { id: TEST_PRICE_ATOM_GRANT },
                  period: { start: currentPeriodStart, end: currentPeriodEnd },
                  parent: { type: "invoice_item_details" },
                },
              ],
            },
          },
        },
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

      const status = await readBillingStatus(fixture);
      expect(status).toMatchObject({
        tier,
        credits: 0,
        subscriptionStatus: "atom_grant",
        hasSubscription: false,
        showUsagePack: true,
      });
    });
    return fixture;
  }

  async function createConcurrencySubscriptionOrg(
    args: {
      readonly subscriptionId: string;
      readonly slots: number;
      readonly periodEnd: Date;
    },
    owned?: {
      readonly orgId: string;
      readonly userId: string;
      readonly customerId: string;
    },
  ): Promise<SubscriptionFixture> {
    const fixture = owned ?? createOrgFixture();
    const customerId = owned?.customerId ?? `cus_${randomUUID().slice(0, 8)}`;
    const periodEndUnix = Math.floor(args.periodEnd.getTime() / 1000);
    mockClerkOrganization(fixture);
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: customerId,
      metadata: { orgId: fixture.orgId },
    });

    const event = {
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID().slice(0, 8)}`,
          customer: customerId,
          metadata: { purpose: "concurrency_subscription" },
          parent: {
            subscription_details: {
              subscription: args.subscriptionId,
              metadata: { purpose: "concurrency_subscription" },
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID().slice(0, 8)}`,
                quantity: args.slots,
                price: { id: TEST_PRICE_CONCURRENCY },
                parent: { type: "subscription_item_details" },
                period: {
                  start: periodEndUnix - 30 * 86_400,
                  end: periodEndUnix,
                },
              },
            ],
          },
        },
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: args.subscriptionId,
      customer: customerId,
      status: "active",
      cancel_at_period_end: false,
      schedule: null,
      metadata: {},
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_CONCURRENCY}`,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: args.slots,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
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
    context.mocks.stripe.subscriptions.retrieve.mockClear();
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: args.subscriptionId,
          quantity: args.slots,
          currentPeriodEnd: args.periodEnd.toISOString(),
          cancelAtPeriodEnd: false,
        }),
      ]),
    );
    return { ...fixture, customerId, subscriptionId: args.subscriptionId };
  }

  async function createMergedConcurrencySubscriptionOrg(args: {
    readonly slots: number;
    readonly periodEnd: Date;
  }): Promise<
    SubscriptionFixture & {
      readonly concurrencyItemId: string;
      readonly planCredits: number;
    }
  > {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({
      tier: "team",
      periodEndUnix: Math.floor(args.periodEnd.getTime() / 1000),
    });
    const planCredits = (await readBillingStatus(fixture)).credits;
    const concurrencyItemId = `si_${randomUUID()}`;
    const event = {
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID()}`,
          customer: fixture.customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: fixture.subscriptionId,
              metadata: {},
            },
          },
          lines: {
            data: [
              {
                id: `il_${randomUUID()}`,
                quantity: args.slots,
                price: { id: TEST_PRICE_CONCURRENCY },
                parent: { type: "subscription_item_details" },
                period: {
                  start: currentSecond(),
                  end: Math.floor(args.periodEnd.getTime() / 1000),
                },
              },
            ],
          },
        },
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      schedule: null,
      metadata: {},
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
          },
          {
            id: `si_${TEST_PRICE_CONCURRENCY}`,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: args.slots,
            current_period_end: Math.floor(args.periodEnd.getTime() / 1000),
          },
        ],
      },
    });
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
    return { ...fixture, concurrencyItemId, planCredits };
  }

  async function seedMemberRole(args: {
    readonly orgId: string;
    readonly userId: string;
    readonly role: "admin" | "member";
  }): Promise<void> {
    await store.set(seedOrgMembership$, args, context.signal);
  }

  return {
    context,
    mocks,
    usagePackStateAction,
    readUsagePackState,
    APP_ORIGIN,
    TEST_STAFF_ORG_ID,
    TEST_PRICE_PRO,
    TEST_PRICE_TEAM,
    TEST_PRICE_CUSTOM,
    TEST_PRICE_USAGE_PACK_PLAN_PRO,
    TEST_PRICE_USAGE_PACK_PLAN_TEAM,
    TEST_PRICE_USAGE_PACK_20,
    TEST_PRICE_USAGE_PACK_50,
    TEST_PRICE_USAGE_PACK_100,
    TEST_PRICE_USAGE_PACK_200,
    TEST_PRICE_USAGE_ALLOWANCE,
    TEST_PRICE_CUSTOM_CREDIT_UNIT,
    TEST_PRICE_CONCURRENCY,
    STRIPE_WEBHOOK_SECRET,
    ClerkApiResponseTestError,
    setTierPrices,
    setUsagePackPrices,
    usagePackPriceConfiguration,
    mockUsagePackCatalog,
    currentSecond,
    stripeInputMetadata,
    mockStatefulUsagePackCheckoutSessions,
    okouToken,
    createOrgFixture,
    usagePackCheckoutBody,
    authenticateOrg,
    mockClerkOrganization,
    readBillingStatus,
    createOnboardingPaymentPendingOrg,
    createStripeCustomerOrgForFixture,
    prepareUsagePackCheckoutOrg,
    createSubscriptionOrg,
    createOwnedBillingOrg,
    createPublicBillingOrg,
    createUsagePackAtomGrantOrg,
    createConcurrencySubscriptionOrg,
    createMergedConcurrencySubscriptionOrg,
    seedMemberRole,
  };
}
