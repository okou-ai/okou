import { randomUUID } from "node:crypto";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";

import { HttpResponse, http } from "msw";
import { testBillingReconciliationStateContract } from "@okouai/api-contracts/contracts/test-billing-reconciliation-state";
import {
  type BillingStatusResponse,
  USAGE_PACKS_USD,
  billingCheckoutContract,
  billingUsagePackCatalogContract,
  billingUsagePackCheckoutContract,
  billingUsagePackCreditsContract,
  billingUsagePackManagementContract,
  billingUsagePackMigrationContract,
  billingConcurrencyCheckoutContract,
  billingConcurrencySubscriptionContract,
  billingCreditCheckoutContract,
  billingDowngradeContract,
  billingRestoreContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import {
  orgInviteContract,
  orgMembersContract,
} from "@okouai/api-contracts/contracts/org-member-routes";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import type { OrgTier } from "@okouai/api-contracts/contracts/orgs";
import { isStaffOrg } from "@okouai/core/staff-org";
import {
  webhookClerkContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import StripeSDK from "stripe";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import {
  mockStripeClient,
  type StripeInvoice,
  type StripeInvoiceCreatePreviewParams,
} from "../../external/stripe-client";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import {
  seedOrgMetadata,
  setOnboardingPaymentPendingFixture,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi } from "./helpers/api-bdd";
import {
  postSubscriptionInvoicePaid,
  postUsageAllowanceInvoicePaid,
} from "./helpers/stripe-billing-webhook";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { readOrgAcquisitionAttributionFixture } from "../../../test-fixtures/org-metadata";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { testBillingReconciliationStateRoutes } from "../test-billing-reconciliation-state";
import { billingCheckoutRoutes } from "../billing-checkout";
import { acquisitionAttributionRoutes } from "../acquisition-attribution";
import { billingConcurrencyCheckoutRoutes } from "../billing-concurrency-checkout";
import { billingConcurrencySubscriptionRoutes } from "../billing-concurrency-subscriptions";
import { billingCreditCheckoutRoutes } from "../billing-credit-checkout";
import { billingDowngradeRoutes } from "../billing-downgrade";
import { billingRestoreRoutes } from "../billing-restore";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { billingStatusRoutes } from "../billing-status";
import { orgMembersRoutes } from "../org-members";
import { orgInviteRoutes } from "../org-invite";
import { orgReadRoutes } from "../org-read";
import {
  testUsagePackSubscriptionStateContract,
  testUsagePackSubscriptionStateRoutes,
  type TestUsagePackSubscriptionStateAction,
  type TestUsagePackSubscriptionStateResponse,
} from "../test-usage-pack-subscription-state";

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

async function reconcileBillingOrganization(orgId: string): Promise<void> {
  await accept(
    setupApp({
      context,
      routes: testBillingReconciliationStateRoutes,
    })(testBillingReconciliationStateContract).reconcile({
      body: { orgIds: [orgId] },
    }),
    [200],
  );
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

interface BillingOrgFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface SubscriptionFixture extends BillingOrgFixture {
  readonly customerId: string;
  readonly subscriptionId: string;
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

function stripeInputMetadata(input: unknown): Readonly<Record<string, string>> {
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

type UsagePackCheckoutSessionState = "open" | "expired";

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

async function createUsagePackAtomGrantOrg(
  tier: "pro" | "team",
): Promise<BillingOrgFixture> {
  const fixture = createOrgFixture();
  const customerId = `cus_${randomUUID().slice(0, 8)}`;
  const currentPeriodStart = currentSecond();
  const currentPeriodEnd = currentPeriodStart + 30 * 86_400;
  await seedOrgMetadata({
    orgId: fixture.orgId,
    tier: "limited-free-1",
    credits: 0,
  });
  mockClerkOrganization(fixture);
  mockEnv("ATOM_GRANT_PRICE", TEST_PRICE_ATOM_GRANT);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
  context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({ data: [] });
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
          atomGrantExpiresAt: new Date(currentPeriodEnd * 1000).toISOString(),
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
  return fixture;
}

async function createConcurrencySubscriptionOrg(args: {
  readonly subscriptionId: string;
  readonly slots: number;
  readonly periodEnd: Date;
  readonly tier?: Extract<OrgTier, "team" | "custom">;
}): Promise<SubscriptionFixture> {
  const fixture = createOrgFixture();
  const customerId = `cus_${randomUUID().slice(0, 8)}`;
  const periodEndUnix = Math.floor(args.periodEnd.getTime() / 1000);
  if (args.tier) {
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: args.tier,
      credits: 0,
    });
  }
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

async function createMergedUsageAllowanceConcurrencySubscriptionOrg(args: {
  readonly slots: number;
  readonly periodEnd: Date;
}): Promise<
  SubscriptionFixture & {
    readonly allowanceItemId: string;
    readonly concurrencyItemId: string;
  }
> {
  const fixture = createOrgFixture();
  await seedOrgMetadata({
    orgId: fixture.orgId,
    tier: "custom",
    credits: 0,
  });
  const customerId = `cus_${randomUUID().slice(0, 8)}`;
  const subscriptionId = `sub_${randomUUID()}`;
  const allowanceItemId = `si_${randomUUID()}`;
  const concurrencyItemId = `si_${randomUUID()}`;
  const periodStartUnix = currentSecond();
  const periodEndUnix = Math.floor(args.periodEnd.getTime() / 1000);
  const metadata = {
    type: "usage_allowance",
    purpose: "usage_allowance",
    source: "atom_usage_allowance",
    orgId: fixture.orgId,
    shortWindowSeconds: "18000",
    shortWindowUnits: "625000",
    weeklyWindowSeconds: "604800",
    weeklyWindowUnits: "5000000",
  };
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
        id: `in_${randomUUID()}`,
        customer: customerId,
        metadata,
        parent: {
          subscription_details: { subscription: subscriptionId, metadata },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${randomUUID()}`,
              quantity: 1,
              price: { id: TEST_PRICE_USAGE_ALLOWANCE },
              parent: { type: "subscription_item_details" },
              period: { start: periodStartUnix, end: periodEndUnix },
            },
            {
              id: `il_${randomUUID()}`,
              quantity: args.slots,
              price: { id: TEST_PRICE_CONCURRENCY },
              parent: { type: "subscription_item_details" },
              period: { start: periodStartUnix, end: periodEndUnix },
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
  context.mocks.stripe.subscriptions.retrieve.mockClear();
  return {
    ...fixture,
    customerId,
    subscriptionId,
    allowanceItemId,
    concurrencyItemId,
  };
}

async function seedMemberRole(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly role: "admin" | "member";
}): Promise<void> {
  await store.set(seedOrgMembership$, args, context.signal);
}

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

  function trackedPendingSeed(): Promise<{
    orgId: string;
    userId: string;
  }> {
    return createOnboardingPaymentPendingOrg();
  }

  async function trackedCustomSeed(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const fixture = createOrgFixture();
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "custom",
      credits: 0,
    });
    return fixture;
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

  it.each(["plan", "usage pack"] as const)(
    "keeps %s checkout available without Clerk attribution in CI previews",
    async (kind) => {
      mockEnv("ENV", "preview");
      mockOptionalEnv("OKOU_PREVIEW_JOB_REF", "pr-123");
      setUsagePackPrices();
      mockUsagePackCatalog();
      const fixture = createOrgFixture();
      authenticateOrg(fixture);
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
      context.mocks.clerk.users.getUserList.mockRejectedValue(
        new ClerkApiResponseTestError(1),
      );
      context.mocks.stripe.customers.create.mockResolvedValue({
        id: `cus_${randomUUID()}`,
      });
      context.mocks.stripe.checkout.sessions.create.mockImplementation(
        (input) => {
          const subscriptionId =
            stripeInputMetadata(input).usagePackSubscriptionId;
          if (subscriptionId) {
            onTestFinished(async () => {
              await usagePackStateAction({
                action: "cleanup",
                orgId: fixture.orgId,
                usagePackSubscriptionId: subscriptionId,
                deleteGrants: false,
                deleteOrgMetadata: true,
              });
            });
          }
          return Promise.resolve({
            id: `cs_${randomUUID()}`,
            url: "https://checkout.stripe.com/session/ci",
          });
        },
      );
      const api = setupApp({ context, routes: billingCheckoutRoutes });
      const body = {
        ...usagePackCheckoutBody(fixture.userId),
        adAttribution: { gclid: "ci-click", okou_campaign_id: "24220469665" },
      };
      const response = await (kind === "usage pack"
        ? accept(
            api(billingUsagePackCheckoutContract).create({
              headers: { authorization: "Bearer clerk-session" },
              body,
            }),
            [200],
          )
        : accept(
            api(billingCheckoutContract).create({
              headers: { authorization: "Bearer clerk-session" },
              body: {
                tier: body.tier,
                successUrl: body.successUrl,
                cancelUrl: body.cancelUrl,
                adAttribution: body.adAttribution,
              },
            }),
            [200],
          ));
      expect(response.body).toStrictEqual({
        url: "https://checkout.stripe.com/session/ci",
      });
      expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
      expect(
        context.mocks.clerk.users.updateUserMetadata,
      ).not.toHaveBeenCalled();
    },
  );

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

    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith({
      metadata: { orgId: fixture.orgId },
    });
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
      },
      subscription_data: {
        metadata: {
          orgId: fixture.orgId,
          tier: "pro",
          priceId: okouPricePro,
        },
      },
    });
  });

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

  it("allows only one of two Plan previews to create a subscription", async () => {
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
    let createdSubscription:
      | {
          readonly id: string;
          readonly customer: string;
          readonly status: string;
          readonly metadata: Readonly<Record<string, string>>;
          readonly items: {
            readonly data: readonly {
              readonly price: { readonly id: string };
            }[];
          };
        }
      | undefined;
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.create.mockImplementation((input) => {
      createdSubscription = {
        id: `sub_${randomUUID().slice(0, 8)}`,
        customer: customerId,
        status: "active",
        metadata: stripeInputMetadata(input),
        items: { data: [{ price: { id: TEST_PRICE_PRO } }] },
      };
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [createdSubscription],
        has_more: false,
      });
      return Promise.resolve({
        ...createdSubscription,
        latest_invoice: null,
      });
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
    if (
      !("previewToken" in firstPreview.body) ||
      !("previewToken" in secondPreview.body)
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
    expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledTimes(1);
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
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith({
      metadata: {
        orgId: fixture.orgId,
        ...expectedPreviewMetadata,
      },
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          orgId: fixture.orgId,
          tier: "pro",
          priceId: TEST_PRICE_PRO,
          ...expectedPreviewMetadata,
        },
        subscription_data: expect.objectContaining({
          metadata: {
            orgId: fixture.orgId,
            tier: "pro",
            priceId: TEST_PRICE_PRO,
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
    const fixture = await trackedCustomSeed();
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

  it("keeps a stored click separate from a later campaign during checkout", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: fixture.userId,
          privateMetadata: {
            signup_attribution: {
              source_type: "paid",
              gclid: "first-click",
              gclid_present: "true",
              utm_source: "google",
              recorded_at: "2026-09-01T00:00:00.000Z",
            },
          },
        },
      ],
    });
    context.mocks.stripe.customers.create.mockResolvedValue({
      id: `cus_${randomUUID().slice(0, 8)}`,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/first-touch",
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );
    await accept(
      client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
          adAttribution: {
            gclid: "later-click",
            vm0_campaign_id: "24220469665",
            vm0_ad_group_id: "123456",
            utm_campaign: "later-campaign",
            ga_client_id: "123.456",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const expectedMetadata = {
      orgId: fixture.orgId,
      tier: "pro",
      priceId: TEST_PRICE_PRO,
      source_type: "paid",
      gclid: "first-click",
      gclid_present: "true",
      utm_source: "google",
      ga_client_id: "123.456",
    };
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expectedMetadata,
        subscription_data: expect.objectContaining({
          metadata: expectedMetadata,
        }),
      }),
    );
    await expect(
      readOrgAcquisitionAttributionFixture(fixture.orgId),
    ).resolves.toMatchObject({
      acquisitionGclid: "first-click",
      acquisitionCampaignId: null,
      acquisitionAdGroupId: null,
      acquisitionCampaign: null,
    });
  });

  it.each(["legacy", "okou"])(
    "attaches %s ad attribution to Stripe checkout and subscription metadata",
    async (brand) => {
      const fixture = await trackedSeed();
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

      const customerId = `cus_${randomUUID().slice(0, 8)}`;
      context.mocks.stripe.customers.create.mockResolvedValue({
        id: customerId,
      });
      context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
        url: "https://checkout.stripe.com/session/attributed",
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
            adAttribution: {
              source_type: "paid",
              vm0_source: "presentation",
              ...(brand === "okou"
                ? {
                    okou_campaign_id: "1234567890",
                    okou_ad_group_id: "9876543210",
                  }
                : {
                    vm0_campaign_id: "1234567890",
                    vm0_ad_group_id: "9876543210",
                  }),
              utm_source: "google",
              utm_medium: "cpc",
              utm_campaign: "presentation_search_en",
              utm_content: "hero",
              utm_term: "ai",
              gclid: "test-gclid",
              gclid_present: "true",
            },
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        url: "https://checkout.stripe.com/session/attributed",
      });
      const expectedAttribution = {
        source_type: "paid",
        vm0_source: "presentation",
        okou_campaign_id: "1234567890",
        okou_ad_group_id: "9876543210",
        vm0_campaign_id: "1234567890",
        vm0_ad_group_id: "9876543210",
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "presentation_search_en",
        utm_content: "hero",
        utm_term: "ai",
        gclid: "test-gclid",
        gclid_present: "true",
      };
      const expectedMetadata = {
        orgId: fixture.orgId,
        tier: "pro",
        priceId: TEST_PRICE_PRO,
        ...expectedAttribution,
      };
      expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith({
        metadata: {
          orgId: fixture.orgId,
          ...expectedAttribution,
        },
      });
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expectedMetadata,
          subscription_data: expect.objectContaining({
            metadata: expectedMetadata,
          }),
        }),
      );

      await expect(
        readOrgAcquisitionAttributionFixture(fixture.orgId),
      ).resolves.toMatchObject({
        acquisitionSourceType: "paid",
        acquisitionFirstPartySource: "presentation",
        acquisitionCampaignId: "1234567890",
        acquisitionAdGroupId: "9876543210",
        acquisitionCampaign: "presentation_search_en",
        acquisitionUtmSource: "google",
        acquisitionUtmMedium: "cpc",
        acquisitionUtmContent: "hero",
        acquisitionUtmTerm: "ai",
        acquisitionGclid: "test-gclid",
        acquisitionRecordedAt: expect.any(Date),
      });
    },
  );

  it("returns Pro trial checkout URL during onboarding payment", async () => {
    const fixture = await trackedPendingSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/trial",
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );

    const response = await accept(
      client.create({
        body: {
          tier: "pro",
          trialDays: 7,
          successUrl: `${APP_ORIGIN}/onboarding?billing=pro`,
          cancelUrl: `${APP_ORIGIN}/onboarding?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/trial",
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${APP_ORIGIN}/onboarding?billing=pro`,
      cancel_url: `${APP_ORIGIN}/onboarding?billing=canceled`,
      metadata: {
        orgId: fixture.orgId,
        tier: "pro",
        priceId: TEST_PRICE_PRO,
      },
      subscription_data: {
        metadata: {
          orgId: fixture.orgId,
          tier: "pro",
          priceId: TEST_PRICE_PRO,
        },
        trial_period_days: 7,
      },
    });
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
    const fixture = await trackedPendingSeed();
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
    const fixture = await trackedPendingSeed();
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
          trialDays: 7,
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

describe("POST /api/billing/usage-pack-checkout", () => {
  beforeEach(() => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    setTierPrices();
    setUsagePackPrices();
    mockUsagePackCatalog();
  });

  it("returns the server-validated Stripe usage pack catalog", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCatalogContract,
      ).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          totalCredits: 20_400,
        },
        {
          usagePackUsd: 50,
          priceUsd: 50,
          purchasedCredits: 50_000,
          bonusCredits: 2600,
          totalCredits: 52_600,
        },
        {
          usagePackUsd: 100,
          priceUsd: 100,
          purchasedCredits: 100_000,
          bonusCredits: 8700,
          totalCredits: 108_700,
        },
        {
          usagePackUsd: 200,
          priceUsd: 200,
          purchasedCredits: 200_000,
          bonusCredits: 22_200,
          totalCredits: 222_200,
        },
      ],
    });
  });

  it.each(["pro", "team"] as const)(
    "rejects %s checkout without a paid usage pack",
    async (tier) => {
      const fixture = createOrgFixture();
      authenticateOrg(fixture);

      const response = await accept(
        setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackCheckoutContract,
        ).create({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            tier,
            memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 0 }],
            successUrl: `${APP_ORIGIN}/billing?billing=success`,
            cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
          },
        }),
        [400],
      );

      expect(response.body).toStrictEqual({
        error: {
          message: "At least one member must have a paid usage pack",
          code: "BAD_REQUEST",
        },
      });
    },
  );

  it.each(["pro", "team"] as const)(
    "checks out %s with both paid and no-package members",
    async (tier) => {
      const fixture = createOrgFixture();
      const freeMemberId = `user_${randomUUID()}`;
      authenticateOrg(fixture);
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [
            {
              role: "org:admin",
              publicUserData: { userId: fixture.userId },
              createdAt: now(),
            },
            {
              role: "org:member",
              publicUserData: { userId: freeMemberId },
              createdAt: now(),
            },
          ],
        },
      );
      context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
        { data: [] },
      );
      context.mocks.stripe.customers.create.mockResolvedValue({
        id: `cus_${randomUUID()}`,
      });
      let snapshotId: string | null = null;
      context.mocks.stripe.checkout.sessions.create.mockImplementation(
        async (input) => {
          const metadata = stripeInputMetadata(input);
          snapshotId = metadata.usagePackSubscriptionId ?? null;
          if (!snapshotId) {
            throw new Error("Expected a subscription snapshot");
          }
          const state = await readUsagePackState(fixture.orgId, snapshotId);
          expect(state.subscription).not.toBeNull();
          expect(state.allocations).toMatchObject([
            { userId: fixture.userId, usagePackUsd: 20 },
          ]);
          return {
            id: `cs_${randomUUID()}`,
            url: "https://checkout.stripe.com/session/no-package-member",
          };
        },
      );
      await accept(
        setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackCheckoutContract,
        ).create({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            tier,
            memberUsagePacks: [
              { memberId: fixture.userId, usagePackUsd: 20 },
              { memberId: freeMemberId, usagePackUsd: 0 },
            ],
            successUrl: `${APP_ORIGIN}/billing?billing=success`,
            cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
          },
        }),
        [200],
      );
      const createdSnapshotId = snapshotId;
      if (!createdSnapshotId) {
        throw new Error("Checkout did not create a snapshot");
      }
      onTestFinished(async () => {
        await usagePackStateAction({
          action: "cleanup",
          orgId: fixture.orgId,
          usagePackSubscriptionId: createdSnapshotId,
          deleteGrants: false,
          deleteOrgMetadata: false,
        });
      });
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [
            {
              price:
                tier === "pro"
                  ? TEST_PRICE_USAGE_PACK_PLAN_PRO
                  : TEST_PRICE_USAGE_PACK_PLAN_TEAM,
              quantity: 1,
            },
            { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
          ],
        }),
        expect.any(Object),
      );
    },
  );

  it("checks out the new plan", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const memberIds = Array.from({ length: 101 }, (_, index) => {
      return index === 0 ? fixture.userId : `user_${randomUUID()}`;
    });
    const invitationId = `inv_${randomUUID()}`;
    const customerId = `cus_${randomUUID()}`;
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
      (args) => {
        const offset =
          typeof args === "object" &&
          args !== null &&
          "offset" in args &&
          typeof args.offset === "number"
            ? args.offset
            : 0;
        const limit =
          typeof args === "object" &&
          args !== null &&
          "limit" in args &&
          typeof args.limit === "number"
            ? args.limit
            : 100;
        return Promise.resolve({
          data: memberIds.slice(offset, offset + limit).map((userId) => {
            return {
              role: "org:member",
              publicUserData: { userId },
              createdAt: now(),
            };
          }),
        });
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      {
        data: [
          {
            id: invitationId,
            emailAddress: "pending@example.com",
            role: "org:member",
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    let snapshotExistedBeforeStripe = false;
    let createdUsagePackSubscriptionId: string | null = null;
    const checkoutSessionId = `cs_${randomUUID()}`;
    context.mocks.stripe.checkout.sessions.create.mockImplementationOnce(
      async (input) => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("metadata" in input) ||
          typeof input.metadata !== "object" ||
          input.metadata === null ||
          !("usagePackSubscriptionId" in input.metadata) ||
          typeof input.metadata.usagePackSubscriptionId !== "string"
        ) {
          throw new Error("Expected usage pack subscription metadata");
        }
        createdUsagePackSubscriptionId = input.metadata.usagePackSubscriptionId;
        const state = await readUsagePackState(
          fixture.orgId,
          input.metadata.usagePackSubscriptionId,
        );
        snapshotExistedBeforeStripe = state.subscription !== null;
        return {
          id: checkoutSessionId,
          url: "https://checkout.stripe.com/session/usage-pack",
        };
      },
    );

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: {
          tier: "team",
          memberUsagePacks: [
            ...memberIds.map((memberId, index) => {
              return {
                memberId,
                usagePackUsd: USAGE_PACKS_USD[index] ?? 20,
              };
            }),
            { memberId: invitationId, usagePackUsd: 20 },
          ],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/usage-pack",
    });
    expect(snapshotExistedBeforeStripe).toBeTruthy();
    if (!createdUsagePackSubscriptionId) {
      throw new Error("Checkout did not expose its usage pack subscription ID");
    }
    const createdSnapshotId = createdUsagePackSubscriptionId;
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId: createdSnapshotId,
        deleteGrants: false,
        deleteOrgMetadata: false,
      });
    });
    const state = await readUsagePackState(fixture.orgId, createdSnapshotId);
    const snapshot = state.subscription;
    expect(snapshot?.stripeCheckoutSessionId).toBe(checkoutSessionId);
    const allocationRows = state.allocations;
    expect(allocationRows).toHaveLength(102);
    expect(allocationRows).toContainEqual(
      expect.objectContaining({
        userId: memberIds[1],
        invitationId: null,
        usagePackUsd: 50,
        stripePriceId: TEST_PRICE_USAGE_PACK_50,
        status: "pending_payment",
      }),
    );
    expect(allocationRows).toContainEqual(
      expect.objectContaining({
        userId: null,
        invitationId,
        usagePackUsd: 20,
        stripePriceId: TEST_PRICE_USAGE_PACK_20,
        status: "pending_payment",
      }),
    );
    const metadata = {
      orgId: fixture.orgId,
      tier: "team",
      priceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
      purpose: "usage_pack_subscription",
      usagePackSubscriptionId: createdSnapshotId,
    };
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      {
        mode: "subscription",
        customer: expect.any(String),
        line_items: [
          { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
          { price: TEST_PRICE_USAGE_PACK_20, quantity: 99 },
          { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
          { price: TEST_PRICE_USAGE_PACK_100, quantity: 1 },
          { price: TEST_PRICE_USAGE_PACK_200, quantity: 1 },
        ],
        allow_promotion_codes: true,
        success_url: `${APP_ORIGIN}/billing?billing=success`,
        cancel_url: `${APP_ORIGIN}/billing?billing=canceled`,
        metadata,
        subscription_data: { metadata },
      },
      { idempotencyKey: `usage-pack-checkout:${createdSnapshotId}` },
    );
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenNthCalledWith(1, {
      organizationId: fixture.orgId,
      limit: 100,
      offset: 0,
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenNthCalledWith(2, {
      organizationId: fixture.orgId,
      limit: 100,
      offset: 100,
    });
  });

  it("separates the immediate balance-adjusted charge from the recurring amount", async () => {
    const fixture = createOrgFixture();
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
    authenticateOrg(fixture);
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
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (
        typeof input !== "object" ||
        input === null ||
        !("preview_mode" in input)
      ) {
        throw new Error("Expected a usage pack invoice preview mode");
      }
      return Promise.resolve({
        id: `in_preview_${randomUUID()}`,
        customer: customerId,
        amount_due: input.preview_mode === "next" ? 2000 : 4000,
        currency: "usd",
        status: null,
        metadata: {},
        hosted_invoice_url: null,
        lines: { has_more: false, data: [] },
        parent: null,
      });
    });

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: {
          tier: "pro",
          supportsInAppPreview: true,
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "preview",
      purchaseType: "usage_pack",
      tier: "pro",
      immediateAmountCents: 2000,
      nextRecurringAmountCents: 4000,
      currency: "usd",
      expiresAt: expect.any(String),
      previewToken: expect.any(String),
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({ preview_mode: "next" }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({ preview_mode: "recurring" }),
    );
    if (!("previewToken" in response.body)) {
      throw new Error("Expected a usage pack purchase preview");
    }

    const subscriptionId = `sub_${randomUUID()}`;
    const invoiceId = `in_${randomUUID()}`;
    const billingPeriod = {
      start: currentSecond(),
      end: currentSecond() + 30 * 86_400,
    };
    let usagePackSubscriptionId: string | undefined;
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.create.mockImplementation((input) => {
      const metadata = stripeInputMetadata(input);
      usagePackSubscriptionId = metadata.usagePackSubscriptionId;
      const paidInvoice = {
        id: invoiceId,
        customer: customerId,
        metadata,
        status: "paid" as const,
        paid: true,
        amount_due: 2000,
        amount_paid: 2000,
        currency: "usd",
        hosted_invoice_url: null,
        parent: {
          subscription_details: { subscription: subscriptionId, metadata },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${randomUUID()}`,
              amount: 2000,
              subtotal: 2000,
              quantity: 1,
              price: { id: TEST_PRICE_USAGE_PACK_20 },
              period: billingPeriod,
              parent: {
                type: "subscription_item_details" as const,
                subscription_item_details: { proration: false },
              },
            },
          ],
        },
      };
      const subscription = {
        id: subscriptionId,
        customer: customerId,
        status: "active",
        cancel_at: null,
        cancel_at_period_end: false,
        schedule: null,
        metadata,
        items: {
          data: [
            {
              id: `si_${randomUUID()}`,
              price: {
                id: TEST_PRICE_USAGE_PACK_PLAN_PRO,
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity: 1,
              current_period_start: billingPeriod.start,
              current_period_end: billingPeriod.end,
            },
            {
              id: `si_${randomUUID()}`,
              price: {
                id: TEST_PRICE_USAGE_PACK_20,
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity: 1,
              current_period_start: billingPeriod.start,
              current_period_end: billingPeriod.end,
            },
          ],
        },
        latest_invoice: paidInvoice,
      };
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription,
      );
      return Promise.resolve(subscription);
    });

    const confirmation = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).confirm({
        body: { previewToken: response.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
    });
    if (!usagePackSubscriptionId) {
      throw new Error("Expected the confirmed usage pack subscription ID");
    }
    const confirmedUsagePackSubscriptionId = usagePackSubscriptionId;
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId: confirmedUsagePackSubscriptionId,
        deleteGrants: true,
        deleteOrgMetadata: true,
      });
    });
  });

  it("recovers usage pack checkout from a transient Clerk server failure", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const checkoutSessionId = `cs_${randomUUID()}`;
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    context.mocks.clerk.organizations.getOrganizationMembershipList
      .mockRejectedValueOnce(new ClerkApiResponseTestError(2, 521))
      .mockResolvedValue({
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
        ],
      });
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: `cus_${randomUUID()}`,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
      id: checkoutSessionId,
      url: "https://checkout.stripe.com/session/usage-pack-recovered",
    });

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: usagePackCheckoutBody(fixture.userId),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const checkoutCall =
      context.mocks.stripe.checkout.sessions.create.mock.calls[0];
    const usagePackSubscriptionId = checkoutCall
      ? stripeInputMetadata(checkoutCall[0]).usagePackSubscriptionId
      : undefined;
    if (!usagePackSubscriptionId) {
      throw new Error("Checkout did not expose its usage pack subscription ID");
    }
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId,
        deleteGrants: true,
        deleteOrgMetadata: true,
      });
    });

    expect(response.body).toStrictEqual({
      url: "https://checkout.stripe.com/session/usage-pack-recovered",
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(2);
    expect(context.mocks.signalTimers.delay).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(
      1,
    );
  });

  it("returns a non-cacheable 503 on the first Clerk rate limit", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkApiResponseTestError(7),
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: usagePackCheckoutBody(fixture.userId),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Billing organization members are temporarily unavailable",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(context.mocks.stripe.customers.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("preserves non-rate-limit Clerk checkout failures", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new Error("Clerk membership read failed"),
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: usagePackCheckoutBody(fixture.userId),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [500],
    );

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(context.mocks.stripe.customers.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("stops sibling Clerk pagination after a checkout directory rate limit", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const invitationPage = createDeferredPromise<{
      readonly data: readonly {
        readonly id: string;
        readonly emailAddress: string;
        readonly role: string;
        readonly createdAt: number;
      }[];
    }>(context.signal);
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkApiResponseTestError(1),
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockReturnValueOnce(
      invitationPage.promise,
    );

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: usagePackCheckoutBody(fixture.userId),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );

    expect(response.headers.get("Retry-After")).toBe("1");
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.getOrganizationInvitationList,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.customers.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();

    invitationPage.resolve({
      data: Array.from({ length: 100 }, (_, index) => {
        return {
          id: `inv_${index}`,
          emailAddress: `pending-${index}@example.com`,
          role: "org:member",
          createdAt: now(),
        };
      }),
    });
    await invitationPage.promise;
    expect(
      context.mocks.clerk.organizations.getOrganizationInvitationList,
    ).toHaveBeenCalledTimes(1);
  });

  it("stops Clerk 5xx retries when usage pack checkout is cancelled", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const controller = new AbortController();
    const retryStarted = createDeferredPromise<void>(context.signal);
    let retrySignal: AbortSignal | undefined;
    context.mocks.signalTimers.delay.mockImplementation((_ms, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("Expected Clerk retry delay to receive a signal");
      }
      retrySignal = signal;
      retryStarted.resolve();
      return createDeferredPromise<void>(signal).promise;
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkApiResponseTestError(1, 521),
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    const request = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    ).create({
      body: usagePackCheckoutBody(fixture.userId),
      headers: { authorization: "Bearer clerk-session" },
      fetchOptions: { signal: controller.signal },
    });

    await retryStarted.promise;
    const abortError = new Error("usage pack checkout cancelled");
    abortError.name = "AbortError";
    controller.abort(abortError);
    const response = await accept(request, [500]);

    expect(response.status).toBe(500);
    expect(retrySignal?.aborted).toBeTruthy();
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.customers.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it.each(["pro", "team"] as const)(
    "configures the current %s plan after an Atom grant",
    async (tier) => {
      const fixture = await createUsagePackAtomGrantOrg(tier);
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
        id: `cus_checkout_${randomUUID().slice(0, 8)}`,
      });
      const checkoutSessions = [
        {
          id: `cs_${randomUUID().slice(0, 8)}`,
          url: "https://checkout.stripe.com/session/atom-usage-pack",
        },
        {
          id: `cs_${randomUUID().slice(0, 8)}`,
          url: "https://checkout.stripe.com/session/atom-usage-pack-replaced",
        },
      ] as const;
      const usagePackSubscriptionIds: string[] = [];
      let checkoutAttempt = 0;
      context.mocks.stripe.checkout.sessions.create.mockImplementation(
        (input) => {
          if (
            typeof input !== "object" ||
            input === null ||
            !("metadata" in input) ||
            typeof input.metadata !== "object" ||
            input.metadata === null ||
            !("usagePackSubscriptionId" in input.metadata) ||
            typeof input.metadata.usagePackSubscriptionId !== "string"
          ) {
            throw new Error("Expected usage pack subscription metadata");
          }
          const session = checkoutSessions[checkoutAttempt];
          if (!session) {
            throw new Error("Unexpected extra usage pack Checkout Session");
          }
          checkoutAttempt += 1;
          usagePackSubscriptionIds.push(input.metadata.usagePackSubscriptionId);
          return Promise.resolve(session);
        },
      );

      const client = setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      );
      const response = await accept(
        client.create({
          body: {
            tier,
            memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
            adAttribution: { vm0_source: "presentation" },
            successUrl: `${APP_ORIGIN}/billing?billing=success`,
            cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      if (!("url" in response.body)) {
        throw new Error("Expected hosted usage pack checkout response");
      }
      expect(response.body.url).toBe(checkoutSessions[0].url);
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            vm0_source: "presentation",
          }),
          line_items: [
            {
              price:
                tier === "pro"
                  ? TEST_PRICE_USAGE_PACK_PLAN_PRO
                  : TEST_PRICE_USAGE_PACK_PLAN_TEAM,
              quantity: 1,
            },
            { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
          ],
        }),
        expect.objectContaining({
          idempotencyKey: expect.stringContaining("usage-pack-checkout:"),
        }),
      );
      context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
        id: checkoutSessions[0].id,
        status: "open",
        url: checkoutSessions[0].url,
        customer: null,
        subscription: null,
        metadata: null,
      });

      const retried = await accept(
        client.create({
          body: {
            tier,
            memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
            adAttribution: { vm0_source: "presentation" },
            successUrl: `${APP_ORIGIN}/billing?billing=success`,
            cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      if (!("url" in retried.body)) {
        throw new Error("Expected hosted usage pack checkout response");
      }
      expect(retried.body.url).toBe(checkoutSessions[0].url);
      expect(
        context.mocks.stripe.checkout.sessions.retrieve,
      ).toHaveBeenCalledWith(checkoutSessions[0].id);
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).toHaveBeenCalledTimes(1);

      context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
        id: checkoutSessions[0].id,
        status: "open",
        url: checkoutSessions[0].url,
        customer: null,
        subscription: null,
        metadata: null,
      });
      context.mocks.stripe.checkout.sessions.expire.mockResolvedValueOnce({
        id: checkoutSessions[0].id,
        status: "expired",
      });

      const replaced = await accept(
        client.create({
          body: {
            tier,
            memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 50 }],
            adAttribution: { vm0_source: "marketing" },
            successUrl: `${APP_ORIGIN}/billing?billing=success`,
            cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      if (!("url" in replaced.body)) {
        throw new Error("Expected hosted usage pack checkout response");
      }
      expect(replaced.body.url).toBe(checkoutSessions[1].url);
      expect(
        context.mocks.stripe.checkout.sessions.expire,
      ).toHaveBeenCalledWith(checkoutSessions[0].id);
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          line_items: [
            {
              price:
                tier === "pro"
                  ? TEST_PRICE_USAGE_PACK_PLAN_PRO
                  : TEST_PRICE_USAGE_PACK_PLAN_TEAM,
              quantity: 1,
            },
            { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
          ],
        }),
        expect.objectContaining({
          idempotencyKey: expect.stringContaining("usage-pack-checkout:"),
        }),
      );
      const [firstUsagePackSubscriptionId, replacementSubscriptionId] =
        usagePackSubscriptionIds;
      if (!firstUsagePackSubscriptionId || !replacementSubscriptionId) {
        throw new Error("Checkout did not create usage pack subscriptions");
      }
      await expect(
        readOrgAcquisitionAttributionFixture(fixture.orgId),
      ).resolves.toMatchObject({
        acquisitionFirstPartySource: "presentation",
      });
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId: firstUsagePackSubscriptionId,
        deleteGrants: true,
        deleteOrgMetadata: false,
      });
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId: replacementSubscriptionId,
        deleteGrants: true,
        deleteOrgMetadata: true,
      });
    },
  );

  it("keeps only one payable Checkout across concurrent different configurations", async () => {
    const fixture = createOrgFixture();
    const customerId = `cus_${randomUUID()}`;
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
    const sessionStates = mockStatefulUsagePackCheckoutSessions();
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const body = (usagePackUsd: 20 | 50) => {
      return {
        tier: "pro" as const,
        memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd }],
        successUrl: `${APP_ORIGIN}/billing?billing=success`,
        cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
      };
    };

    const responses = await Promise.all([
      accept(
        client.create({
          body: body(20),
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      ),
      accept(
        client.create({
          body: body(50),
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      ),
    ]);

    expect(responses).toHaveLength(2);
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(
      2,
    );
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: expect.arrayContaining([
          { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
        ]),
      }),
      expect.any(Object),
    );
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: expect.arrayContaining([
          { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
        ]),
      }),
      expect.any(Object),
    );
    expect(
      [...sessionStates.values()].filter((status) => {
        return status === "open";
      }),
    ).toHaveLength(1);
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledTimes(
      1,
    );

    for (const [input] of context.mocks.stripe.checkout.sessions.create.mock
      .calls) {
      const usagePackSubscriptionId =
        stripeInputMetadata(input).usagePackSubscriptionId;
      if (!usagePackSubscriptionId) {
        throw new Error("Checkout did not expose a usage pack subscription ID");
      }
      onTestFinished(async () => {
        await usagePackStateAction({
          action: "cleanup",
          orgId: fixture.orgId,
          usagePackSubscriptionId,
          deleteGrants: false,
          deleteOrgMetadata: false,
        });
      });
    }
  });

  it("reconciles competing pre-0954 Checkout Sessions before creating a replacement", async () => {
    const fixture = createOrgFixture();
    const customerId = `cus_${randomUUID()}`;
    await prepareUsagePackCheckoutOrg(fixture, customerId);
    const sessionStates = mockStatefulUsagePackCheckoutSessions();
    const legacySnapshots: {
      readonly sessionId: string;
      readonly subscriptionId: string;
    }[] = [];

    for (const usagePackUsd of [20, 50] as const) {
      const sessionId = `cs_pre_0952_${usagePackUsd}_${randomUUID()}`;
      sessionStates.set(sessionId, "open");
      const seeded = await usagePackStateAction({
        action: "seed",
        orgId: fixture.orgId,
        tier: "pro",
        stripePlanPriceId: TEST_PRICE_USAGE_PACK_PLAN_PRO,
        stripeCustomerId: customerId,
        stripeCheckoutSessionId: sessionId,
        preSerializationCutover: true,
        allocations: [
          {
            userId: `user_pre_0952_${usagePackUsd}_${randomUUID()}`,
            invitationId: null,
            usagePackUsd,
            stripePriceId:
              usagePackUsd === 20
                ? TEST_PRICE_USAGE_PACK_20
                : TEST_PRICE_USAGE_PACK_50,
          },
        ],
      });
      if (seeded.action !== "seeded") {
        throw new Error("Failed to seed a pre-0954 Checkout snapshot");
      }
      legacySnapshots.push({
        sessionId,
        subscriptionId: seeded.usagePackSubscriptionId,
      });
    }

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: {
          tier: "pro",
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 100 }],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//),
    });
    for (const snapshot of legacySnapshots) {
      expect(sessionStates.get(snapshot.sessionId)).toBe("expired");
      expect(
        (await readUsagePackState(fixture.orgId, snapshot.subscriptionId))
          .subscription,
      ).toMatchObject({ subscriptionStatus: "checkout_expired" });
    }
    expect(context.mocks.stripe.checkout.sessions.expire).toHaveBeenCalledTimes(
      2,
    );
    expect(
      [...sessionStates.values()].filter((status) => {
        return status === "open";
      }),
    ).toHaveLength(1);
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(
      1,
    );

    const [createInput] = context.mocks.stripe.checkout.sessions.create.mock
      .calls[0] ?? [undefined];
    const replacementSubscriptionId =
      stripeInputMetadata(createInput).usagePackSubscriptionId;
    if (!replacementSubscriptionId) {
      throw new Error("Replacement Checkout did not expose its snapshot ID");
    }
    onTestFinished(async () => {
      for (const snapshot of legacySnapshots) {
        await usagePackStateAction({
          action: "cleanup",
          orgId: fixture.orgId,
          usagePackSubscriptionId: snapshot.subscriptionId,
          deleteGrants: false,
          deleteOrgMetadata: false,
        });
      }
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId: replacementSubscriptionId,
        deleteGrants: false,
        deleteOrgMetadata: true,
      });
    });
  });

  it("keeps a reused purchase preview snapshot until its latest token expires", async () => {
    const startedAt = new Date("2035-05-15T00:00:00.000Z");
    mockNow(startedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    const fixture = createOrgFixture();
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
    authenticateOrg(fixture);
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
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: null,
      metadata: {},
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const body = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      memberUsagePacks: [
        { memberId: fixture.userId, usagePackUsd: 20 as const },
      ],
      successUrl: `${APP_ORIGIN}/billing?billing=success`,
      cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
    };

    const first = await accept(
      client.create({
        body,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in first.body)) {
      throw new Error("Expected an initial usage pack purchase preview");
    }
    expect(first.body.expiresAt).toBe(
      new Date(startedAt.getTime() + 15 * 60 * 1000).toISOString(),
    );
    const initialState = await readUsagePackState(fixture.orgId);
    const usagePackSubscriptionId = initialState.subscriptionIds[0];
    if (!usagePackSubscriptionId) {
      throw new Error("Usage pack preview did not persist its snapshot");
    }
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId,
        deleteGrants: false,
        deleteOrgMetadata: true,
      });
    });

    mockNow(new Date(startedAt.getTime() + 14 * 60 * 1000));
    await reconcileBillingOrganization(fixture.orgId);
    expect(
      (await readUsagePackState(fixture.orgId, usagePackSubscriptionId))
        .subscription?.subscriptionStatus,
    ).toBe("purchase_pending");

    const reused = await accept(
      client.create({
        body,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in reused.body)) {
      throw new Error("Expected a reused usage pack purchase preview");
    }
    expect(reused.body.expiresAt).toBe(
      new Date(startedAt.getTime() + 29 * 60 * 1000).toISOString(),
    );
    const reusedState = await readUsagePackState(
      fixture.orgId,
      usagePackSubscriptionId,
    );
    expect(reusedState.subscriptionCount).toBe(1);
    expect(reusedState.subscription?.id).toBe(usagePackSubscriptionId);

    mockNow(new Date(startedAt.getTime() + 16 * 60 * 1000));
    await reconcileBillingOrganization(fixture.orgId);
    expect(
      (await readUsagePackState(fixture.orgId, usagePackSubscriptionId))
        .subscription?.subscriptionStatus,
    ).toBe("purchase_pending");

    mockNow(new Date(startedAt.getTime() + 30 * 60 * 1000));
    await reconcileBillingOrganization(fixture.orgId);
    const expired = await readUsagePackState(
      fixture.orgId,
      usagePackSubscriptionId,
    );
    expect(expired.subscription?.subscriptionStatus).toBe("checkout_expired");
    expect(expired.allocations).toStrictEqual([
      expect.objectContaining({ status: "inactive" }),
    ]);
  });

  it("retires a stale purchase snapshot that never received a Checkout Session", async () => {
    const reconciledAt = new Date("2035-05-15T00:00:00.000Z");
    mockNow(reconciledAt);
    onTestFinished(() => {
      clearMockNow();
    });
    const fixture = createOrgFixture();
    const customerId = `cus_${randomUUID()}`;
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "limited-free-1",
      credits: 0,
    });
    const seeded = await usagePackStateAction({
      action: "seed",
      orgId: fixture.orgId,
      tier: "pro",
      stripePlanPriceId: TEST_PRICE_USAGE_PACK_PLAN_PRO,
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: null,
      allocations: [
        {
          userId: fixture.userId,
          invitationId: null,
          usagePackUsd: 20,
          stripePriceId: TEST_PRICE_USAGE_PACK_20,
        },
      ],
    });
    if (seeded.action !== "seeded") {
      throw new Error("Failed to seed a stale usage pack snapshot");
    }
    const usagePackSubscriptionId = seeded.usagePackSubscriptionId;
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId,
        deleteGrants: false,
        deleteOrgMetadata: true,
      });
    });
    await usagePackStateAction({
      action: "set-updated-at",
      orgId: fixture.orgId,
      usagePackSubscriptionId,
      updatedAt: new Date(
        reconciledAt.getTime() - 16 * 60 * 1000,
      ).toISOString(),
    });

    await reconcileBillingOrganization(fixture.orgId);

    const state = await readUsagePackState(
      fixture.orgId,
      usagePackSubscriptionId,
    );
    expect(state.subscription).toMatchObject({
      stripeCheckoutSessionId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: "checkout_expired",
    });
    expect(state.allocations).toStrictEqual([
      expect.objectContaining({ status: "inactive" }),
    ]);
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).not.toHaveBeenCalled();
  });

  it("rechecks a stale snapshot after waiting for a concurrent Checkout writer", async () => {
    const reconciledAt = new Date("2035-05-15T00:00:00.000Z");
    mockNow(reconciledAt);
    onTestFinished(() => {
      clearMockNow();
    });
    const fixture = createOrgFixture();
    const customerId = `cus_${randomUUID()}`;
    const checkoutSessionId = `cs_${randomUUID()}`;
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "limited-free-1",
      credits: 0,
    });
    const seeded = await usagePackStateAction({
      action: "seed",
      orgId: fixture.orgId,
      tier: "pro",
      stripePlanPriceId: TEST_PRICE_USAGE_PACK_PLAN_PRO,
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: null,
      allocations: [
        {
          userId: fixture.userId,
          invitationId: null,
          usagePackUsd: 20,
          stripePriceId: TEST_PRICE_USAGE_PACK_20,
        },
      ],
    });
    if (seeded.action !== "seeded") {
      throw new Error("Failed to seed a racing usage pack snapshot");
    }
    const usagePackSubscriptionId = seeded.usagePackSubscriptionId;
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId,
        deleteGrants: false,
        deleteOrgMetadata: true,
      });
    });
    await usagePackStateAction({
      action: "set-updated-at",
      orgId: fixture.orgId,
      usagePackSubscriptionId,
      updatedAt: new Date(
        reconciledAt.getTime() - 16 * 60 * 1000,
      ).toISOString(),
    });

    const reconciliationPromises: Promise<void>[] = [];
    const holdPromise = usagePackStateAction({
      action: "hold-billing-purchase-lock",
      orgId: fixture.orgId,
      usagePackSubscriptionId,
      stripeCheckoutSessionId: checkoutSessionId,
      updatedAt: reconciledAt.toISOString(),
    });
    onTestFinished(async () => {
      const lockState = await usagePackStateAction({
        action: "read-billing-purchase-lock-state",
        orgId: fixture.orgId,
      });
      if (
        lockState.action === "billing-purchase-lock-state" &&
        lockState.held
      ) {
        await usagePackStateAction({
          action: "release-billing-purchase-lock",
          orgId: fixture.orgId,
        });
      }
      await Promise.allSettled([holdPromise]);
      await Promise.allSettled(reconciliationPromises);
    });
    await expect
      .poll(
        async () => {
          const state = await usagePackStateAction({
            action: "read-billing-purchase-lock-state",
            orgId: fixture.orgId,
          });
          return state.action === "billing-purchase-lock-state" && state.held;
        },
        { timeout: 5000, interval: 20 },
      )
      .toBeTruthy();

    const reconciliationPromise = reconcileBillingOrganization(fixture.orgId);
    reconciliationPromises.push(reconciliationPromise);
    await expect
      .poll(
        async () => {
          const state = await usagePackStateAction({
            action: "read-billing-purchase-lock-state",
            orgId: fixture.orgId,
          });
          return state.action === "billing-purchase-lock-state"
            ? state.waiterCount
            : 0;
        },
        { timeout: 5000, interval: 20 },
      )
      .toBeGreaterThanOrEqual(1);

    await usagePackStateAction({
      action: "release-billing-purchase-lock",
      orgId: fixture.orgId,
    });
    await holdPromise;
    await reconciliationPromise;

    const state = await readUsagePackState(
      fixture.orgId,
      usagePackSubscriptionId,
    );
    expect(state.subscription).toMatchObject({
      stripeCheckoutSessionId: checkoutSessionId,
      stripeSubscriptionId: null,
      subscriptionStatus: "checkout_pending",
    });
    expect(state.allocations).toStrictEqual([
      expect.objectContaining({ status: "pending_payment" }),
    ]);
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).not.toHaveBeenCalled();
  });

  it("commits Checkout correlation before honoring an abort from Session creation", async () => {
    const startedAt = new Date("2035-05-15T00:00:00.000Z");
    mockNow(startedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    const fixture = createOrgFixture();
    const customerId = `cus_${randomUUID()}`;
    const checkoutSessionId = `cs_${randomUUID()}`;
    const checkoutUrl = "https://checkout.stripe.test/aborted-usage-pack";
    authenticateOrg(fixture);
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
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    const controller = new AbortController();
    const abortError = new Error("API owner cancelled usage pack checkout");
    abortError.name = "AbortError";
    const ownerContext = {
      mocks: context.mocks,
      sessionHistoryBlobs: context.sessionHistoryBlobs,
      signal: controller.signal,
    };
    let usagePackSubscriptionId: string | null = null;
    context.mocks.stripe.checkout.sessions.create.mockImplementation(
      (input) => {
        usagePackSubscriptionId =
          stripeInputMetadata(input).usagePackSubscriptionId ?? null;
        controller.abort(abortError);
        return Promise.resolve({ id: checkoutSessionId, url: checkoutUrl });
      },
    );

    const response = await setupApp({
      context: ownerContext,
      routes: billingCheckoutRoutes,
    })(billingUsagePackCheckoutContract).create({
      body: {
        tier: "pro",
        memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
        successUrl: `${APP_ORIGIN}/billing?billing=success`,
        cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
      },
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(500);
    if (!usagePackSubscriptionId) {
      throw new Error("Aborted Checkout did not expose its snapshot ID");
    }
    const persistedUsagePackSubscriptionId = usagePackSubscriptionId;
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId: persistedUsagePackSubscriptionId,
        deleteGrants: false,
        deleteOrgMetadata: true,
      });
    });
    const correlated = await readUsagePackState(
      fixture.orgId,
      persistedUsagePackSubscriptionId,
    );
    expect(correlated.subscription).toMatchObject({
      stripeCheckoutSessionId: checkoutSessionId,
      stripeSubscriptionId: null,
      subscriptionStatus: "checkout_pending",
    });
    expect(
      context.mocks.stripe.checkout.sessions.expire,
    ).not.toHaveBeenCalled();

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: checkoutSessionId,
      status: "open",
      url: checkoutUrl,
    });
    mockNow(new Date(startedAt.getTime() + 16 * 60 * 1000));
    await reconcileBillingOrganization(fixture.orgId);
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).toHaveBeenCalledWith(checkoutSessionId);
    expect(
      (
        await readUsagePackState(
          fixture.orgId,
          persistedUsagePackSubscriptionId,
        )
      ).subscription?.subscriptionStatus,
    ).toBe("checkout_pending");
  });

  it("rejects a usage pack preview after a replacement retires its snapshot", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
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
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: null,
      metadata: {},
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const purchaseBody = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      memberUsagePacks: [
        { memberId: fixture.userId, usagePackUsd: 20 as const },
      ],
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
    await accept(
      client.create({
        body: {
          ...purchaseBody,
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 50 }],
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in firstPreview.body)) {
      throw new Error("Expected a usage pack purchase preview");
    }

    const confirmation = await accept(
      client.confirm({
        body: { previewToken: firstPreview.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(confirmation.body).toStrictEqual({
      error: {
        message: "Usage pack purchase preview is no longer valid",
        code: "CONFLICT",
      },
    });
    expect(context.mocks.stripe.subscriptions.create).not.toHaveBeenCalled();
  });

  it("attempts the saved card for an open usage pack invoice", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
    const subscriptionId = `sub_${randomUUID()}`;
    const hostedInvoiceUrl =
      "https://invoice.stripe.com/usage-pack-authentication";
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
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: null,
      metadata: {},
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    const operationInvoice = {
      id: `in_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: "open" as const,
      metadata: {},
      hosted_invoice_url: hostedInvoiceUrl,
      lines: { has_more: false, data: [] },
      parent: null,
    };
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.create.mockResolvedValue({
      id: subscriptionId,
      customer: customerId,
      status: "incomplete",
      metadata: {},
      items: {
        data: [
          { price: { id: TEST_PRICE_USAGE_PACK_PLAN_PRO } },
          { price: { id: TEST_PRICE_USAGE_PACK_20 } },
        ],
      },
      latest_invoice: operationInvoice,
    });
    context.mocks.stripe.invoices.pay.mockRejectedValue(
      new Error("Payment requires customer authentication"),
    );
    context.mocks.stripe.invoices.retrieve.mockResolvedValue(operationInvoice);

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const start = await accept(
      client.create({
        body: {
          tier: "pro",
          supportsInAppPreview: true,
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (!("previewToken" in start.body)) {
      throw new Error("Expected a usage pack purchase preview");
    }

    const confirmation = await accept(
      client.confirm({
        body: { previewToken: start.body.previewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      operationInvoice.id,
      {},
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          "billing-operation:usage-pack:",
        ),
      }),
    );
  });

  it("reuses a pending usage pack preview and creates one subscription", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
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
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: null,
      metadata: {},
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    let createdSubscription:
      | {
          readonly id: string;
          readonly customer: string;
          readonly status: string;
          readonly metadata: Readonly<Record<string, string>>;
          readonly items: {
            readonly data: readonly {
              readonly price: { readonly id: string };
            }[];
          };
        }
      | undefined;
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.create.mockImplementation((input) => {
      createdSubscription = {
        id: `sub_${randomUUID()}`,
        customer: customerId,
        status: "active",
        metadata: stripeInputMetadata(input),
        items: {
          data: [
            { price: { id: TEST_PRICE_USAGE_PACK_PLAN_PRO } },
            { price: { id: TEST_PRICE_USAGE_PACK_20 } },
          ],
        },
      };
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [createdSubscription],
        has_more: false,
      });
      return Promise.resolve({
        ...createdSubscription,
        latest_invoice: null,
      });
    });
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (subscriptionId) => {
        if (!createdSubscription || subscriptionId !== createdSubscription.id) {
          throw new Error("Expected the created usage pack subscription");
        }
        return Promise.resolve({
          ...createdSubscription,
          latest_invoice: null,
        });
      },
    );

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const purchaseBody = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      memberUsagePacks: [
        { memberId: fixture.userId, usagePackUsd: 20 as const },
      ],
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
    if (
      !("previewToken" in firstPreview.body) ||
      !("previewToken" in secondPreview.body)
    ) {
      throw new Error("Expected two usage pack purchase previews");
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
    ).toStrictEqual([200, 200]);
    expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: customerId,
        default_payment_method: paymentMethodId,
      }),
      expect.any(Object),
    );
  });

  it("reuses an open Checkout when repeated usage pack previews lose their saved card", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    const customerId = `cus_${randomUUID()}`;
    const paymentMethodId = `pm_${randomUUID()}`;
    const checkoutSessionId = `cs_${randomUUID()}`;
    const checkoutUrl = "https://checkout.stripe.com/session/usage-pack-retry";
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
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    let customerRetrievalCount = 0;
    context.mocks.stripe.customers.retrieve.mockImplementation(() => {
      customerRetrievalCount += 1;
      return Promise.resolve({
        id: customerId,
        invoice_settings: {
          default_payment_method:
            customerRetrievalCount <= 2 ? paymentMethodId : null,
        },
        default_source: null,
      });
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      id: `in_preview_${randomUUID()}`,
      customer: customerId,
      amount_due: 4000,
      currency: "usd",
      status: null,
      metadata: {},
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: checkoutSessionId,
      url: checkoutUrl,
    });
    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: checkoutSessionId,
      status: "open",
      url: checkoutUrl,
    });

    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    );
    const firstBody = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      memberUsagePacks: [
        { memberId: fixture.userId, usagePackUsd: 20 as const },
      ],
      successUrl: `${APP_ORIGIN}/billing?billing=first-success`,
      cancelUrl: `${APP_ORIGIN}/billing?billing=first-canceled`,
    };
    const secondBody = {
      ...firstBody,
      successUrl: `${APP_ORIGIN}/settings?billing=second-success`,
      cancelUrl: `${APP_ORIGIN}/settings?billing=second-canceled`,
    };
    const firstPreview = await accept(
      client.create({
        body: firstBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const secondPreview = await accept(
      client.create({
        body: secondBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    if (
      !("previewToken" in firstPreview.body) ||
      !("previewToken" in secondPreview.body)
    ) {
      throw new Error("Expected two usage pack purchase previews");
    }

    const firstConfirmation = await accept(
      client.create({
        body: {
          ...firstBody,
          previewToken: firstPreview.body.previewToken,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const secondConfirmation = await accept(
      client.create({
        body: {
          ...secondBody,
          previewToken: secondPreview.body.previewToken,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const repeatedPurchase = await accept(
      client.create({
        body: secondBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(firstConfirmation.body).toStrictEqual({
      status: "checkout_required",
      checkoutUrl,
    });
    expect(secondConfirmation.body).toStrictEqual(firstConfirmation.body);
    expect(repeatedPurchase.body).toStrictEqual({ url: checkoutUrl });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(
      1,
    );
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).toHaveBeenCalledTimes(2);
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).toHaveBeenCalledWith(checkoutSessionId);
  });

  it("rejects stale member selections before creating checkout", async () => {
    const fixture = createOrgFixture();
    authenticateOrg(fixture);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: fixture.userId },
            createdAt: now(),
          },
          {
            role: "org:member",
            publicUserData: { userId: `user_${randomUUID()}` },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: {
          tier: "pro",
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Organization members changed; refresh billing and try again",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });
});

describe("legacy subscription usage pack migration", () => {
  interface LegacyMigrationFixture extends SubscriptionFixture {
    readonly tier: "pro" | "team";
    readonly legacyPriceId: string;
    readonly legacyItemId: string;
    readonly period: { readonly start: number; readonly end: number };
    readonly legacyCreditInvoiceId: string;
    readonly invitation?: {
      readonly id: string;
      readonly email: string;
      readonly role: "org:admin" | "org:member";
    };
  }

  interface MigrationStripeController {
    readonly discountId: string | null;
    readonly scheduleId: string;
    readonly invoice: () => object;
    readonly cancelSubscription: () => MigrationSubscriptionMock;
    readonly cancelSchedule: () => void;
    readonly startScheduledPhase: () => void;
  }

  interface MigrationSubscriptionMock {
    readonly id: string;
    readonly customer: string;
    readonly status: string;
    readonly cancel_at: number | null;
    readonly cancel_at_period_end: boolean;
    readonly schedule: string | null;
    readonly pending_update: null;
    readonly latest_invoice: string | null;
    readonly metadata: Readonly<Record<string, string>>;
    readonly discounts: readonly string[];
    readonly items: {
      readonly data: readonly {
        readonly id: string;
        readonly price: {
          readonly id: string;
          readonly recurring: {
            readonly interval: "month";
            readonly interval_count: 1;
          };
        };
        readonly quantity: number;
        readonly current_period_start: number;
        readonly current_period_end: number;
      }[];
    };
  }

  function isStringRecord(
    value: unknown,
  ): value is Readonly<Record<string, string>> {
    return (
      typeof value === "object" &&
      value !== null &&
      Object.values(value).every((entry) => {
        return typeof entry === "string";
      })
    );
  }

  function stringMetadata(
    value: unknown,
  ): Readonly<Record<string, string>> | null {
    if (typeof value !== "object" || value === null || !("metadata" in value)) {
      return null;
    }
    return isStringRecord(value.metadata) ? value.metadata : null;
  }

  function migrationPreviewItems(value: unknown): readonly unknown[] {
    if (typeof value !== "object" || value === null) {
      throw new Error("Expected migration preview details");
    }
    if ("subscription_details" in value) {
      const details = value.subscription_details;
      if (
        typeof details === "object" &&
        details !== null &&
        "items" in details &&
        Array.isArray(details.items)
      ) {
        return details.items;
      }
    }
    if ("schedule_details" in value) {
      const details = value.schedule_details;
      if (
        typeof details === "object" &&
        details !== null &&
        "phases" in details &&
        Array.isArray(details.phases)
      ) {
        const phase: unknown = details.phases.at(-1);
        if (
          typeof phase === "object" &&
          phase !== null &&
          "items" in phase &&
          Array.isArray(phase.items)
        ) {
          return phase.items;
        }
      }
    }
    throw new Error("Expected migration preview items");
  }

  function migrationPreviewPriceIds(value: unknown): readonly string[] {
    return migrationPreviewItems(value).flatMap((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("price" in item) ||
        typeof item.price !== "string"
      ) {
        return [];
      }
      return [item.price];
    });
  }

  function migrationRecurringPreviewInvoice(
    value: unknown,
    effectiveAt: number,
    amountDue: number,
    discountAmount = 0,
  ): object {
    const items = migrationPreviewItems(value).flatMap((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("price" in item) ||
        typeof item.price !== "string"
      ) {
        return [];
      }
      const quantity =
        "quantity" in item && typeof item.quantity === "number"
          ? item.quantity
          : 1;
      return [{ price: item.price, quantity }];
    });
    const scheduled =
      typeof value === "object" &&
      value !== null &&
      "schedule_details" in value;
    const firstItem = items.at(0);
    const noiseLines =
      scheduled && firstItem
        ? [
            {
              id: "il_migration_pending_item",
              amount: 9000,
              quantity: firstItem.quantity,
              pricing: { price_details: { price: firstItem.price } },
              taxes: [],
              period: {
                start: effectiveAt,
                end: effectiveAt + 30 * 86_400,
              },
              parent: {
                type: "invoice_item_details",
                invoice_item_details: { proration: false },
              },
            },
            {
              id: "il_migration_proration",
              amount: 8000,
              quantity: firstItem.quantity,
              pricing: { price_details: { price: firstItem.price } },
              taxes: [],
              period: {
                start: effectiveAt,
                end: effectiveAt + 30 * 86_400,
              },
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: true },
              },
            },
            {
              id: "il_migration_current_phase",
              amount: 7000,
              quantity: firstItem.quantity,
              pricing: { price_details: { price: firstItem.price } },
              taxes: [],
              period: {
                start: effectiveAt - 30 * 86_400,
                end: effectiveAt,
              },
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: false },
              },
            },
            {
              id: "il_migration_unrelated",
              amount: 6000,
              quantity: 1,
              pricing: {
                price_details: { price: "price_unrelated_preview_item" },
              },
              taxes: [],
              period: {
                start: effectiveAt,
                end: effectiveAt + 30 * 86_400,
              },
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: false },
              },
            },
          ]
        : [];
    const noiseAmount = noiseLines.reduce((total, line) => {
      return total + line.amount;
    }, 0);
    return {
      id: `in_migration_preview_${randomUUID()}`,
      amount_due: amountDue + noiseAmount,
      currency: "usd",
      lines: {
        has_more: false,
        data: [
          ...noiseLines,
          ...items.map((item, index) => {
            const exclusiveTaxAmount = index === 0 && scheduled ? 100 : 0;
            const appliedDiscountAmount = index === 0 ? discountAmount : 0;
            return {
              id: `il_migration_preview_${index}`,
              amount:
                index === 0
                  ? amountDue - exclusiveTaxAmount + appliedDiscountAmount
                  : 0,
              discount_amounts:
                appliedDiscountAmount > 0
                  ? [{ amount: appliedDiscountAmount }]
                  : [],
              quantity: item.quantity,
              pricing: { price_details: { price: item.price } },
              taxes:
                exclusiveTaxAmount > 0
                  ? [
                      {
                        amount: exclusiveTaxAmount,
                        tax_behavior: "exclusive",
                      },
                    ]
                  : [],
              period: {
                start: effectiveAt,
                end: effectiveAt + 30 * 86_400,
              },
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: false },
              },
            };
          }),
        ],
      },
    };
  }

  function paidMigrationTimestamp(): number | null {
    return currentSecond();
  }

  async function clearMigrationFixture(
    orgId = TEST_STAFF_ORG_ID,
  ): Promise<void> {
    await usagePackStateAction({
      action: "cleanup-migration",
      orgId,
    });
  }

  async function seedLegacyMigrationFixture(args: {
    readonly tier: "pro" | "team";
    readonly invitation?: boolean;
    readonly orgId?: string;
  }): Promise<LegacyMigrationFixture> {
    const orgId = args.orgId ?? TEST_STAFF_ORG_ID;
    await clearMigrationFixture(orgId);
    const fixture = createOrgFixture(orgId);
    const customerId = `cus_migration_${randomUUID()}`;
    const subscriptionId = `sub_migration_${randomUUID()}`;
    const legacyPriceId =
      args.tier === "team" ? TEST_PRICE_TEAM : TEST_PRICE_PRO;
    const legacyItemId = `si_legacy_${randomUUID()}`;
    const period = {
      start: currentSecond() - 15 * 86_400,
      end: currentSecond() + 15 * 86_400,
    };
    const legacyCreditInvoiceId = `in_legacy_${randomUUID()}`;
    const invitation = args.invitation
      ? {
          id: `inv_migration_${randomUUID()}`,
          email: `pending-${randomUUID()}@example.test`,
          role: "org:member" as const,
        }
      : undefined;
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: args.tier,
      credits: 12_345,
    });
    await usagePackStateAction({
      action: "seed-legacy-migration",
      orgId: fixture.orgId,
      tier: args.tier,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      currentPeriodEnd: new Date(period.end * 1000).toISOString(),
      legacyCreditInvoiceId,
      credits: 12_345,
    });
    authenticateOrg(fixture);
    mockClerkOrganization(fixture);
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
      {
        data: invitation
          ? [
              {
                id: invitation.id,
                emailAddress: invitation.email,
                role: invitation.role,
                createdAt: now(),
              },
            ]
          : [],
      },
    );
    onTestFinished(() => {
      return clearMigrationFixture(orgId);
    });
    return {
      ...fixture,
      customerId,
      subscriptionId,
      tier: args.tier,
      legacyPriceId,
      legacyItemId,
      period,
      legacyCreditInvoiceId,
      ...(invitation ? { invitation } : {}),
    };
  }

  function legacyMigrationSubscription(
    fixture: LegacyMigrationFixture,
    discounts: readonly string[] = [],
  ): MigrationSubscriptionMock {
    return {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      pending_update: null,
      latest_invoice: null,
      metadata: { orgId: fixture.orgId },
      discounts,
      items: {
        data: [
          {
            id: fixture.legacyItemId,
            price: {
              id: fixture.legacyPriceId,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 1,
            current_period_start: fixture.period.start,
            current_period_end: fixture.period.end,
          },
        ],
      },
    };
  }

  function mockMigrationStripe(args: {
    readonly fixture: LegacyMigrationFixture;
    readonly targetTier?: "pro" | "team";
    readonly packageQuantity: number;
    readonly currentRecurringAmountCents: number;
    readonly amountDueCents: number;
    readonly amountPaidCents: number;
    readonly discountAmountCents?: number;
  }): MigrationStripeController {
    const targetTier = args.targetTier ?? args.fixture.tier;
    const planPriceId =
      targetTier === "team"
        ? TEST_PRICE_USAGE_PACK_PLAN_TEAM
        : TEST_PRICE_USAGE_PACK_PLAN_PRO;
    const invoiceId = `in_migration_${randomUUID()}`;
    const paymentIntentId = `pi_migration_${randomUUID()}`;
    const scheduleId = `sub_sched_migration_${randomUUID()}`;
    const discountId = args.discountAmountCents
      ? `di_migration_${randomUUID()}`
      : null;
    const discounts = discountId ? [discountId] : [];
    const packageLineAmount = 2000 * args.packageQuantity;
    const renewedPeriod = {
      start: args.fixture.period.end,
      end: args.fixture.period.end + 30 * 86_400,
    };
    const paidInvoice = () => {
      return {
        id: invoiceId,
        customer: args.fixture.customerId,
        metadata: { orgId: args.fixture.orgId },
        status: "paid",
        paid: true,
        amount_due: args.amountDueCents,
        amount_paid: args.amountPaidCents,
        currency: "usd",
        hosted_invoice_url: `https://invoice.stripe.test/${invoiceId}`,
        status_transitions: { paid_at: paidMigrationTimestamp() },
        payments: {
          data:
            args.amountPaidCents > 0
              ? [
                  {
                    status: "paid",
                    amount_paid: args.amountPaidCents,
                    payment: {
                      type: "payment_intent",
                      payment_intent: paymentIntentId,
                    },
                  },
                ]
              : [],
        },
        parent: {
          subscription_details: {
            subscription: args.fixture.subscriptionId,
            metadata: { orgId: args.fixture.orgId },
          },
        },
        lines: {
          data: [
            {
              id: `il_migration_plan_${randomUUID()}`,
              amount: Math.max(args.amountDueCents - packageLineAmount, 0),
              subtotal: Math.max(args.amountDueCents - packageLineAmount, 0),
              quantity: 1,
              price: { id: planPriceId },
              pricing: { price_details: { price: planPriceId } },
              proration: false,
              period: renewedPeriod,
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: false },
              },
            },
            {
              id: `il_migration_${randomUUID()}`,
              amount: packageLineAmount,
              subtotal: packageLineAmount,
              quantity: args.packageQuantity,
              price: { id: TEST_PRICE_USAGE_PACK_20 },
              pricing: {
                price_details: { price: TEST_PRICE_USAGE_PACK_20 },
              },
              proration: false,
              period: renewedPeriod,
              parent: {
                type: "subscription_item_details",
                subscription_item_details: { proration: false },
              },
            },
          ].filter((item) => {
            return item.quantity > 0;
          }),
        },
      };
    };
    const openInvoice = () => {
      return {
        ...paidInvoice(),
        status: "open",
        paid: false,
        amount_paid: 0,
        status_transitions: { paid_at: null },
        payments: { data: [] },
      };
    };
    const appliedSubscription = (): MigrationSubscriptionMock => {
      return {
        ...legacyMigrationSubscription(args.fixture, discounts),
        schedule: scheduleId,
        latest_invoice: invoiceId,
        items: {
          data: [
            {
              id: `si_plan_${targetTier}`,
              price: {
                id: planPriceId,
                recurring: {
                  interval: "month" as const,
                  interval_count: 1 as const,
                },
              },
              quantity: 1,
              current_period_start: renewedPeriod.start,
              current_period_end: renewedPeriod.end,
            },
            {
              id: "si_pack_20",
              price: {
                id: TEST_PRICE_USAGE_PACK_20,
                recurring: {
                  interval: "month" as const,
                  interval_count: 1 as const,
                },
              },
              quantity: args.packageQuantity,
              current_period_start: renewedPeriod.start,
              current_period_end: renewedPeriod.end,
            },
          ].filter((item) => {
            return item.quantity > 0;
          }),
        },
      };
    };
    let invoice = paidInvoice();
    let subscription: MigrationSubscriptionMock = legacyMigrationSubscription(
      args.fixture,
      discounts,
    );
    const syncRetrievalMocks = () => {
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription,
      );
      context.mocks.stripe.invoices.retrieve.mockResolvedValue(invoice);
    };
    syncRetrievalMocks();
    context.mocks.stripe.invoices.createPreview.mockImplementation((params) => {
      if (
        subscription.schedule &&
        typeof params === "object" &&
        params !== null &&
        "subscription_details" in params
      ) {
        throw new Error(
          "Scheduled migration previews must use schedule details",
        );
      }
      const targetPreview = migrationPreviewItems(params).some((item) => {
        return (
          typeof item === "object" &&
          item !== null &&
          "price" in item &&
          item.price === planPriceId
        );
      });
      const amountDue = targetPreview
        ? args.amountDueCents
        : args.currentRecurringAmountCents;
      return Promise.resolve(
        migrationRecurringPreviewInvoice(
          params,
          args.fixture.period.end,
          amountDue,
          args.discountAmountCents,
        ),
      );
    });
    context.mocks.stripe.subscriptionSchedules.create.mockImplementation(() => {
      subscription = { ...subscription, schedule: scheduleId };
      syncRetrievalMocks();
      return Promise.resolve({ id: scheduleId, phases: [] });
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
      phases: [],
    });
    context.mocks.stripe.subscriptions.update.mockImplementation(
      (_subscriptionId, params) => {
        const metadata = stringMetadata(params);
        if (metadata) {
          subscription = {
            ...subscription,
            metadata: {
              ...subscription.metadata,
              ...metadata,
            },
          };
          syncRetrievalMocks();
          return Promise.resolve(subscription);
        }
        throw new Error(
          "Migration must not replace subscription items directly",
        );
      },
    );
    return {
      discountId,
      scheduleId,
      invoice: () => {
        return invoice;
      },
      cancelSubscription: () => {
        subscription = {
          ...subscription,
          cancel_at: args.fixture.period.end,
          cancel_at_period_end: true,
        };
        syncRetrievalMocks();
        return subscription;
      },
      startScheduledPhase: () => {
        invoice = paidInvoice();
        subscription = appliedSubscription();
        syncRetrievalMocks();
      },
      cancelSchedule: () => {
        invoice = { ...openInvoice(), status: "void" };
        subscription = legacyMigrationSubscription(args.fixture, discounts);
        syncRetrievalMocks();
      },
    };
  }

  function migrationClient() {
    return setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackMigrationContract,
    );
  }

  async function postMigrationInvoice(invoice: object): Promise<void> {
    const event = {
      id: `evt_migration_${randomUUID()}`,
      type: "invoice.paid",
      created: currentSecond(),
      data: { object: invoice },
    };
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=migration-test" },
      }),
      [200],
    );
  }

  async function postMigrationSubscription(
    subscription: object,
  ): Promise<void> {
    const event = {
      id: `evt_migration_${randomUUID()}`,
      type: "customer.subscription.updated",
      created: currentSecond(),
      data: { object: subscription },
    };
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=migration-test" },
      }),
      [200],
    );
  }

  async function postMigrationInvitationAccepted(args: {
    readonly fixture: LegacyMigrationFixture;
    readonly purchaseId: string;
    readonly userId: string;
  }): Promise<void> {
    if (!args.fixture.invitation) {
      throw new Error("Expected a pending invitation fixture");
    }
    const event = {
      type: "organizationInvitation.accepted",
      data: {
        object: "organization_invitation",
        id: args.fixture.invitation.id,
        email_address: args.fixture.invitation.email,
        organization_id: args.fixture.orgId,
        role: args.fixture.invitation.role,
        role_name: "Member",
        status: "accepted",
        user_id: args.userId,
        public_metadata: {},
        private_metadata: {
          usagePackInvitationPurchaseId: args.purchaseId,
        },
        url: null,
        created_at: now() - 1000,
        updated_at: now(),
        expires_at: args.fixture.period.end * 1000,
      },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify(event),
      }),
      [200],
    );
    await flushWaitUntilForTest();
  }

  async function previewMigration(
    fixture: LegacyMigrationFixture,
    targetTier: "pro" | "team" = fixture.tier,
  ): Promise<{ readonly migrationId: string }> {
    const memberUsagePacks = [
      { memberId: fixture.userId, usagePackUsd: 20 as const },
      ...(fixture.invitation
        ? [{ memberId: fixture.invitation.id, usagePackUsd: 20 as const }]
        : []),
    ];
    const response = await accept(
      migrationClient().preview({
        headers: { authorization: "Bearer clerk-session" },
        body: { targetTier, memberUsagePacks },
      }),
      [200],
    );
    expect(response.body).toMatchObject({
      tier: fixture.tier,
      targetTier,
      currency: "usd",
      purchasedCredits: 20_000 * memberUsagePacks.length,
      bonusCredits: 400 * memberUsagePacks.length,
      totalCredits: 20_400 * memberUsagePacks.length,
    });
    return { migrationId: response.body.migrationId };
  }

  beforeEach(() => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    setTierPrices();
    setUsagePackPrices();
    mockUsagePackCatalog();
    mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
  });

  it("rejects a Stripe subscription scheduled for cancellation", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...legacyMigrationSubscription(fixture),
      cancel_at_period_end: true,
    });

    const response = await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe(
      "Legacy subscription migration is not available",
    );
  });

  it("prevents an active legacy subscription from bypassing migration", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        body: {
          tier: "team",
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "Existing subscriptions must migrate before starting usage pack checkout",
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("keeps legacy state when the legacy item changes after preview", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    mockMigrationStripe({
      fixture,
      packageQuantity: 1,
      currentRecurringAmountCents: 2000,
      amountDueCents: 2000,
      amountPaidCents: 2000,
    });
    const preview = await previewMigration(fixture);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...legacyMigrationSubscription(fixture),
      items: {
        data: [
          {
            ...legacyMigrationSubscription(fixture).items.data[0],
            quantity: 2,
          },
        ],
      },
    });

    const response = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body.error.message).toBe(
      "Usage pack migration is no longer available",
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    const persisted = await readUsagePackState(fixture.orgId);
    expect(persisted.migrations).toStrictEqual([
      expect.objectContaining({
        id: preview.migrationId,
        status: "failed",
        failureReason: "subscription_changed",
      }),
    ]);
    expect(persisted.subscriptionCount).toBe(0);
  });

  it("preserves negative legacy credits when the first usage pack migration invoice is paid", async () => {
    const fixture = await seedLegacyMigrationFixture({
      tier: "pro",
      orgId: `org_migration_debt_${randomUUID()}`,
    });
    const stripe = mockMigrationStripe({
      fixture,
      packageQuantity: 1,
      currentRecurringAmountCents: 2000,
      amountDueCents: 4000,
      amountPaidCents: 4000,
    });
    const preview = await previewMigration(fixture);
    await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "pro",
      credits: -5000,
    });

    stripe.startScheduledPhase();
    await postMigrationInvoice(stripe.invoice());

    const state = await readUsagePackState(fixture.orgId, preview.migrationId);
    expect(state.org).toMatchObject({ tier: "pro", credits: -5000 });
    expect(state.migrations).toContainEqual(
      expect.objectContaining({ id: preview.migrationId, status: "completed" }),
    );
    expect(state.grants).toHaveLength(2);
  });

  it.each(["pro", "team"] as const)(
    "migrates a legacy %s subscription with every member on Free",
    async (tier) => {
      const fixture = await seedLegacyMigrationFixture({
        tier,
        invitation: true,
      });
      if (!fixture.invitation) {
        throw new Error("Expected a pending invitation fixture");
      }
      const amountCents = tier === "team" ? 16_000 : 0;
      const stripe = mockMigrationStripe({
        fixture,
        packageQuantity: 0,
        currentRecurringAmountCents: 20_000,
        amountDueCents: amountCents,
        amountPaidCents: amountCents,
      });
      const preview = await accept(
        migrationClient().preview({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            targetTier: tier,
            memberUsagePacks: [
              { memberId: fixture.userId, usagePackUsd: 0 },
              { memberId: fixture.invitation.id, usagePackUsd: 0 },
            ],
          },
        }),
        [200],
      );
      expect(preview.body).toMatchObject({
        nextRecurringAmountCents: amountCents,
        purchasedCredits: 0,
        bonusCredits: 0,
        totalCredits: 0,
      });
      const confirmation = await accept(
        migrationClient().confirm({
          params: { migrationId: preview.body.migrationId },
          body: {},
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(confirmation.body.status).toBe("scheduled");
      const legacyState = await accept(
        migrationClient().get({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(legacyState.body).not.toHaveProperty("configuration");
      const scheduled = await accept(
        migrationClient().get({
          query: { supportsFreeMembers: "true" },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(scheduled.body).toMatchObject({
        status: "scheduled",
        configuration: {
          memberUsagePacks: [],
          recurringAmountCents: amountCents,
        },
      });
      stripe.startScheduledPhase();
      await postMigrationInvoice(stripe.invoice());
      await postMigrationInvoice(stripe.invoice());
      const state = await readUsagePackState(
        fixture.orgId,
        preview.body.migrationId,
      );
      expect(state.subscription?.subscriptionStatus).toBe("active");
      expect(state.migrations).toContainEqual(
        expect.objectContaining({ status: "completed" }),
      );
      expect(state.allocations).toStrictEqual([]);
      expect(state.grants).toStrictEqual([]);
      expect(state.invitationPurchases).toStrictEqual([]);
      expect(state.org?.tier).toBe(tier);
      expect(state.legacyCredits).toContainEqual(
        expect.objectContaining({ remaining: 12_345 }),
      );
    },
  );

  it("schedules a legacy Pro-to-Team conversion at the billing boundary", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    const stripe = mockMigrationStripe({
      fixture,
      targetTier: "team",
      packageQuantity: 1,
      currentRecurringAmountCents: 2000,
      amountDueCents: 18_000,
      amountPaidCents: 18_000,
    });
    const state = await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(state.body).toMatchObject({ tier: "pro", status: "eligible" });
    const preview = await previewMigration(fixture, "team");

    const confirmation = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmation.body).toMatchObject({
      status: "scheduled",
      effectiveAt: new Date(fixture.period.end * 1000).toISOString(),
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledWith(
      { from_subscription: fixture.subscriptionId },
      {
        idempotencyKey: `usage-pack-migration:${preview.migrationId}:schedule-create`,
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          expect.objectContaining({
            start_date: fixture.period.start,
            end_date: fixture.period.end,
            items: [{ price: fixture.legacyPriceId, quantity: 1 }],
          }),
          expect.objectContaining({
            start_date: fixture.period.end,
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            ]),
          }),
        ],
      }),
      {
        idempotencyKey: `usage-pack-migration:${preview.migrationId}:schedule-update`,
      },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    const scheduledState = await readUsagePackState(
      fixture.orgId,
      preview.migrationId,
    );
    expect(scheduledState.migrations).toStrictEqual([
      expect.objectContaining({ status: "scheduled" }),
    ]);
    expect(scheduledState.subscriptionCount).toBe(0);
    expect(scheduledState.allocations).toStrictEqual([]);
    expect(scheduledState.grants).toStrictEqual([]);
    expect(scheduledState.legacyCredits).toStrictEqual([
      expect.objectContaining({
        stripeInvoiceId: fixture.legacyCreditInvoiceId,
        amount: 12_345,
        remaining: 12_345,
      }),
    ]);

    stripe.startScheduledPhase();
    await postMigrationInvoice(stripe.invoice());
    const usageState = await readUsagePackState(
      fixture.orgId,
      preview.migrationId,
    );
    expect(usageState.allocations).toStrictEqual([
      expect.objectContaining({
        userId: fixture.userId,
        status: "active",
        usagePackUsd: 20,
      }),
    ]);
    expect(usageState.org?.tier).toBe("team");
    expect(usageState.grants).toHaveLength(2);
    expect(usageState.legacyCredits).toStrictEqual([
      expect.objectContaining({
        stripeInvoiceId: fixture.legacyCreditInvoiceId,
        amount: 12_345,
        remaining: 12_345,
      }),
    ]);

    await postMigrationInvoice(stripe.invoice());
    const duplicateState = await readUsagePackState(
      fixture.orgId,
      preview.migrationId,
    );
    expect(duplicateState.grants).toHaveLength(2);

    await postMigrationSubscription(legacyMigrationSubscription(fixture));
    const delayedState = await readUsagePackState(
      fixture.orgId,
      preview.migrationId,
    );
    expect(delayedState.subscription?.subscriptionStatus).toBe("active");
    expect(delayedState.grants).toHaveLength(2);
  });

  it("revises a discounted scheduled migration and exposes its configuration", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    const stripe = mockMigrationStripe({
      fixture,
      targetTier: "team",
      packageQuantity: 1,
      currentRecurringAmountCents: 2000,
      amountDueCents: 18_000,
      amountPaidCents: 18_000,
      discountAmountCents: 3000,
    });
    const preview = await previewMigration(fixture, "team");
    await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const scheduled = await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(scheduled.body).toMatchObject({
      status: "scheduled",
      configuration: {
        tier: "team",
        memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
        recurringAmountCents: 18_000,
        currency: "usd",
      },
    });

    context.mocks.stripe.invoices.createPreview.mockImplementation((params) => {
      const priceIds = migrationPreviewPriceIds(params);
      const amountDue = priceIds.includes(TEST_PRICE_USAGE_PACK_50)
        ? 21_000
        : 18_000;
      return Promise.resolve(
        migrationRecurringPreviewInvoice(
          params,
          fixture.period.end,
          amountDue,
          3000,
        ),
      );
    });
    context.mocks.stripe.subscriptionSchedules.update.mockClear();
    const memberUsagePacks = [
      { memberId: fixture.userId, usagePackUsd: 50 as const },
    ];
    const revisionPreview = await accept(
      migrationClient().previewRevision({
        params: { migrationId: preview.migrationId },
        body: { targetTier: "team", memberUsagePacks },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(revisionPreview.body).toMatchObject({
      migrationId: preview.migrationId,
      tier: "team",
      targetTier: "team",
      currentRecurringAmountCents: 18_000,
      nextRecurringAmountCents: 21_000,
      recurringDifferenceCents: 3000,
      purchasedCredits: 50_000,
      bonusCredits: 2600,
      totalCredits: 52_600,
    });
    const revisionPreviewParams =
      context.mocks.stripe.invoices.createPreview.mock.calls.at(-1)?.at(0);
    expect(stripe.discountId).not.toBeNull();
    expect(revisionPreviewParams).toMatchObject({
      schedule: stripe.scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          expect.objectContaining({
            discounts: [{ discount: stripe.discountId }],
          }),
          expect.objectContaining({
            discounts: [{ discount: stripe.discountId }],
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
            ]),
          }),
        ],
      },
    });
    expect(revisionPreviewParams).not.toHaveProperty("subscription");
    expect(revisionPreviewParams).not.toHaveProperty("subscription_details");

    const confirmation = await accept(
      migrationClient().confirmRevision({
        params: { migrationId: preview.migrationId },
        body: {
          targetTier: "team",
          memberUsagePacks,
          previewToken: revisionPreview.body.previewToken,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmation.body).toMatchObject({ status: "scheduled" });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        phases: [
          expect.objectContaining({
            discounts: [{ discount: stripe.discountId }],
          }),
          expect.objectContaining({
            discounts: [{ discount: stripe.discountId }],
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
            ]),
          }),
        ],
      }),
      {
        idempotencyKey: expect.stringMatching(
          new RegExp(
            `^usage-pack-migration:${preview.migrationId}:schedule-revision:[a-f0-9]{64}$`,
          ),
        ),
      },
    );
    const scheduleUpdateCount =
      context.mocks.stripe.subscriptionSchedules.update.mock.calls.length;
    await accept(
      migrationClient().confirmRevision({
        params: { migrationId: preview.migrationId },
        body: {
          targetTier: "team",
          memberUsagePacks,
          previewToken: revisionPreview.body.previewToken,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update.mock.calls,
    ).toHaveLength(scheduleUpdateCount);

    const revised = await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(revised.body).toMatchObject({
      status: "scheduled",
      targetTier: "team",
      configuration: {
        tier: "team",
        memberUsagePacks,
        recurringAmountCents: 21_000,
        currency: "usd",
      },
    });
  });

  it("rejects tampered and stale migration revision previews", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    mockMigrationStripe({
      fixture,
      packageQuantity: 1,
      currentRecurringAmountCents: 2000,
      amountDueCents: 4000,
      amountPaidCents: 4000,
    });
    const preview = await previewMigration(fixture);
    await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    context.mocks.stripe.invoices.createPreview.mockImplementation((params) => {
      const priceIds = migrationPreviewPriceIds(params);
      const amountDue = priceIds.includes(TEST_PRICE_USAGE_PACK_100)
        ? 28_000
        : 7000;
      return Promise.resolve(
        migrationRecurringPreviewInvoice(params, fixture.period.end, amountDue),
      );
    });
    const firstMemberUsagePacks = [
      { memberId: fixture.userId, usagePackUsd: 50 as const },
    ];
    const secondMemberUsagePacks = [
      { memberId: fixture.userId, usagePackUsd: 100 as const },
    ];
    const firstPreview = await accept(
      migrationClient().previewRevision({
        params: { migrationId: preview.migrationId },
        body: { targetTier: "pro", memberUsagePacks: firstMemberUsagePacks },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const secondPreview = await accept(
      migrationClient().previewRevision({
        params: { migrationId: preview.migrationId },
        body: { targetTier: "team", memberUsagePacks: secondMemberUsagePacks },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await accept(
      migrationClient().confirmRevision({
        params: { migrationId: preview.migrationId },
        body: {
          targetTier: "pro",
          memberUsagePacks: firstMemberUsagePacks,
          previewToken: `${firstPreview.body.previewToken}tampered`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    await accept(
      migrationClient().confirmRevision({
        params: { migrationId: preview.migrationId },
        body: {
          targetTier: "pro",
          memberUsagePacks: firstMemberUsagePacks,
          previewToken: firstPreview.body.previewToken,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const stale = await accept(
      migrationClient().confirmRevision({
        params: { migrationId: preview.migrationId },
        body: {
          targetTier: "team",
          memberUsagePacks: secondMemberUsagePacks,
          previewToken: secondPreview.body.previewToken,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    expect(stale.body.error.message).toBe(
      "Usage pack migration configuration changed",
    );

    const state = await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(state.body.configuration).toMatchObject({
      tier: "pro",
      memberUsagePacks: firstMemberUsagePacks,
    });
  });

  it("keeps Team legacy state intact when its migration schedule is canceled", async () => {
    mockNow(new Date("2020-01-01T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const preservedFixture = await seedLegacyMigrationFixture({
      tier: "team",
      orgId: `org_migration_preserved_${randomUUID()}`,
    });
    mockMigrationStripe({
      fixture: preservedFixture,
      packageQuantity: 1,
      currentRecurringAmountCents: 20_000,
      amountDueCents: 18_000,
      amountPaidCents: 18_000,
    });
    const preservedPreview = await previewMigration(preservedFixture);
    await accept(
      migrationClient().confirm({
        params: { migrationId: preservedPreview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const preservedBefore = await readUsagePackState(preservedFixture.orgId);

    const fixture = await seedLegacyMigrationFixture({ tier: "team" });
    const stripe = mockMigrationStripe({
      fixture,
      packageQuantity: 1,
      currentRecurringAmountCents: 20_000,
      amountDueCents: 18_000,
      amountPaidCents: 18_000,
    });
    const preview = await previewMigration(fixture);
    const confirmation = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmation.body.status).toBe("scheduled");
    expect((await readUsagePackState(fixture.orgId)).subscriptionCount).toBe(0);

    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    const retry = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(retry.body.status).toBe("scheduled");

    stripe.cancelSchedule();
    mockNow(fixture.period.end * 1000 + 10 * 60 * 1000);
    await reconcileBillingOrganization(fixture.orgId);

    const preserved = await readUsagePackState(preservedFixture.orgId);
    expect(preserved).toStrictEqual(preservedBefore);
    expect(preserved.migrations).toStrictEqual([
      expect.objectContaining({
        id: preservedPreview.migrationId,
        status: "scheduled",
      }),
    ]);

    const persisted = await readUsagePackState(fixture.orgId);
    expect(persisted.migrations).toStrictEqual([
      expect.objectContaining({ id: preview.migrationId, status: "failed" }),
    ]);
    expect(persisted.subscriptionCount).toBe(0);
    expect(persisted.org).toMatchObject({
      tier: "team",
      stripeSubscriptionId: fixture.subscriptionId,
      credits: 12_345,
    });
  });

  it("syncs legacy cancellation when a subscription update invalidates migration", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "team" });
    const stripe = mockMigrationStripe({
      fixture,
      packageQuantity: 1,
      currentRecurringAmountCents: 20_000,
      amountDueCents: 18_000,
      amountPaidCents: 18_000,
    });
    const preview = await previewMigration(fixture);
    await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await postMigrationSubscription(stripe.cancelSubscription());

    const state = await readUsagePackState(fixture.orgId);
    expect(state.migrations).toStrictEqual([
      expect.objectContaining({
        id: preview.migrationId,
        status: "failed",
        failureReason: "subscription_changed",
      }),
    ]);
    expect(state.org).toMatchObject({
      tier: "team",
      stripeSubscriptionId: fixture.subscriptionId,
      subscriptionStatus: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(fixture.period.end * 1000).toISOString(),
    });
  });

  it("refunds only a pending invitation's share of a migration payment", async () => {
    const fixture = await seedLegacyMigrationFixture({
      tier: "team",
      invitation: true,
    });
    if (!fixture.invitation) {
      throw new Error("Expected a pending invitation fixture");
    }
    const stripe = mockMigrationStripe({
      fixture,
      packageQuantity: 2,
      currentRecurringAmountCents: 20_000,
      amountDueCents: 20_000,
      amountPaidCents: 20_000,
    });
    const preview = await previewMigration(fixture);
    const confirmation = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmation.body.status).toBe("scheduled");
    stripe.startScheduledPhase();
    await postMigrationInvoice(stripe.invoice());

    const [purchase] = (
      await readUsagePackState(fixture.orgId, preview.migrationId)
    ).invitationPurchases;
    expect(purchase).toMatchObject({
      status: "invitation_pending",
      expectedAmountCents: 2000,
      amountPaidCents: 2000,
    });
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [{ id: fixture.invitation.id }] },
    );
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: `re_${randomUUID()}`,
      status: "succeeded",
    });

    await accept(
      setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).revoke({
        headers: { authorization: "Bearer clerk-session" },
        body: { invitationId: fixture.invitation.id },
      }),
      [200],
    );

    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: purchase?.stripePaymentIntentId,
        amount: 2000,
      }),
      expect.any(Object),
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            ]),
          }),
        ]),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          `usage-pack-projection:invitation:${purchase?.id}:refund:`,
        ),
      }),
    );
  });

  it("activates a migrated invitation without adding a second Stripe seat", async () => {
    const fixture = await seedLegacyMigrationFixture({
      tier: "team",
      invitation: true,
    });
    if (!fixture.invitation) {
      throw new Error("Expected a pending invitation fixture");
    }
    const stripe = mockMigrationStripe({
      fixture,
      packageQuantity: 2,
      currentRecurringAmountCents: 20_000,
      amountDueCents: 20_000,
      amountPaidCents: 20_000,
    });
    const preview = await previewMigration(fixture);
    const confirmation = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmation.body.status).toBe("scheduled");
    stripe.startScheduledPhase();
    await postMigrationInvoice(stripe.invoice());
    const [purchase] = (
      await readUsagePackState(fixture.orgId, preview.migrationId)
    ).invitationPurchases;
    if (!purchase) {
      throw new Error("Expected a migrated invitation purchase");
    }

    context.mocks.stripe.subscriptions.update.mockClear();
    const acceptedUserId = `user_migration_invited_${randomUUID()}`;
    await postMigrationInvitationAccepted({
      fixture,
      purchaseId: purchase.id,
      userId: acceptedUserId,
    });
    await postMigrationInvitationAccepted({
      fixture,
      purchaseId: purchase.id,
      userId: acceptedUserId,
    });

    const accepted = await readUsagePackState(
      fixture.orgId,
      preview.migrationId,
    );
    expect(accepted.invitationPurchases).toStrictEqual([
      expect.objectContaining({
        id: purchase.id,
        status: "accepted",
        acceptedUserId,
      }),
    ]);
    expect(
      accepted.allocations.filter((allocation) => {
        return allocation.userId === acceptedUserId;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        invitationId: null,
        status: "active",
        usagePackUsd: 20,
      }),
    ]);
    expect(
      accepted.grants.filter((grant) => {
        return grant.userId === acceptedUserId;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        grantType: "bonus",
        originalAmount: 400,
      }),
      expect.objectContaining({
        grantType: "purchased",
        originalAmount: 20_000,
      }),
    ]);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("finishes a zero-amount Team conversion and invitation lifecycle", async () => {
    const fixture = await seedLegacyMigrationFixture({
      tier: "team",
      invitation: true,
    });
    if (!fixture.invitation) {
      throw new Error("Expected a pending invitation fixture");
    }
    const stripe = mockMigrationStripe({
      fixture,
      packageQuantity: 2,
      currentRecurringAmountCents: 20_000,
      amountDueCents: 0,
      amountPaidCents: 0,
    });
    const preview = await previewMigration(fixture);
    const confirmation = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmation.body.status).toBe("scheduled");

    stripe.startScheduledPhase();
    await postMigrationInvoice(stripe.invoice());

    const state = await readUsagePackState(fixture.orgId, preview.migrationId);
    const [purchase] = state.invitationPurchases;
    expect(purchase).toMatchObject({
      status: "invitation_pending",
      amountPaidCents: 0,
      stripePaymentIntentId: null,
    });
    expect(state.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invitationId: fixture.invitation.id,
          status: "pending_invitation",
        }),
      ]),
    );

    const revokeResponse = await accept(
      setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).revoke({
        headers: { authorization: "Bearer clerk-session" },
        body: { invitationId: fixture.invitation.id },
      }),
      [200],
    );
    expect(revokeResponse.body.message).toBe(
      "Invitation revoked and refund initiated",
    );
    const [refunded] = (
      await readUsagePackState(fixture.orgId, preview.migrationId)
    ).invitationPurchases;
    expect(refunded?.status).toBe("refunded");
    expect(context.mocks.stripe.refunds.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            ]),
          }),
        ]),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          `usage-pack-projection:invitation:${purchase?.id}:refund:`,
        ),
      }),
    );
  });
});

describe("usage pack allocation management", () => {
  interface ManagedUsagePackFixture extends BillingOrgFixture {
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly usagePackSubscriptionId: string;
    readonly billingPeriod: { readonly start: number; readonly end: number };
    readonly tier: "pro" | "team";
  }

  function managedUsagePackPlanPriceId(
    tier: ManagedUsagePackFixture["tier"],
  ): string {
    return tier === "pro"
      ? TEST_PRICE_USAGE_PACK_PLAN_PRO
      : TEST_PRICE_USAGE_PACK_PLAN_TEAM;
  }

  function managedUsagePackMetadata(fixture: ManagedUsagePackFixture) {
    return {
      orgId: fixture.orgId,
      tier: fixture.tier,
      priceId: managedUsagePackPlanPriceId(fixture.tier),
      purpose: "usage_pack_subscription",
      usagePackSubscriptionId: fixture.usagePackSubscriptionId,
    };
  }

  function managedUsagePackSubscription(
    fixture: ManagedUsagePackFixture,
    quantities: ReadonlyMap<string, number>,
    billingPeriod = fixture.billingPeriod,
    options?: {
      readonly pendingUpdateExpiresAt?: number;
      readonly latestInvoice?: object | string | null;
      readonly scheduleId?: string;
    },
  ) {
    return {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: options?.scheduleId ?? null,
      pending_update: options?.pendingUpdateExpiresAt
        ? { expires_at: options.pendingUpdateExpiresAt }
        : null,
      latest_invoice: options?.latestInvoice ?? null,
      metadata: managedUsagePackMetadata(fixture),
      items: {
        data: [
          {
            id: "si_usage_pack_plan",
            price: {
              id: managedUsagePackPlanPriceId(fixture.tier),
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 1,
            current_period_start: billingPeriod.start,
            current_period_end: billingPeriod.end,
          },
          ...[...quantities].map(([priceId, quantity]) => {
            return {
              id: `si_${priceId}`,
              price: {
                id: priceId,
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity,
              current_period_start: billingPeriod.start,
              current_period_end: billingPeriod.end,
            };
          }),
        ],
      },
    };
  }

  function managedUsagePackInvoice(
    fixture: ManagedUsagePackFixture,
    args: {
      readonly invoiceId: string;
      readonly quantities: ReadonlyMap<string, number>;
      readonly billingPeriod?: { readonly start: number; readonly end: number };
    },
  ) {
    const billingPeriod = args.billingPeriod ?? fixture.billingPeriod;
    const metadata = managedUsagePackMetadata(fixture);
    return {
      id: args.invoiceId,
      customer: fixture.customerId,
      metadata,
      status: "paid",
      parent: {
        subscription_details: {
          subscription: fixture.subscriptionId,
          metadata,
        },
      },
      lines: {
        has_more: false,
        data: [...args.quantities].map(([priceId, quantity]) => {
          const configuration = usagePackPriceConfiguration(priceId);
          return {
            id: `il_${randomUUID()}`,
            amount: configuration.usagePackUsd * 100 * quantity,
            subtotal: configuration.usagePackUsd * 100 * quantity,
            quantity,
            price: { id: priceId },
            period: billingPeriod,
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { proration: false },
            },
          };
        }),
      },
    };
  }

  function managedConcurrencyInvoiceLine(args: {
    readonly quantity: number;
    readonly billingPeriod: { readonly start: number; readonly end: number };
    readonly proration: boolean;
  }) {
    return {
      id: `il_${randomUUID()}`,
      amount: 10_000 * args.quantity,
      subtotal: 10_000 * args.quantity,
      quantity: args.quantity,
      price: { id: TEST_PRICE_CONCURRENCY },
      period: args.billingPeriod,
      parent: {
        type: "subscription_item_details" as const,
        subscription_item_details: { proration: args.proration },
      },
    };
  }

  function managedUsagePackUpgradeInvoice(
    fixture: ManagedUsagePackFixture,
    args: {
      readonly invoiceId: string;
      readonly sourcePriceId: string;
      readonly targetPriceId: string;
      readonly prorationTimestamp: number;
    },
  ) {
    const metadata = managedUsagePackMetadata(fixture);
    const line = (priceId: string, amount: number) => {
      return {
        id: `il_${randomUUID()}`,
        amount,
        subtotal: amount,
        quantity: 1,
        price: { id: priceId },
        period: {
          start: args.prorationTimestamp,
          end: fixture.billingPeriod.end,
        },
        parent: {
          type: "subscription_item_details" as const,
          subscription_item_details: { proration: true },
        },
      };
    };
    return {
      id: args.invoiceId,
      customer: fixture.customerId,
      metadata,
      status: "paid",
      hosted_invoice_url: `https://invoice.stripe.test/${args.invoiceId}`,
      parent: {
        subscription_details: {
          subscription: fixture.subscriptionId,
          metadata,
        },
      },
      lines: {
        has_more: false,
        data: [line(args.sourcePriceId, -1000), line(args.targetPriceId, 2500)],
      },
    };
  }

  function managedUsagePackAdditionInvoice(
    fixture: ManagedUsagePackFixture,
    args: {
      readonly invoiceId: string;
      readonly targetPriceId: string;
      readonly prorationTimestamp: number;
    },
  ) {
    const metadata = managedUsagePackMetadata(fixture);
    return {
      id: args.invoiceId,
      customer: fixture.customerId,
      metadata,
      status: "paid",
      hosted_invoice_url: `https://invoice.stripe.test/${args.invoiceId}`,
      parent: {
        subscription_details: {
          subscription: fixture.subscriptionId,
          metadata,
        },
      },
      lines: {
        has_more: false,
        data: [
          {
            id: `il_${randomUUID()}`,
            amount: 2500,
            subtotal: 2500,
            quantity: 1,
            price: { id: args.targetPriceId },
            period: {
              start: args.prorationTimestamp,
              end: fixture.billingPeriod.end,
            },
            parent: {
              type: "subscription_item_details" as const,
              subscription_item_details: { proration: true },
            },
          },
        ],
      },
    };
  }

  async function postManagedUsagePackEvent(
    type: string,
    object: object,
    created = Math.floor(now() / 1000),
  ): Promise<void> {
    const event = {
      id: `evt_${randomUUID()}`,
      type,
      created,
      data: { object },
    };
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=usage-pack-change" },
      }),
      [200],
    );
  }

  async function seedManagedUsagePack(
    allocations: readonly {
      readonly userId: string;
      readonly usagePackUsd: 20 | 50 | 100 | 200;
    }[],
    tier: ManagedUsagePackFixture["tier"] = "pro",
    fixture: BillingOrgFixture = createOrgFixture(TEST_STAFF_ORG_ID),
  ): Promise<ManagedUsagePackFixture> {
    const customerId = `cus_${randomUUID()}`;
    const subscriptionId = `sub_${randomUUID()}`;
    const checkoutSessionId = `cs_${randomUUID()}`;
    const current = Math.floor(now() / 1000);
    const billingPeriod = {
      start: current - 15 * 86_400,
      end: current + 15 * 86_400,
    };
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "limited-free-1",
      credits: 0,
    });
    const seeded = await usagePackStateAction({
      action: "seed",
      orgId: fixture.orgId,
      tier,
      stripePlanPriceId: managedUsagePackPlanPriceId(tier),
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: checkoutSessionId,
      allocations: allocations.map((allocation) => {
        return {
          userId: allocation.userId,
          invitationId: null,
          usagePackUsd: allocation.usagePackUsd,
          stripePriceId: priceIdForManagedUsagePack(allocation.usagePackUsd),
        };
      }),
    });
    if (seeded.action !== "seeded") {
      throw new Error("Failed to seed managed usage pack");
    }
    const managedFixture: ManagedUsagePackFixture = {
      ...fixture,
      customerId,
      subscriptionId,
      usagePackSubscriptionId: seeded.usagePackSubscriptionId,
      billingPeriod,
      tier,
    };
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId: seeded.usagePackSubscriptionId,
        deleteGrants: true,
        deleteOrgMetadata: true,
      });
    });
    authenticateOrg(fixture);
    const quantities = new Map<string, number>();
    for (const allocation of allocations) {
      const priceId = priceIdForManagedUsagePack(allocation.usagePackUsd);
      quantities.set(priceId, (quantities.get(priceId) ?? 0) + 1);
    }
    const subscription = managedUsagePackSubscription(
      managedFixture,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    await postManagedUsagePackEvent(
      "invoice.paid",
      managedUsagePackInvoice(managedFixture, {
        invoiceId: `in_${randomUUID()}`,
        quantities,
      }),
    );
    return managedFixture;
  }

  function priceIdForManagedUsagePack(
    usagePackUsd: 20 | 50 | 100 | 200,
  ): string {
    switch (usagePackUsd) {
      case 20: {
        return TEST_PRICE_USAGE_PACK_20;
      }
      case 50: {
        return TEST_PRICE_USAGE_PACK_50;
      }
      case 100: {
        return TEST_PRICE_USAGE_PACK_100;
      }
      case 200: {
        return TEST_PRICE_USAGE_PACK_200;
      }
    }
  }

  type PreviewSubscriptionDetails = NonNullable<
    StripeInvoiceCreatePreviewParams["subscription_details"]
  >;

  function previewSubscriptionDetails(
    input: unknown,
  ): PreviewSubscriptionDetails | null {
    if (typeof input !== "object" || input === null) {
      return null;
    }
    const details = Reflect.get(input, "subscription_details");
    if (
      typeof details !== "object" ||
      details === null ||
      !Array.isArray(Reflect.get(details, "items"))
    ) {
      return null;
    }
    return details as PreviewSubscriptionDetails;
  }

  function previewTargetPriceId(
    details: PreviewSubscriptionDetails | null,
  ): string | null {
    const item = details?.items.at(-1);
    if (!item) {
      return null;
    }
    if ("price" in item && item.price) {
      return item.price;
    }
    return "id" in item && item.id?.startsWith("si_") ? item.id.slice(3) : null;
  }

  function mockUsagePackProrationLines(
    details: PreviewSubscriptionDetails | null,
    amountCents: number,
  ) {
    const targetPriceId = previewTargetPriceId(details);
    const prorationTimestamp = details?.proration_date;
    if (!targetPriceId || typeof prorationTimestamp !== "number") {
      return [];
    }
    return [
      {
        id: `il_preview_${randomUUID()}`,
        amount: amountCents,
        price: { id: targetPriceId },
        period: { start: prorationTimestamp },
        parent: {
          type: "subscription_item_details" as const,
          subscription_item_details: { proration: true },
        },
      },
    ];
  }

  function mockUsagePackChangePreviews(
    immediateAmountCents: number,
    nextRecurringAmountCents: number,
  ): void {
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("Expected Stripe invoice preview input");
      }
      if (
        "preview_mode" in input &&
        input.preview_mode === "recurring" &&
        "subscription_details" in input &&
        typeof input.subscription_details === "object" &&
        input.subscription_details !== null &&
        ("proration_behavior" in input.subscription_details ||
          "proration_date" in input.subscription_details)
      ) {
        throw new Error("Recurring previews cannot include prorations");
      }
      const immediate =
        "preview_mode" in input && input.preview_mode === "next";
      const subscriptionDetails = previewSubscriptionDetails(input);
      return Promise.resolve({
        id: `in_preview_${randomUUID()}`,
        amount_due: immediate ? immediateAmountCents : nextRecurringAmountCents,
        currency: "usd",
        lines: {
          has_more: false,
          data: immediate
            ? mockUsagePackProrationLines(
                subscriptionDetails,
                immediateAmountCents,
              )
            : [],
        },
      });
    });
  }

  function mockInvitationChargePreview(args: {
    readonly lines: readonly {
      readonly lineAmountCents: number;
      readonly subtotalCents: number;
      readonly exclusiveTaxCents: number;
    }[];
    readonly periodEnd: number;
    readonly automaticTax?: boolean;
  }): void {
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      const details = previewSubscriptionDetails(input);
      const targetPriceId = previewTargetPriceId(details);
      const prorationTimestamp = details?.proration_date;
      if (!targetPriceId || typeof prorationTimestamp !== "number") {
        throw new Error("Expected an invitation proration preview");
      }
      return Promise.resolve({
        id: `in_preview_${randomUUID()}`,
        amount_due: args.lines.reduce((total, line) => {
          return total + line.lineAmountCents + line.exclusiveTaxCents;
        }, 0),
        currency: "usd",
        automatic_tax: args.automaticTax
          ? { enabled: true, liability: { type: "self" } }
          : { enabled: false, liability: null },
        lines: {
          has_more: false,
          data: args.lines.map((line) => {
            return {
              id: `il_preview_${randomUUID()}`,
              amount: line.lineAmountCents,
              subtotal: line.subtotalCents,
              price: { id: targetPriceId },
              taxes:
                line.exclusiveTaxCents !== 0
                  ? [
                      {
                        amount: line.exclusiveTaxCents,
                        tax_behavior: "exclusive" as const,
                        ...(args.automaticTax
                          ? {}
                          : {
                              tax_rate_details: {
                                tax_rate: "txr_invitation",
                              },
                            }),
                      },
                    ]
                  : [],
              period: {
                start: prorationTimestamp,
                end: args.periodEnd,
              },
              parent: {
                type: "subscription_item_details" as const,
                subscription_item_details: { proration: true },
              },
            };
          }),
        },
      });
    });
  }

  function isStripeSchedulePreview(input: object): boolean {
    return (
      "schedule_details" in input &&
      typeof input.schedule_details === "object" &&
      input.schedule_details !== null
    );
  }

  function stripeInvoicePreviewMode(input: object): "next" | "recurring" {
    const previewMode =
      "preview_mode" in input ? input.preview_mode : undefined;
    if (previewMode !== "next" && previewMode !== "recurring") {
      throw new Error("Expected a Stripe invoice preview mode");
    }
    return previewMode;
  }

  function mockUsagePackSubscriptionChangePreviews(
    immediateAmountCents: number,
    recurringPlanAmountCents: number,
  ): void {
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("Expected Stripe invoice preview input");
      }
      const previewMode = stripeInvoicePreviewMode(input);
      const subscriptionDetails =
        "subscription_details" in input
          ? input.subscription_details
          : undefined;
      const scheduledPreview = isStripeSchedulePreview(input);
      if (
        previewMode === "recurring" &&
        typeof subscriptionDetails === "object" &&
        subscriptionDetails !== null &&
        ("proration_behavior" in subscriptionDetails ||
          "proration_date" in subscriptionDetails)
      ) {
        throw new Error("Recurring previews cannot include prorations");
      }
      const prorationTimestamp =
        typeof subscriptionDetails === "object" &&
        subscriptionDetails !== null &&
        "proration_date" in subscriptionDetails &&
        typeof subscriptionDetails.proration_date === "number"
          ? subscriptionDetails.proration_date
          : undefined;
      if (
        previewMode === "next" &&
        prorationTimestamp === undefined &&
        !scheduledPreview
      ) {
        throw new Error("Expected a plan proration timestamp");
      }
      const line = (args: {
        readonly id: string;
        readonly amount: number;
        readonly priceId: string;
        readonly proration: boolean;
      }) => {
        return {
          id: args.id,
          amount: args.amount,
          pricing: { price_details: { price: args.priceId } },
          parent: {
            subscription_item_details: { proration: args.proration },
          },
          period: { start: prorationTimestamp ?? 0 },
        };
      };
      const immediatePreview = previewMode === "next" && !scheduledPreview;
      const lines = immediatePreview
        ? [
            line({
              id: "il_plan_credit",
              amount: -recurringPlanAmountCents / 2,
              priceId: TEST_PRICE_USAGE_PACK_PLAN_PRO,
              proration: true,
            }),
            line({
              id: "il_plan_charge",
              amount: immediateAmountCents + recurringPlanAmountCents / 2,
              priceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
              proration: true,
            }),
            line({
              id: "il_existing_package",
              amount: 2000,
              priceId: TEST_PRICE_USAGE_PACK_20,
              proration: false,
            }),
          ]
        : [
            line({
              id: "il_team_plan",
              amount: recurringPlanAmountCents,
              priceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
              proration: false,
            }),
            line({
              id: "il_existing_package",
              amount: 2000,
              priceId: TEST_PRICE_USAGE_PACK_20,
              proration: false,
            }),
          ];
      return Promise.resolve({
        amount_due: immediatePreview
          ? immediateAmountCents + 2000
          : recurringPlanAmountCents + 2000,
        currency: "usd",
        lines: {
          has_more: false,
          data: lines,
        },
      });
    });
  }

  function mockUsagePackSubscriptionPackagePreviews(args: {
    readonly immediateAmountCents: number;
    readonly nextRecurringAmountCents: number;
    readonly sourcePriceId: string;
    readonly targetPriceId: string;
    readonly rejectScheduledSubscriptionRecurringPreview?: boolean;
  }): void {
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("Expected Stripe invoice preview input");
      }
      const previewMode =
        "preview_mode" in input ? input.preview_mode : undefined;
      const subscriptionDetails =
        "subscription_details" in input
          ? input.subscription_details
          : undefined;
      if (previewMode === "next" && isStripeSchedulePreview(input)) {
        return Promise.resolve({
          amount_due: args.nextRecurringAmountCents,
          currency: "usd",
          lines: { has_more: false, data: [] },
        });
      }
      if (previewMode === "recurring") {
        if (
          args.rejectScheduledSubscriptionRecurringPreview &&
          "subscription" in input
        ) {
          throw new Error(
            "Recurring estimates do not support subscription schedules",
          );
        }
        if (
          typeof subscriptionDetails === "object" &&
          subscriptionDetails !== null &&
          ("proration_behavior" in subscriptionDetails ||
            "proration_date" in subscriptionDetails)
        ) {
          throw new Error("Recurring previews cannot include prorations");
        }
        return Promise.resolve({
          amount_due: args.nextRecurringAmountCents,
          currency: "usd",
          lines: {
            has_more: false,
            data: [],
          },
        });
      }
      if (
        previewMode !== "next" ||
        typeof subscriptionDetails !== "object" ||
        subscriptionDetails === null ||
        !("proration_date" in subscriptionDetails) ||
        typeof subscriptionDetails.proration_date !== "number"
      ) {
        throw new Error("Expected an immediate Stripe preview");
      }
      const line = (priceId: string, amount: number) => {
        return {
          id: `il_${randomUUID()}`,
          amount,
          pricing: { price_details: { price: priceId } },
          parent: { subscription_item_details: { proration: true } },
          period: { start: subscriptionDetails.proration_date },
        };
      };
      return Promise.resolve({
        amount_due: args.immediateAmountCents,
        currency: "usd",
        lines: {
          has_more: false,
          data: [
            line(args.sourcePriceId, -1000),
            line(args.targetPriceId, args.immediateAmountCents + 1000),
          ],
        },
      });
    });
  }

  interface InvitationPurchaseFixture {
    readonly fixture: ManagedUsagePackFixture;
    readonly existingMemberUserId: string;
    readonly email: string;
    readonly purchaseId: string;
    readonly paymentIntentId: string;
  }

  async function setupInvitationPreviewContext(
    emailPrefix: string,
    actor = createOrgFixture(TEST_STAFF_ORG_ID),
  ): Promise<{
    readonly fixture: ManagedUsagePackFixture;
    readonly existingMemberUserId: string;
    readonly email: string;
  }> {
    mockNow(new Date("2035-05-15T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const existingMemberUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId: existingMemberUserId, usagePackUsd: 20 }],
      "pro",
      actor,
    );
    const email = `${emailPrefix}-${randomUUID()}@example.test`;
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: {
              userId: existingMemberUserId,
              identifier: `${existingMemberUserId}@example.test`,
            },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    return { fixture, existingMemberUserId, email };
  }

  async function beginInvitationPurchase(
    actor = createOrgFixture(TEST_STAFF_ORG_ID),
  ): Promise<InvitationPurchaseFixture> {
    const { fixture, existingMemberUserId, email } =
      await setupInvitationPreviewContext("invitee", actor);
    const paymentIntentId = `pi_invite_${randomUUID()}`;
    mockUsagePackChangePreviews(1000, 2000);
    const preview = await accept(
      setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      ).previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: { email, role: "member", usagePackUsd: 20 },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual({
      purchaseId: expect.any(String),
      usagePackUsd: 20,
      immediateAmountCents: 1000,
      currency: "usd",
      purchasedCredits: 10_000,
      bonusCredits: 200,
      totalCredits: 10_200,
      currentPeriodEnd: new Date(
        fixture.billingPeriod.end * 1000,
      ).toISOString(),
      expiresAt: expect.any(String),
    });
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
    return {
      fixture,
      existingMemberUserId,
      email,
      purchaseId: preview.body.purchaseId,
      paymentIntentId,
    };
  }

  async function payInvitationPurchase(
    purchase: InvitationPurchaseFixture,
    invitationId: string,
  ): Promise<void> {
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
      {
        id: invitationId,
        emailAddress: purchase.email,
        organizationId: purchase.fixture.orgId,
        status: "pending",
        privateMetadata: {
          usagePackInvitationPurchaseId: purchase.purchaseId,
        },
      },
    );
    await postManagedUsagePackEvent("payment_intent.succeeded", {
      id: purchase.paymentIntentId,
      status: "succeeded",
      customer: purchase.fixture.customerId,
      payment_method: null,
      amount_received: 1000,
      currency: "usd",
      created: Math.floor(now() / 1000),
      metadata: {
        purpose: "usage_pack_invitation_purchase",
        usagePackInvitationPurchaseId: purchase.purchaseId,
      },
    });
  }

  function mockSavedCardInvitationPayment(
    purchase: InvitationPurchaseFixture,
  ): string {
    const paymentMethodId = `pm_invite_${randomUUID()}`;
    const invoiceId = `in_invite_${randomUUID()}`;
    const paymentIntentId = `pi_invite_${randomUUID()}`;
    const metadata = {
      purpose: "usage_pack_invitation_purchase",
      usagePackInvitationPurchaseId: purchase.purchaseId,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...managedUsagePackSubscription(
        purchase.fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      default_payment_method: paymentMethodId,
    });
    context.mocks.stripe.invoices.create.mockResolvedValue({
      id: invoiceId,
      metadata,
      status: "draft",
      hosted_invoice_url: null,
    });
    context.mocks.stripe.invoiceItems.create.mockResolvedValue({
      id: `ii_invite_${randomUUID()}`,
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: invoiceId,
      status: "open",
      hosted_invoice_url: `https://invoice.stripe.test/${invoiceId}`,
    });
    context.mocks.stripe.invoices.pay.mockResolvedValue({
      id: invoiceId,
      status: "paid",
    });
    context.mocks.stripe.invoices.retrieve.mockResolvedValue({
      id: invoiceId,
      customer: purchase.fixture.customerId,
      metadata,
      status: "paid",
      paid: true,
      currency: "usd",
      status_transitions: { paid_at: Math.floor(now() / 1000) },
      payments: {
        data: [
          {
            status: "paid",
            amount_paid: 1000,
            payment: {
              type: "payment_intent",
              payment_intent: paymentIntentId,
            },
          },
        ],
      },
    });
    return paymentIntentId;
  }

  async function postClerkInvitationAccepted(args: {
    readonly purchase: InvitationPurchaseFixture;
    readonly invitationId: string;
    readonly userId: string;
  }): Promise<void> {
    const event = {
      type: "organizationInvitation.accepted",
      data: {
        object: "organization_invitation",
        id: args.invitationId,
        email_address: args.purchase.email,
        organization_id: args.purchase.fixture.orgId,
        role: "org:member",
        role_name: "Member",
        status: "accepted",
        user_id: args.userId,
        public_metadata: {},
        private_metadata: {
          usagePackInvitationPurchaseId: args.purchase.purchaseId,
        },
        url: null,
        created_at: now() - 1000,
        updated_at: now(),
        expires_at: args.purchase.fixture.billingPeriod.end * 1000,
      },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify(event),
      }),
      [200],
    );
    await flushWaitUntilForTest();
  }

  async function postClerkMembershipCreated(args: {
    readonly purchase: InvitationPurchaseFixture;
    readonly userId: string;
  }): Promise<void> {
    const event = {
      type: "organizationMembership.created",
      data: {
        object: "organization_membership",
        id: `orgmem_${randomUUID()}`,
        organization: { id: args.purchase.fixture.orgId },
        role: "org:member",
        public_user_data: {
          user_id: args.userId,
          identifier: args.purchase.email,
        },
        private_metadata: {
          usagePackInvitationPurchaseId: args.purchase.purchaseId,
        },
        created_at: now(),
        updated_at: now(),
      },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify(event),
      }),
      [200],
    );
    await flushWaitUntilForTest();
  }

  async function runBillingReconciliation(orgId: string): Promise<void> {
    context.mocks.stripe.invoices.list.mockResolvedValue({ data: [] });
    await reconcileBillingOrganization(orgId);
  }

  function mockUsagePackSubscriptionAdditionPreviews(args: {
    readonly immediateAmountCents: number;
    readonly nextRecurringAmountCents: number;
    readonly targetPriceId: string;
  }): void {
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (typeof input !== "object" || input === null) {
        throw new Error("Expected Stripe invoice preview input");
      }
      const previewMode =
        "preview_mode" in input ? input.preview_mode : undefined;
      if (previewMode === "recurring") {
        return Promise.resolve({
          amount_due: args.nextRecurringAmountCents,
          currency: "usd",
          lines: {
            has_more: false,
            data: [],
          },
        });
      }
      const subscriptionDetails =
        "subscription_details" in input ? input.subscription_details : null;
      if (
        previewMode !== "next" ||
        typeof subscriptionDetails !== "object" ||
        subscriptionDetails === null ||
        !("proration_date" in subscriptionDetails) ||
        typeof subscriptionDetails.proration_date !== "number"
      ) {
        throw new Error("Expected an immediate Stripe preview");
      }
      return Promise.resolve({
        amount_due: args.immediateAmountCents,
        currency: "usd",
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${randomUUID()}`,
              amount: args.immediateAmountCents,
              pricing: { price_details: { price: args.targetPriceId } },
              parent: { subscription_item_details: { proration: true } },
              period: { start: subscriptionDetails.proration_date },
            },
          ],
        },
      });
    });
  }

  beforeEach(() => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    setTierPrices();
    setUsagePackPrices();
    mockUsagePackCatalog();
    context.mocks.stripe.invoices.list.mockResolvedValue({ data: [] });
    context.mocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
    mockOptionalEnv("STRIPE_SECRET_KEY", "sk_usage_pack_change");
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
  });

  it("records a card collected for a usage pack purchase setup", async () => {
    const actor = createOrgFixture();
    const fixture = await seedManagedUsagePack(
      [{ userId: actor.userId, usagePackUsd: 20 }],
      "pro",
      actor,
    );
    const paymentMethodId = `pm_${randomUUID().slice(0, 8)}`;
    const event = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_setup_${randomUUID().slice(0, 8)}`,
          mode: "setup",
          customer: fixture.customerId,
          subscription: null,
          metadata: {
            purpose: "billing_purchase",
            orgId: fixture.orgId,
            subscriptionId: fixture.subscriptionId,
          },
          setup_intent: {
            id: `seti_${randomUUID().slice(0, 8)}`,
            payment_method: paymentMethodId,
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
        extraHeaders: { "stripe-signature": "t=1,v1=purchase-setup" },
      }),
      [200],
    );

    expect(context.mocks.stripe.customers.update).toHaveBeenCalledWith(
      fixture.customerId,
      { invoice_settings: { default_payment_method: paymentMethodId } },
    );
  });

  it("routes a concurrency-only invoice on the Plan subscription", async () => {
    const actor = createOrgFixture();
    const fixture = await seedManagedUsagePack(
      [{ userId: actor.userId, usagePackUsd: 20 }],
      "team",
      actor,
    );
    const quantity = 10;
    const invoiceId = `in_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([
          [TEST_PRICE_USAGE_PACK_20, 1],
          [TEST_PRICE_CONCURRENCY, quantity],
        ]),
      ),
    );
    const metadata = managedUsagePackMetadata(fixture);

    await postManagedUsagePackEvent("invoice.paid", {
      id: invoiceId,
      customer: fixture.customerId,
      metadata,
      status: "paid",
      parent: {
        subscription_details: {
          subscription: fixture.subscriptionId,
          metadata,
        },
      },
      lines: {
        has_more: false,
        data: [
          managedConcurrencyInvoiceLine({
            quantity,
            billingPeriod: fixture.billingPeriod,
            proration: true,
          }),
        ],
      },
    });

    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity,
        currentPeriodEnd: new Date(
          fixture.billingPeriod.end * 1000,
        ).toISOString(),
      }),
    ]);
    const usagePackState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(usagePackState.fulfillmentInvoiceIds).not.toContain(invoiceId);
  });

  it("idempotently processes usage pack and concurrency from one renewal invoice", async () => {
    const actor = createOrgFixture();
    const fixture = await seedManagedUsagePack(
      [{ userId: actor.userId, usagePackUsd: 20 }],
      "team",
      actor,
    );
    const quantity = 6;
    const renewalPeriod = {
      start: fixture.billingPeriod.end,
      end: fixture.billingPeriod.end + 30 * 86_400,
    };
    mockNow(new Date(renewalPeriod.start * 1000 + 1000));
    onTestFinished(() => {
      clearMockNow();
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([
          [TEST_PRICE_USAGE_PACK_20, 1],
          [TEST_PRICE_CONCURRENCY, quantity],
        ]),
        renewalPeriod,
      ),
    );
    const invoiceId = `in_${randomUUID()}`;
    const usagePackInvoice = managedUsagePackInvoice(fixture, {
      invoiceId,
      quantities: new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      billingPeriod: renewalPeriod,
    });
    const invoice = {
      ...usagePackInvoice,
      lines: {
        ...usagePackInvoice.lines,
        data: [
          ...usagePackInvoice.lines.data,
          managedConcurrencyInvoiceLine({
            quantity,
            billingPeriod: renewalPeriod,
            proration: false,
          }),
        ],
      },
    };

    await postManagedUsagePackEvent("invoice.paid", invoice);

    const firstUsagePackState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(firstUsagePackState.fulfillmentInvoiceIds).toContain(invoiceId);
    expect(firstUsagePackState.allocations).toContainEqual(
      expect.objectContaining({
        userId: actor.userId,
        status: "active",
        currentPeriodStart: new Date(renewalPeriod.start * 1000).toISOString(),
        currentPeriodEnd: new Date(renewalPeriod.end * 1000).toISOString(),
      }),
    );
    const firstStatus = await readBillingStatus(fixture);
    expect(firstStatus.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity,
        currentPeriodEnd: new Date(renewalPeriod.end * 1000).toISOString(),
      }),
    ]);

    await postManagedUsagePackEvent("invoice.paid", invoice);

    const replayedUsagePackState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(
      replayedUsagePackState.fulfillmentInvoiceIds.filter((id) => {
        return id === invoiceId;
      }),
    ).toHaveLength(1);
    expect(replayedUsagePackState.grants).toStrictEqual(
      firstUsagePackState.grants,
    );
    const replayedStatus = await readBillingStatus(fixture);
    expect(replayedStatus.concurrencySubscriptions).toStrictEqual(
      firstStatus.concurrencySubscriptions,
    );
  });

  it("fulfills usage packs on a shared Custom subscription without replacing the main plan", async () => {
    const actor = createOrgFixture();
    const fixture = await seedManagedUsagePack(
      [{ userId: actor.userId, usagePackUsd: 100 }],
      "team",
      actor,
    );
    mockEnv("OKOU_PRICE_CUSTOM", TEST_PRICE_CUSTOM);
    const customMetadata = {
      orgId: fixture.orgId,
      purpose: "custom_plan_subscription",
      tier: "custom",
      usagePackSubscriptionId: fixture.usagePackSubscriptionId,
    };
    const customPlanEnd = fixture.billingPeriod.end + 180 * 86_400;
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: customPlanEnd,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: customMetadata,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_CUSTOM}`,
            price: { id: TEST_PRICE_CUSTOM },
            quantity: 1,
            current_period_start: fixture.billingPeriod.start,
            current_period_end: fixture.billingPeriod.end,
          },
        ],
      },
    });
    await postManagedUsagePackEvent("invoice.paid", {
      id: `in_${randomUUID()}`,
      customer: fixture.customerId,
      metadata: {},
      status: "paid",
      paid: true,
      parent: {
        subscription_details: {
          subscription: fixture.subscriptionId,
          metadata: customMetadata,
        },
      },
      lines: {
        has_more: false,
        data: [
          {
            id: `il_${randomUUID()}`,
            amount: 0,
            subtotal: 0,
            quantity: 1,
            price: { id: TEST_PRICE_CUSTOM },
            period: fixture.billingPeriod,
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { proration: false },
            },
          },
        ],
      },
    });
    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      tier: "custom",
      showUsagePack: false,
    });

    const renewalPeriod = {
      start: fixture.billingPeriod.end,
      end: fixture.billingPeriod.end + 30 * 86_400,
    };
    mockNow(new Date(renewalPeriod.start * 1000 + 1000));
    onTestFinished(() => {
      clearMockNow();
    });
    const renewedSharedSubscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: customPlanEnd,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: customMetadata,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_CUSTOM}`,
            price: { id: TEST_PRICE_CUSTOM },
            quantity: 1,
            current_period_start: renewalPeriod.start,
            current_period_end: renewalPeriod.end,
          },
          {
            id: `si_${TEST_PRICE_USAGE_PACK_100}`,
            price: { id: TEST_PRICE_USAGE_PACK_100 },
            quantity: 1,
            current_period_start: renewalPeriod.start,
            current_period_end: renewalPeriod.end,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      renewedSharedSubscription,
    );
    const invoiceId = `in_${randomUUID()}`;
    const packageInvoice = managedUsagePackInvoice(fixture, {
      invoiceId,
      quantities: new Map([[TEST_PRICE_USAGE_PACK_100, 1]]),
      billingPeriod: renewalPeriod,
    });
    await postManagedUsagePackEvent("invoice.paid", {
      ...packageInvoice,
      metadata: {},
      parent: {
        subscription_details: {
          subscription: fixture.subscriptionId,
          metadata: customMetadata,
        },
      },
      lines: {
        ...packageInvoice.lines,
        data: [
          {
            id: `il_${randomUUID()}`,
            amount: 0,
            subtotal: 0,
            quantity: 1,
            price: { id: TEST_PRICE_CUSTOM },
            period: renewalPeriod,
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { proration: false },
            },
          },
          ...packageInvoice.lines.data,
        ],
      },
    });

    const usagePackState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(usagePackState.fulfillmentInvoiceIds).toContain(invoiceId);
    expect(usagePackState.allocations).toContainEqual(
      expect.objectContaining({
        userId: actor.userId,
        status: "active",
        currentPeriodStart: new Date(renewalPeriod.start * 1000).toISOString(),
        currentPeriodEnd: new Date(renewalPeriod.end * 1000).toISOString(),
      }),
    );
    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("custom");
    expect(status.showUsagePack).toBeFalsy();
    expect(status.currentPeriodEnd).toBe(
      new Date(customPlanEnd * 1000).toISOString(),
    );

    await postManagedUsagePackEvent(
      "customer.subscription.updated",
      renewedSharedSubscription,
    );
    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      tier: "custom",
      showUsagePack: false,
    });

    await reconcileBillingOrganization(fixture.orgId);
    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      tier: "custom",
      showUsagePack: false,
    });
  });

  it("deactivates usage packs when a shared subscription becomes Custom-only", async () => {
    const actor = createOrgFixture();
    const fixture = await seedManagedUsagePack(
      [{ userId: actor.userId, usagePackUsd: 20 }],
      "team",
      actor,
    );
    mockEnv("OKOU_PRICE_CUSTOM", TEST_PRICE_CUSTOM);
    const customPlanEnd = fixture.billingPeriod.end + 365 * 86_400;
    const customMetadata = {
      orgId: fixture.orgId,
      purpose: "custom_plan_subscription",
      tier: "custom",
      usagePackSubscriptionId: fixture.usagePackSubscriptionId,
    };
    const customSubscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: customPlanEnd,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: customMetadata,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_CUSTOM}`,
            price: { id: TEST_PRICE_CUSTOM },
            quantity: 1,
            current_period_start: fixture.billingPeriod.start,
            current_period_end: fixture.billingPeriod.end,
          },
          {
            id: `si_${TEST_PRICE_CONCURRENCY}`,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 10,
            current_period_start: fixture.billingPeriod.start,
            current_period_end: fixture.billingPeriod.end,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      customSubscription,
    );

    await postManagedUsagePackEvent(
      "customer.subscription.updated",
      customSubscription,
    );

    const usagePackState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(usagePackState.subscription?.subscriptionStatus).toBe("canceled");
    expect(usagePackState.allocations).toContainEqual(
      expect.objectContaining({
        userId: actor.userId,
        status: "inactive",
      }),
    );
    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      tier: "custom",
      showUsagePack: false,
      currentPeriodEnd: new Date(customPlanEnd * 1000).toISOString(),
    });

    await postManagedUsagePackEvent(
      "customer.subscription.updated",
      customSubscription,
    );

    const replayedUsagePackState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(replayedUsagePackState.subscription?.subscriptionStatus).toBe(
      "canceled",
    );
    expect(replayedUsagePackState.allocations).toContainEqual(
      expect.objectContaining({
        userId: actor.userId,
        status: "inactive",
      }),
    );
    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      tier: "custom",
      showUsagePack: false,
      currentPeriodEnd: new Date(customPlanEnd * 1000).toISOString(),
    });
  });

  it("previews a Team upgrade by replacing only the base plan item", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const subscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    mockUsagePackSubscriptionChangePreviews(8000, 16_000);

    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackManagementContract,
      ).previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual(
      expect.objectContaining({
        sourceTier: "pro",
        targetTier: "team",
        immediateAmountCents: 8000,
        nextRecurringAmountCents: 18_000,
        currency: "usd",
      }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      2,
    );
    for (const [input] of context.mocks.stripe.invoices.createPreview.mock
      .calls) {
      expect(input).toStrictEqual(
        expect.objectContaining({
          subscription: fixture.subscriptionId,
          subscription_details: expect.objectContaining({
            items: [
              {
                id: "si_usage_pack_plan",
                price: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
                quantity: 1,
              },
            ],
          }),
        }),
      );
    }
  });

  it("previews an immediate usage pack upgrade while the Plan is ending", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId, usagePackUsd: 20 }],
      "team",
    );
    const endingSubscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      cancel_at: fixture.billingPeriod.end,
      cancel_at_period_end: true,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      endingSubscription,
    );
    await postManagedUsagePackEvent(
      "customer.subscription.updated",
      endingSubscription,
    );
    context.mocks.stripe.subscriptions.retrieve.mockClear();
    mockUsagePackChangePreviews(1500, 5000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );

    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: userId, targetUsagePackUsd: 50 },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual(
      expect.objectContaining({
        kind: "upgrade",
        sourceUsagePackUsd: 20,
        targetUsagePackUsd: 50,
        immediateAmountCents: 1500,
        nextRecurringAmountCents: 0,
        currency: "usd",
      }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: fixture.subscriptionId,
        preview_mode: "next",
        subscription_details: expect.objectContaining({
          cancel_at_period_end: false,
          proration_behavior: "always_invoice",
        }),
      }),
    );
  });

  it("keeps an immediate usage pack upgrade valid when the Plan cancellation webhook arrives during preview", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId, usagePackUsd: 20 }],
      "team",
    );
    const endingSubscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      cancel_at: fixture.billingPeriod.end,
      cancel_at_period_end: true,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      endingSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const createPreview =
      context.mocks.stripe.invoices.createPreview.getMockImplementation();
    if (!createPreview) {
      throw new Error("Usage pack preview mock is unavailable");
    }
    let cancellationSynchronized = false;
    context.mocks.stripe.invoices.createPreview.mockImplementation(
      async (input) => {
        if (!cancellationSynchronized) {
          cancellationSynchronized = true;
          context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
            endingSubscription,
          );
          await postManagedUsagePackEvent(
            "customer.subscription.updated",
            endingSubscription,
          );
        }
        return await createPreview(input);
      },
    );
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );

    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual(
      expect.objectContaining({
        sourceTier: "team",
        targetTier: "team",
        immediateAmountCents: 1500,
        nextRecurringAmountCents: 0,
        currency: "usd",
      }),
    );
    expect(cancellationSynchronized).toBeTruthy();
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.subscription?.cancelAtPeriodEnd).toBeTruthy();
  });

  it("rejects a deferred usage pack change when the Plan cancellation webhook arrives during preview", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId, usagePackUsd: 50 }],
      "team",
    );
    const activeSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
    );
    const endingSubscription = {
      ...activeSubscription,
      cancel_at: fixture.billingPeriod.end,
      cancel_at_period_end: true,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      activeSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 2000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_20,
    });
    const createPreview =
      context.mocks.stripe.invoices.createPreview.getMockImplementation();
    if (!createPreview) {
      throw new Error("Usage pack preview mock is unavailable");
    }
    let cancellationSynchronized = false;
    context.mocks.stripe.invoices.createPreview.mockImplementation(
      async (input) => {
        if (!cancellationSynchronized) {
          cancellationSynchronized = true;
          context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
            endingSubscription,
          );
          await postManagedUsagePackEvent(
            "customer.subscription.updated",
            endingSubscription,
          );
        }
        return await createPreview(input);
      },
    );
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );

    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [409],
    );

    expect(preview.body.error.message).toBe(
      "Your Plan is scheduled to end before this usage pack change can take effect. Restore your Plan first, then try again.",
    );
    expect(cancellationSynchronized).toBeTruthy();
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.subscription?.cancelAtPeriodEnd).toBeTruthy();
    expect(state.changes).toStrictEqual([]);
  });

  it("applies an immediate grouped usage pack upgrade without restoring the Plan", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId, usagePackUsd: 20 }],
      "team",
    );
    const endingSubscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      cancel_at: fixture.billingPeriod.end,
      cancel_at_period_end: true,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      endingSubscription,
    );
    await postManagedUsagePackEvent(
      "customer.subscription.updated",
      endingSubscription,
    );
    context.mocks.stripe.subscriptions.retrieve.mockClear();
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );

    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual(
      expect.objectContaining({
        sourceTier: "team",
        targetTier: "team",
        immediateAmountCents: 1500,
        nextRecurringAmountCents: 0,
        currency: "usd",
      }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: fixture.subscriptionId,
        preview_mode: "next",
        subscription_details: expect.objectContaining({
          cancel_at_period_end: false,
          proration_behavior: "always_invoice",
        }),
      }),
    );
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const invoice = {
      ...managedUsagePackUpgradeInvoice(fixture, {
        invoiceId: `in_${randomUUID()}`,
        sourcePriceId: TEST_PRICE_USAGE_PACK_20,
        targetPriceId: TEST_PRICE_USAGE_PACK_50,
        prorationTimestamp,
      }),
      status: "open" as const,
      paid: false,
    };
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...endingSubscription,
      pending_update: { expires_at: prorationTimestamp + 300 },
      latest_invoice: invoice,
    });

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("pending_payment");
    const updateParams =
      context.mocks.stripe.subscriptions.update.mock.calls[0]?.[1];
    expect(updateParams).not.toHaveProperty("cancel_at");
    expect(updateParams).not.toHaveProperty("cancel_at_period_end");
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.subscription?.cancelAtPeriodEnd).toBeTruthy();
  });

  it("asks to restore the Plan before scheduling a usage pack downgrade", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId, usagePackUsd: 50 }],
      "team",
    );
    const endingSubscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      ),
      cancel_at: fixture.billingPeriod.end,
      cancel_at_period_end: true,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      endingSubscription,
    );
    await postManagedUsagePackEvent(
      "customer.subscription.updated",
      endingSubscription,
    );
    context.mocks.stripe.subscriptions.retrieve.mockClear();
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const expectedMessage =
      "Your Plan is scheduled to end before this usage pack change can take effect. Restore your Plan first, then try again.";

    const allocationChange = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: userId, targetUsagePackUsd: 20 },
      }),
      [409],
    );
    expect(allocationChange.body.error.message).toBe(expectedMessage);

    const subscriptionChange = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [409],
    );
    expect(subscriptionChange.body.error.message).toBe(expectedMessage);
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("uses Stripe cancellation state when the Plan webhook is delayed", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId, usagePackUsd: 50 }],
      "team",
    );
    const endingSubscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      ),
      cancel_at: fixture.billingPeriod.end,
      cancel_at_period_end: true,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      endingSubscription,
    );
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const expectedMessage =
      "Your Plan is scheduled to end before this usage pack change can take effect. Restore your Plan first, then try again.";

    const allocationChange = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: userId, targetUsagePackUsd: 20 },
      }),
      [409],
    );
    expect(allocationChange.body.error.message).toBe(expectedMessage);

    const subscriptionChange = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [409],
    );
    expect(subscriptionChange.body.error.message).toBe(expectedMessage);
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      fixture.subscriptionId,
    );
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      fixture.subscriptionId,
      { expand: ["latest_invoice"] },
    );
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(
      (await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId))
        .subscription?.cancelAtPeriodEnd,
    ).toBeFalsy();
  });

  it("rejects an allocation downgrade when the Plan starts ending after preview", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId, usagePackUsd: 50 }],
      "team",
    );
    const activeSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      activeSubscription,
    );
    mockUsagePackChangePreviews(0, 2000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: userId, targetUsagePackUsd: 20 },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...activeSubscription,
      cancel_at: fixture.billingPeriod.end,
      cancel_at_period_end: true,
    });

    const confirmed = await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [409],
    );

    expect(confirmed.body.error.message).toBe(
      "Your Plan is scheduled to end before this usage pack change can take effect. Restore your Plan first, then try again.",
    );
    expect(
      (await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId))
        .changes,
    ).toStrictEqual([
      expect.objectContaining({
        kind: "downgrade",
        status: "failed",
      }),
    ]);
  });

  it("rejects a grouped downgrade when the Plan starts ending after preview", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId, usagePackUsd: 50 }],
      "team",
    );
    const activeSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      activeSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 2000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_20,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...activeSubscription,
      cancel_at: fixture.billingPeriod.end,
      cancel_at_period_end: true,
    });

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [409],
    );

    expect(confirmed.body.error.message).toBe(
      "Your Plan is scheduled to end before this usage pack change can take effect. Restore your Plan first, then try again.",
    );
    expect(
      (await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId))
        .changes,
    ).toStrictEqual([
      expect.objectContaining({
        kind: "downgrade",
        status: "failed",
      }),
    ]);
  });

  it("reopens the same pending subscription change without creating another preview", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const sourceSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      sourceSubscription,
    );
    mockUsagePackSubscriptionChangePreviews(8000, 16_000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const body = {
      targetTier: "team" as const,
      memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 as const }],
    };
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body,
      }),
      [200],
    );
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const invoice = {
      ...managedUsagePackUpgradeInvoice(fixture, {
        invoiceId: `in_${randomUUID()}`,
        sourcePriceId: TEST_PRICE_USAGE_PACK_PLAN_PRO,
        targetPriceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
        prorationTimestamp,
      }),
      status: "open" as const,
      paid: false,
    };
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...sourceSubscription,
      pending_update: { expires_at: prorationTimestamp + 300 },
      latest_invoice: invoice,
    });
    context.mocks.stripe.invoices.retrieve.mockResolvedValue(invoice);

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("pending_payment");

    const reopened = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body,
      }),
      [200],
    );
    expect(reopened.body).toStrictEqual(
      expect.objectContaining({
        changeId: preview.body.changeId,
        sourceTier: "pro",
        targetTier: "team",
        immediateAmountCents: 8000,
        nextRecurringAmountCents: 18_000,
      }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      2,
    );
    const differentChange = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
        },
      }),
      [409],
    );
    expect(differentChange.body.error.message).toBe(
      "Another usage pack billing change is in progress",
    );

    const reconfirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: reopened.body.changeId },
      }),
      [200],
    );
    expect(reconfirmed.body.status).toBe("pending_payment");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledOnce();
  });

  it("continues through a Stripe schedule with no future billing changes", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const scheduleId = `sub_sched_${randomUUID()}`;
    const sourceSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      fixture.billingPeriod,
      { scheduleId },
    );
    const scheduleItems = sourceSubscription.items.data.map((item) => {
      return { price: item.price.id, quantity: item.quantity };
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      sourceSubscription,
    );
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: fixture.billingPeriod.start,
        end_date: fixture.billingPeriod.end,
      },
      phases: [
        {
          start_date: fixture.billingPeriod.start,
          end_date: fixture.billingPeriod.end,
          items: scheduleItems,
        },
        {
          start_date: fixture.billingPeriod.end,
          end_date: fixture.billingPeriod.end + 30 * 86_400,
          items: scheduleItems,
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValue({
      id: scheduleId,
    });
    mockUsagePackSubscriptionChangePreviews(8000, 16_000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      customer: fixture.customerId,
      preview_mode: "recurring",
      subscription_details: {
        items: [
          { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
          { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
        ],
      },
    });
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const invoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      sourcePriceId: TEST_PRICE_USAGE_PACK_PLAN_PRO,
      targetPriceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
      prorationTimestamp,
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...sourceSubscription,
      schedule: null,
      latest_invoice: invoice,
      items: {
        data: sourceSubscription.items.data.map((item) => {
          return item.price.id === TEST_PRICE_USAGE_PACK_PLAN_PRO
            ? {
                ...item,
                price: { ...item.price, id: TEST_PRICE_USAGE_PACK_PLAN_TEAM },
              }
            : item;
        }),
      },
    });

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );

    expect(confirmed.body.status).toBe("processing");
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledOnce();
  });

  it("replaces an unconfirmed package change preview", async () => {
    mockNow(new Date("2035-01-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const body = {
      targetTier: "pro" as const,
      memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 as const }],
    };

    const first = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body,
      }),
      [200],
    );
    expect(first.body.immediateCreditGrant).toStrictEqual({
      purchasedCredits: 15_000,
      bonusCredits: 1100,
      totalCredits: 16_100,
      expiresAt: new Date(fixture.billingPeriod.end * 1000).toISOString(),
    });
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.allocations[0]?.pendingChange).toBeNull();
    const second = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body,
      }),
      [200],
    );

    expect(second.body.changeId).not.toBe(first.body.changeId);
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      4,
    );
  });

  it("upgrades the base plan in place without replacing the member package", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const quantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
    const proSubscription = managedUsagePackSubscription(fixture, quantities);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      proSubscription,
    );
    mockUsagePackSubscriptionChangePreviews(8000, 16_000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    const grantsBefore = (
      await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId)
    ).grants;
    const invoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      sourcePriceId: TEST_PRICE_USAGE_PACK_PLAN_PRO,
      targetPriceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
      prorationTimestamp: Math.floor(
        new Date(preview.body.prorationDate).getTime() / 1000,
      ),
    });
    const teamSubscription = {
      ...proSubscription,
      latest_invoice: invoice,
      items: {
        data: proSubscription.items.data.map((item) => {
          return item.price.id === TEST_PRICE_USAGE_PACK_PLAN_PRO
            ? {
                ...item,
                price: {
                  ...item.price,
                  id: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
                },
              }
            : item;
        }),
      },
    };
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(proSubscription)
      .mockResolvedValue(teamSubscription);
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      teamSubscription,
    );

    const response = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "processing",
      effectiveAt: preview.body.prorationDate,
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [
          {
            id: "si_usage_pack_plan",
            price: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
            quantity: 1,
          },
        ],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: Math.floor(
          new Date(preview.body.prorationDate).getTime() / 1000,
        ),
        expand: ["latest_invoice.payment_intent"],
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(
          "usage-pack-subscription-change:",
        ),
      }),
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    await postManagedUsagePackEvent("invoice.paid", invoice);
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.org?.tier).toBe("team");
    expect(state.allocations).toHaveLength(1);
    expect(state.allocations[0]).toStrictEqual(
      expect.objectContaining({
        usagePackUsd: 20,
        stripePriceId: TEST_PRICE_USAGE_PACK_20,
      }),
    );
    expect(state.grants).toStrictEqual(grantsBefore);
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.tier).toBe("team");
  });

  it("activates a pending plan upgrade from the paid invoice webhook", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const quantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
    const proSubscription = managedUsagePackSubscription(fixture, quantities);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      proSubscription,
    );
    mockUsagePackSubscriptionChangePreviews(8000, 16_000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const paidInvoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      sourcePriceId: TEST_PRICE_USAGE_PACK_PLAN_PRO,
      targetPriceId: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
      prorationTimestamp,
    });
    const pendingSubscription = {
      ...proSubscription,
      pending_update: { expires_at: prorationTimestamp + 60 },
      latest_invoice: { ...paidInvoice, status: "open" },
    };
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      pendingSubscription,
    );
    const grantsBefore = (
      await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId)
    ).grants;

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "pending_payment",
      effectiveAt: preview.body.prorationDate,
      hostedInvoiceUrl: paidInvoice.hosted_invoice_url,
    });
    await postManagedUsagePackEvent(
      "customer.subscription.updated",
      pendingSubscription,
    );
    const pendingState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(pendingState.org?.tier).toBe("pro");

    const teamSubscription = {
      ...proSubscription,
      latest_invoice: paidInvoice,
      items: {
        data: proSubscription.items.data.map((item) => {
          return item.price.id === TEST_PRICE_USAGE_PACK_PLAN_PRO
            ? {
                ...item,
                price: {
                  ...item.price,
                  id: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
                },
              }
            : item;
        }),
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      teamSubscription,
    );
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);

    const completedState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(completedState.org?.tier).toBe("team");
    expect(completedState.allocations).toHaveLength(1);
    expect(completedState.grants).toStrictEqual(grantsBefore);
  });

  it("retries a grouped subscription change after a Stripe failure", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const sourceSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      sourceSubscription,
    );
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: fixture.customerId,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
          supportsInAppPreview: true,
          returnUrl: `${APP_ORIGIN}/billing`,
        },
      }),
      [200],
    );
    expect(preview.body).not.toHaveProperty("checkoutUrl");
    expect(preview.body).not.toHaveProperty("paymentMethodPreviewToken");
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const invoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      prorationTimestamp,
    });
    context.mocks.stripe.subscriptions.update
      .mockRejectedValueOnce(new Error("temporary Stripe failure"))
      .mockResolvedValue({
        ...sourceSubscription,
        pending_update: { expires_at: prorationTimestamp + 300 },
        latest_invoice: { ...invoice, status: "open" },
      });

    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [500],
    );
    const applying = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(applying.changes[0]?.status).toBe("applying");

    const retried = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );

    expect(retried.body.status).toBe("pending_payment");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(2);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      2,
      fixture.subscriptionId,
      expect.objectContaining({
        payment_behavior: "pending_if_incomplete",
        proration_date: prorationTimestamp,
      }),
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:apply`,
      },
    );
  });

  it("updates a member package without relying on main plan metadata", async () => {
    mockNow(new Date("2035-01-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const paymentMethodId = `pm_${randomUUID()}`;
    const oldSubscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      default_payment_method: paymentMethodId,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      oldSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
          supportsInAppPreview: true,
          returnUrl: `${APP_ORIGIN}/billing`,
        },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual(
      expect.objectContaining({
        sourceTier: "pro",
        targetTier: "pro",
        immediateAmountCents: 1500,
        nextRecurringAmountCents: 5000,
        paymentMethodPreviewToken: expect.any(String),
      }),
    );
    const paymentMethodPreviewToken = preview.body.paymentMethodPreviewToken;
    if (!paymentMethodPreviewToken) {
      throw new Error("Expected a saved-payment-method preview token");
    }
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const invoiceId = `in_${randomUUID()}`;
    const paidInvoiceBase = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      prorationTimestamp,
    });
    const paidInvoice = {
      ...paidInvoiceBase,
      metadata: {},
      parent: {
        ...paidInvoiceBase.parent,
        subscription_details: {
          ...paidInvoiceBase.parent.subscription_details,
          metadata: {
            purpose: "usage_pack_subscription",
            usagePackSubscriptionId: randomUUID(),
          },
        },
      },
    };
    const upgradedSubscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      ),
      metadata: { purpose: "custom_plan_subscription" },
    };
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(oldSubscription)
      .mockResolvedValueOnce(oldSubscription)
      .mockResolvedValue(upgradedSubscription);
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...oldSubscription,
      pending_update: { expires_at: prorationTimestamp + 300 },
      latest_invoice: { ...paidInvoice, status: "open" },
    });

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          changeId: preview.body.changeId,
          paymentMethodPreviewToken,
        },
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("pending_payment");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      1,
      fixture.subscriptionId,
      {
        default_payment_method: paymentMethodId,
      },
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      2,
      fixture.subscriptionId,
      expect.objectContaining({
        items: expect.arrayContaining([
          { id: `si_${TEST_PRICE_USAGE_PACK_20}`, deleted: true },
          { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
        ]),
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: prorationTimestamp,
      }),
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:apply`,
      },
    );

    await postManagedUsagePackEvent(
      "customer.subscription.updated",
      upgradedSubscription,
    );
    const reflected = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(reflected.changes).toContainEqual(
      expect.objectContaining({ kind: "upgrade", status: "applied" }),
    );

    const subscriptionUpdateCount =
      context.mocks.stripe.subscriptions.update.mock.calls.length;
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(
      subscriptionUpdateCount,
    );
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ usagePackUsd: 20, status: "inactive" }),
        expect.objectContaining({ usagePackUsd: 50, status: "active" }),
      ]),
    );
    expect(state.grants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grantType: "purchased",
          originalAmount: 15_000,
        }),
        expect.objectContaining({
          grantType: "bonus",
          originalAmount: 1100,
        }),
      ]),
    );
    expect(state.grants).toHaveLength(4);
    expect(state.changes).toContainEqual(
      expect.objectContaining({ kind: "upgrade", status: "completed" }),
    );
  });

  it("adds an active member package to the existing subscription", async () => {
    mockNow(new Date("2035-01-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const orgFixture = createOrgFixture();
    const addedUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId: orgFixture.userId, usagePackUsd: 20 }],
      "pro",
      orgFixture,
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: orgFixture.userId },
            createdAt: now(),
          },
          {
            role: "org:member",
            publicUserData: { userId: addedUserId },
            createdAt: now(),
          },
        ],
      },
    );
    const oldSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      oldSubscription,
    );
    mockUsagePackSubscriptionAdditionPreviews({
      immediateAmountCents: 2500,
      nextRecurringAmountCents: 7000,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.supportsMemberAdditions).toBeTruthy();

    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: orgFixture.userId, usagePackUsd: 20 },
            { memberId: addedUserId, usagePackUsd: 50 },
          ],
        },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual(
      expect.objectContaining({
        immediateAmountCents: 2500,
        nextRecurringAmountCents: 7000,
        immediateCreditGrant: {
          purchasedCredits: 25_000,
          bonusCredits: 1300,
          totalCredits: 26_300,
          expiresAt: new Date(fixture.billingPeriod.end * 1000).toISOString(),
        },
      }),
    );
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const paidInvoice = managedUsagePackAdditionInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      prorationTimestamp,
    });
    const updatedSubscription = managedUsagePackSubscription(
      fixture,
      new Map([
        [TEST_PRICE_USAGE_PACK_20, 1],
        [TEST_PRICE_USAGE_PACK_50, 1],
      ]),
    );
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(oldSubscription)
      .mockResolvedValue(updatedSubscription);
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...oldSubscription,
      pending_update: { expires_at: prorationTimestamp + 300 },
      latest_invoice: { ...paidInvoice, status: "open" },
    });

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("pending_payment");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      expect.objectContaining({
        items: [{ price: TEST_PRICE_USAGE_PACK_50, quantity: 1 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: prorationTimestamp,
      }),
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:apply`,
      },
    );

    await postManagedUsagePackEvent("invoice.paid", paidInvoice);
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: orgFixture.userId,
          usagePackUsd: 20,
          status: "active",
        }),
        expect.objectContaining({
          userId: addedUserId,
          usagePackUsd: 50,
          status: "active",
        }),
      ]),
    );
    expect(state.grants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: addedUserId,
          grantType: "purchased",
          originalAmount: 25_000,
        }),
        expect.objectContaining({
          userId: addedUserId,
          grantType: "bonus",
          originalAmount: 1300,
        }),
      ]),
    );
  });

  it("rejects adding a user who is not an active organization member", async () => {
    const orgFixture = createOrgFixture();
    const unknownUserId = `user_${randomUUID()}`;
    await seedManagedUsagePack(
      [{ userId: orgFixture.userId, usagePackUsd: 20 }],
      "pro",
      orgFixture,
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: orgFixture.userId },
            createdAt: now(),
          },
        ],
      },
    );
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );

    const response = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: orgFixture.userId, usagePackUsd: 20 },
            { memberId: unknownUserId, usagePackUsd: 50 },
          ],
        },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Organization members changed; refresh billing and try again",
        code: "BAD_REQUEST",
      },
    });
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
  });

  it("restores a scheduled package downgrade", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 50 }]);
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackChangePreviews(0, 2000);
    const scheduleId = "sub_sched_usage_pack_restore";
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const downgradePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    const downgrade = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: downgradePreview.body.changeId },
      }),
      [200],
    );
    expect(downgrade.body.status).toBe("scheduled");

    const scheduledSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      fixture.billingPeriod,
      { scheduleId },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      scheduledSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      rejectScheduledSubscriptionRecurringPreview: true,
    });
    context.mocks.stripe.invoices.createPreview.mockClear();
    const nextPeriodEnd = fixture.billingPeriod.end + 30 * 86_400;
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: fixture.billingPeriod.start,
        end_date: fixture.billingPeriod.end,
      },
      phases: [
        {
          start_date: fixture.billingPeriod.start,
          end_date: fixture.billingPeriod.end,
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
          ],
        },
        {
          start_date: fixture.billingPeriod.end,
          end_date: nextPeriodEnd,
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
          ],
        },
      ],
    });
    const restorePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );
    expect(restorePreview.body).toStrictEqual(
      expect.objectContaining({
        sourceTier: "pro",
        targetTier: "pro",
        immediateAmountCents: 0,
        nextRecurringAmountCents: 5000,
      }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      customer: fixture.customerId,
      preview_mode: "recurring",
      subscription_details: {
        items: [
          { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
          { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
        ],
      },
    });

    context.mocks.stripe.subscriptionSchedules.update.mockClear();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const restored = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: restorePreview.body.changeId },
      }),
      [200],
    );
    expect(restored.body).toStrictEqual({
      status: "completed",
      effectiveAt: expect.any(String),
      hostedInvoiceUrl: null,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: fixture.billingPeriod.start,
            end_date: fixture.billingPeriod.end,
            items: [
              { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: fixture.billingPeriod.end,
            end_date: nextPeriodEnd,
            items: [
              { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
            ],
            proration_behavior: "none",
          },
        ],
      },
      {
        idempotencyKey: `usage-pack-subscription-change:${restorePreview.body.changeId}:restore-schedule`,
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.allocations).toStrictEqual([
      expect.objectContaining({ usagePackUsd: 50, status: "active" }),
    ]);
    expect(state.changes).toStrictEqual([
      expect.objectContaining({
        status: "failed",
        sourceUsagePackUsd: 50,
        targetUsagePackUsd: 20,
      }),
    ]);
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.allocations[0]?.pendingChange).toBeNull();

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      scheduledSubscription,
    );
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: fixture.billingPeriod.start,
        end_date: fixture.billingPeriod.end,
      },
      phases: [
        {
          start_date: fixture.billingPeriod.start,
          end_date: fixture.billingPeriod.end,
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
          ],
        },
        {
          start_date: fixture.billingPeriod.end,
          end_date: nextPeriodEnd,
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
          ],
        },
      ],
    });
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 5000,
      nextRecurringAmountCents: 10_000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_100,
      rejectScheduledSubscriptionRecurringPreview: true,
    });
    const nextPreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 100 }],
        },
      }),
      [200],
    );
    expect(nextPreview.body.nextRecurringAmountCents).toBe(10_000);
  });

  it("restores a usage pack change without removing the Plan cancellation", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 50 }]);
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 2000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_20,
    });
    const scheduleId = `sub_sched_usage_pack_plan_end_${randomUUID()}`;
    const allowanceCancelAt = new Date(
      fixture.billingPeriod.end * 1000,
    ).toISOString();
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const downgradePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: downgradePreview.body.changeId },
      }),
      [200],
    );

    const baseScheduledSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      fixture.billingPeriod,
      { scheduleId },
    );
    const scheduledSubscription = {
      ...baseScheduledSubscription,
      metadata: {
        ...baseScheduledSubscription.metadata,
        allowanceStatus: "canceled",
        allowanceCancelAt,
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      scheduledSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      rejectScheduledSubscriptionRecurringPreview: true,
    });
    const planEnd = fixture.billingPeriod.end + 60 * 86_400;
    const schedule = {
      id: scheduleId,
      end_behavior: "cancel" as const,
      current_phase: {
        start_date: fixture.billingPeriod.start,
        end_date: fixture.billingPeriod.end,
      },
      phases: [
        {
          start_date: fixture.billingPeriod.start,
          end_date: fixture.billingPeriod.end,
          currency: "usd",
          metadata: { planState: "ending" },
          discounts: [{ coupon: "coupon_plan" }],
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
            {
              price: TEST_PRICE_USAGE_PACK_50,
              quantity: 1,
              metadata: { member: userId },
              tax_rates: ["txr_usage_pack"],
            },
          ],
        },
        {
          start_date: fixture.billingPeriod.end,
          end_date: planEnd,
          currency: "usd",
          metadata: { planState: "ending" },
          discounts: [{ coupon: "coupon_plan" }],
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
          ],
        },
      ],
    };
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      schedule,
    );
    const restorePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const restored = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: restorePreview.body.changeId },
      }),
      [200],
    );

    expect(restored.body.status).toBe("completed");
    const restoredPackage = {
      price: TEST_PRICE_USAGE_PACK_50,
      quantity: 1,
      metadata: { member: userId },
      tax_rates: ["txr_usage_pack"],
    };
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "cancel",
        proration_behavior: "none",
        phases: [
          {
            start_date: fixture.billingPeriod.start,
            end_date: fixture.billingPeriod.end,
            currency: "usd",
            items: [
              { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
              restoredPackage,
            ],
            metadata: {
              planState: "ending",
              allowanceStatus: "canceled",
              allowanceCancelAt,
            },
            proration_behavior: "none",
            discounts: [{ coupon: "coupon_plan" }],
          },
          {
            start_date: fixture.billingPeriod.end,
            end_date: planEnd,
            currency: "usd",
            items: [
              { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
              restoredPackage,
            ],
            metadata: {
              planState: "ending",
              allowanceStatus: "canceled",
              allowanceCancelAt,
            },
            proration_behavior: "none",
            discounts: [{ coupon: "coupon_plan" }],
          },
        ],
      },
      {
        idempotencyKey: `usage-pack-subscription-change:${restorePreview.body.changeId}:restore-schedule`,
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.allocations).toStrictEqual([
      expect.objectContaining({ usagePackUsd: 50, status: "active" }),
    ]);
    expect(state.changes).toStrictEqual([
      expect.objectContaining({
        status: "failed",
        sourceUsagePackUsd: 50,
        targetUsagePackUsd: 20,
      }),
    ]);
  });

  it("clears scheduled package changes when restoring a plan downgrade", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId, usagePackUsd: 100 }],
      "team",
    );
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_100, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 2000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_100,
      targetPriceId: TEST_PRICE_USAGE_PACK_20,
    });
    const scheduleId = `sub_sched_restore_${randomUUID()}`;
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const managementClient = setupApp({
      context,
      routes: billingCheckoutRoutes,
    })(billingUsagePackManagementContract);
    const downgradePreview = await accept(
      managementClient.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    const downgrade = await accept(
      managementClient.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: downgradePreview.body.changeId },
      }),
      [200],
    );
    expect(downgrade.body.status).toBe("scheduled");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_100, 1]]),
        fixture.billingPeriod,
        { scheduleId },
      ),
      default_payment_method: "pm_test",
    });
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValue({
      id: scheduleId,
    });
    const restore = await accept(
      setupApp({ context, routes: billingRestoreRoutes })(
        billingRestoreContract,
      ).create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(restore.body).toStrictEqual({ status: "restored" });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId);
    expect(
      (await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId))
        .changes,
    ).toStrictEqual([
      expect.objectContaining({
        status: "failed",
        sourceUsagePackUsd: 100,
        targetUsagePackUsd: 20,
      }),
    ]);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 10_000,
      nextRecurringAmountCents: 20_000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_100,
      targetPriceId: TEST_PRICE_USAGE_PACK_200,
    });
    await accept(
      managementClient.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 200 }],
        },
      }),
      [200],
    );
  });

  it("clears scheduled package changes when Stripe releases their schedule", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 50 }]);
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 2000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_20,
    });
    const scheduleId = `sub_sched_released_${randomUUID()}`;
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const downgradePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: downgradePreview.body.changeId },
      }),
      [200],
    );

    await postManagedUsagePackEvent("subscription_schedule.released", {
      id: scheduleId,
    });
    expect(
      (await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId))
        .changes,
    ).toStrictEqual([
      expect.objectContaining({
        status: "failed",
        sourceUsagePackUsd: 50,
        targetUsagePackUsd: 20,
      }),
    ]);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 5000,
      nextRecurringAmountCents: 10_000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_100,
    });
    await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 100 }],
        },
      }),
      [200],
    );
  });

  it("keeps scheduled package changes when Stripe releases after their effective time", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 50 }]);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      ),
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 2000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_20,
    });
    const scheduleId = `sub_sched_completed_${randomUUID()}`;
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );

    await postManagedUsagePackEvent(
      "subscription_schedule.released",
      { id: scheduleId },
      fixture.billingPeriod.end + 1,
    );
    expect(
      (await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId))
        .changes,
    ).toStrictEqual([
      expect.objectContaining({
        status: "scheduled",
        sourceUsagePackUsd: 50,
        targetUsagePackUsd: 20,
      }),
    ]);
  });

  it("replaces a scheduled package downgrade on the existing schedule", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 200 }]);
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_200, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_200,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const scheduleId = "sub_sched_usage_pack_replace";
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const downgradePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );
    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: downgradePreview.body.changeId },
      }),
      [200],
    );

    const scheduledSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_200, 1]]),
      fixture.billingPeriod,
      { scheduleId },
    );
    const scheduledPackageDowngrade = {
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: fixture.billingPeriod.start,
        end_date: fixture.billingPeriod.end,
      },
      phases: [
        {
          start_date: fixture.billingPeriod.start,
          end_date: fixture.billingPeriod.end,
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_200, quantity: 1 },
          ],
        },
        {
          start_date: fixture.billingPeriod.end,
          end_date: fixture.billingPeriod.end + 30 * 86_400,
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
          ],
        },
      ],
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      scheduledSubscription,
    );
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      scheduledPackageDowngrade,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 10_000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_200,
      targetPriceId: TEST_PRICE_USAGE_PACK_100,
      rejectScheduledSubscriptionRecurringPreview: true,
    });
    context.mocks.stripe.invoices.createPreview.mockClear();
    const replacementPreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 100 }],
        },
      }),
      [200],
    );
    expect(replacementPreview.body).toStrictEqual(
      expect.objectContaining({
        immediateAmountCents: 0,
        nextRecurringAmountCents: 10_000,
      }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: scheduleId,
        preview_mode: "next",
        schedule_details: expect.objectContaining({
          phases: expect.arrayContaining([
            expect.objectContaining({
              start_date: fixture.billingPeriod.end,
              items: expect.arrayContaining([
                { price: TEST_PRICE_USAGE_PACK_100, quantity: 1 },
              ]),
            }),
          ]),
        }),
      }),
    );
    const beforeConfirmation = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      beforeConfirmation.body.allocations[0]?.pendingChange?.targetUsagePackUsd,
    ).toBe(50);

    const replacement = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: replacementPreview.body.changeId },
      }),
      [200],
    );
    expect(replacement.body.status).toBe("scheduled");
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenLastCalledWith(
      scheduleId,
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            start_date: fixture.billingPeriod.end,
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_100, quantity: 1 },
            ]),
          }),
        ]),
      }),
      {
        idempotencyKey: `usage-pack-subscription-change:${replacementPreview.body.changeId}:schedule-update`,
      },
    );
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.changes).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          sourceUsagePackUsd: 200,
          targetUsagePackUsd: 50,
        }),
        expect.objectContaining({
          status: "scheduled",
          sourceUsagePackUsd: 200,
          targetUsagePackUsd: 100,
        }),
      ]),
    );
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(
      management.body.allocations[0]?.pendingChange?.targetUsagePackUsd,
    ).toBe(100);

    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 20_000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_200,
      targetPriceId: TEST_PRICE_USAGE_PACK_200,
      rejectScheduledSubscriptionRecurringPreview: true,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      ...scheduledPackageDowngrade,
      phases: [
        scheduledPackageDowngrade.phases[0],
        {
          ...scheduledPackageDowngrade.phases[1],
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_100, quantity: 1 },
          ],
        },
      ],
    });
    const restorePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 200 }],
        },
      }),
      [200],
    );
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: restorePreview.body.changeId },
      }),
      [200],
    );
    const restoredManagement = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(restoredManagement.body.allocations[0]?.pendingChange).toBeNull();
  });

  it("expires an unpaid pending subscription update", async () => {
    const initialNow = new Date("2035-02-16T00:00:00.000Z");
    mockNow(initialNow);
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const sourceSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      sourceSubscription,
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );
    const invoiceId = `in_${randomUUID()}`;
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const openInvoice = {
      ...managedUsagePackUpgradeInvoice(fixture, {
        invoiceId,
        sourcePriceId: TEST_PRICE_USAGE_PACK_20,
        targetPriceId: TEST_PRICE_USAGE_PACK_50,
        prorationTimestamp,
      }),
      status: "open",
      paid: false,
    };
    const pendingSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      fixture.billingPeriod,
      {
        latestInvoice: openInvoice,
        pendingUpdateExpiresAt: prorationTimestamp + 300,
      },
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      pendingSubscription,
    );

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );
    expect(confirmed.body).toStrictEqual({
      status: "pending_payment",
      effectiveAt: preview.body.prorationDate,
      hostedInvoiceUrl: openInvoice.hosted_invoice_url,
    });

    mockNow(new Date(initialNow.getTime() + 25 * 60 * 60 * 1000));
    const expiredSubscription = {
      ...sourceSubscription,
      latest_invoice: openInvoice,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      expiredSubscription,
    );
    await reconcileBillingOrganization(fixture.orgId);
    expect(context.mocks.stripe.invoices.voidInvoice).toHaveBeenCalledWith(
      invoiceId,
      {},
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:void`,
      },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalledWith(
      fixture.subscriptionId,
      expect.objectContaining({ proration_behavior: "none" }),
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:rollback`,
      },
    );
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.org?.tier).toBe("pro");
    expect(state.changes).toStrictEqual([
      expect.objectContaining({
        status: "failed",
        sourceUsagePackUsd: 20,
        targetUsagePackUsd: 50,
      }),
    ]);
    expect(state.allocations).toStrictEqual([
      expect.objectContaining({ usagePackUsd: 20, status: "active" }),
    ]);
    expect(state.grants).toHaveLength(2);
  });

  it("schedules a Team to Pro subscription change at the billing boundary", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId, usagePackUsd: 20 }],
      "team",
    );
    const subscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    mockUsagePackSubscriptionChangePreviews(0, 0);
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: "sub_sched_team_to_pro",
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: "sub_sched_team_to_pro",
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );

    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual(
      expect.objectContaining({
        sourceTier: "team",
        targetTier: "pro",
        immediateAmountCents: 0,
        nextRecurringAmountCents: 2000,
        effectiveAt: new Date(fixture.billingPeriod.end * 1000).toISOString(),
      }),
    );

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );
    expect(confirmed.body).toStrictEqual({
      status: "scheduled",
      effectiveAt: new Date(fixture.billingPeriod.end * 1000).toISOString(),
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      "sub_sched_team_to_pro",
      expect.objectContaining({
        phases: [
          expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({
                price: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
              }),
              expect.objectContaining({ price: TEST_PRICE_USAGE_PACK_20 }),
            ]),
          }),
          expect.objectContaining({
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            ]),
          }),
        ],
      }),
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:schedule-update`,
      },
    );
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.org?.tier).toBe("team");
    expect(state.allocations).toStrictEqual([
      expect.objectContaining({ usagePackUsd: 20, status: "active" }),
    ]);
  });

  it("merges a Team to Pro change into a scheduled concurrency reduction", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId, usagePackUsd: 20 }],
      "team",
    );
    const scheduleId = `sub_sched_${randomUUID()}`;
    const sourceSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      fixture.billingPeriod,
      { scheduleId },
    );
    const concurrencyItem = {
      id: "si_concurrency",
      price: {
        id: TEST_PRICE_CONCURRENCY,
        recurring: { interval: "month" as const, interval_count: 1 },
      },
      quantity: 10,
      current_period_start: fixture.billingPeriod.start,
      current_period_end: fixture.billingPeriod.end,
    };
    const subscription = {
      ...sourceSubscription,
      items: {
        data: [...sourceSubscription.items.data, concurrencyItem],
      },
    };
    const futureEnd = fixture.billingPeriod.end + 30 * 86_400;
    const schedule = {
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: fixture.billingPeriod.start,
        end_date: fixture.billingPeriod.end,
      },
      phases: [
        {
          start_date: fixture.billingPeriod.start,
          end_date: fixture.billingPeriod.end,
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 10 },
          ],
        },
        {
          start_date: fixture.billingPeriod.end,
          end_date: futureEnd,
          currency: "usd",
          metadata: {
            allowanceCancelAt: "2035-06-01T00:00:00.000Z",
            allowanceStatus: "canceled",
          },
          discounts: [{ coupon: "coupon_scheduled" }],
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            {
              price: TEST_PRICE_CONCURRENCY,
              quantity: 5,
              metadata: { source: "scheduled" },
              tax_rates: ["txr_scheduled"],
            },
          ],
        },
      ],
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      ...schedule,
      phases: schedule.phases.map((phase, index) => {
        return index === 0
          ? phase
          : {
              ...phase,
              items: [
                { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
                { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
                { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
              ],
            };
      }),
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    mockUsagePackSubscriptionChangePreviews(0, 2000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );

    const conflict = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [409],
    );
    expect(conflict.body.error.message).toBe(
      "Another usage pack billing change is in progress",
    );
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      schedule,
    );

    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: scheduleId,
        preview_mode: "next",
        schedule_details: expect.objectContaining({
          phases: expect.arrayContaining([
            expect.objectContaining({
              start_date: fixture.billingPeriod.end,
              items: expect.arrayContaining([
                expect.objectContaining({
                  price: TEST_PRICE_CONCURRENCY,
                  quantity: 5,
                }),
                { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
              ]),
            }),
          ]),
        }),
      }),
    );
    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );

    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: fixture.billingPeriod.start,
            end_date: fixture.billingPeriod.end,
            items: [
              { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 10 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: fixture.billingPeriod.end,
            end_date: futureEnd,
            currency: "usd",
            items: [
              {
                price: TEST_PRICE_CONCURRENCY,
                quantity: 5,
                metadata: { source: "scheduled" },
                tax_rates: ["txr_scheduled"],
              },
              { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            ],
            metadata: {
              allowanceCancelAt: "2035-06-01T00:00:00.000Z",
              allowanceStatus: "canceled",
            },
            proration_behavior: "none",
            discounts: [{ coupon: "coupon_scheduled" }],
          },
        ],
      },
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:schedule-update`,
      },
    );
  });

  it("revises a pending Team to Pro schedule when the package total increases from $20 to $40", async () => {
    const actor = createOrgFixture();
    const addedUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack(
      [{ userId: actor.userId, usagePackUsd: 20 }],
      "team",
      actor,
    );
    const scheduleId = `sub_sched_${randomUUID()}`;
    const sourceSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      sourceSubscription,
    );
    mockUsagePackSubscriptionChangePreviews(0, 0);
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );

    const downgradePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: actor.userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: downgradePreview.body.changeId },
      }),
      [200],
    );

    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: actor.userId },
            createdAt: now(),
          },
          {
            role: "org:member",
            publicUserData: { userId: addedUserId },
            createdAt: now(),
          },
        ],
      },
    );
    const scheduledSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      fixture.billingPeriod,
      { scheduleId },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      scheduledSubscription,
    );
    mockUsagePackSubscriptionAdditionPreviews({
      immediateAmountCents: 2500,
      nextRecurringAmountCents: 4000,
      targetPriceId: TEST_PRICE_USAGE_PACK_20,
    });

    const packagePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: actor.userId, usagePackUsd: 20 },
            { memberId: addedUserId, usagePackUsd: 20 },
          ],
        },
      }),
      [200],
    );
    expect(packagePreview.body).toStrictEqual(
      expect.objectContaining({
        sourceTier: "team",
        targetTier: "pro",
        immediateAmountCents: 2500,
        nextRecurringAmountCents: 4000,
        effectiveAt: new Date(fixture.billingPeriod.end * 1000).toISOString(),
      }),
    );
    const prorationTimestamp = Math.floor(
      new Date(packagePreview.body.prorationDate).getTime() / 1000,
    );
    const paidInvoice = managedUsagePackAdditionInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      targetPriceId: TEST_PRICE_USAGE_PACK_20,
      prorationTimestamp,
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...scheduledSubscription,
      pending_update: { expires_at: prorationTimestamp + 300 },
      latest_invoice: { ...paidInvoice, status: "open" },
    });

    const confirmed = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: packagePreview.body.changeId },
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("pending_payment");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      expect.objectContaining({
        items: [{ id: `si_${TEST_PRICE_USAGE_PACK_20}`, quantity: 2 }],
      }),
      {
        idempotencyKey: `usage-pack-subscription-change:${packagePreview.body.changeId}:apply`,
      },
    );

    const updatedSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
      fixture.billingPeriod,
      { scheduleId },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      updatedSubscription,
    );
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);

    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenLastCalledWith(
      scheduleId,
      expect.objectContaining({
        phases: [
          expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({
                price: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
              }),
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 2 },
            ]),
          }),
          expect.objectContaining({
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 2 },
            ]),
          }),
        ],
      }),
      {
        idempotencyKey: `usage-pack-subscription-change:${packagePreview.body.changeId}:schedule-update`,
      },
    );
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.tier).toBe("team");
    expect(management.body.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: actor.userId,
          pendingChange: null,
          usagePackUsd: 20,
        }),
        expect.objectContaining({
          memberId: addedUserId,
          pendingChange: null,
          usagePackUsd: 20,
        }),
      ]),
    );
  });

  it("serializes concurrent package previews across an organization", async () => {
    const firstUserId = `user_${randomUUID()}`;
    const secondUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([
      { userId: firstUserId, usagePackUsd: 20 },
      { userId: secondUserId, usagePackUsd: 20 },
    ]);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
      ),
    );
    mockUsagePackChangePreviews(1500, 7000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );

    const responses = await Promise.all(
      [firstUserId, secondUserId].map((memberId) => {
        return client.previewChange({
          headers: { authorization: "Bearer clerk-session" },
          body: { memberId, targetUsagePackUsd: 50 },
        });
      }),
    );
    expect(
      responses.map((response) => {
        return response.status;
      }),
    ).toStrictEqual(expect.arrayContaining([200, 409]));
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.changes).toHaveLength(1);
    expect(state.changes[0]?.status).toBe("previewed");
  });

  it("applies a paid upgrade once with the preview proration date", async () => {
    mockNow(new Date("2035-01-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const fixture = await seedManagedUsagePack([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
    ]);
    const sourceUserId =
      (await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId))
        .allocations[0]?.userId ?? "";
    const oldQuantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
    const newQuantities = new Map([[TEST_PRICE_USAGE_PACK_50, 1]]);
    const oldSubscription = managedUsagePackSubscription(
      fixture,
      oldQuantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      oldSubscription,
    );
    mockUsagePackChangePreviews(1500, 5000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );

    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: sourceUserId, targetUsagePackUsd: 50 },
      }),
      [200],
    );
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const pendingInvoiceId = `in_${randomUUID()}`;
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...oldSubscription,
      pending_update: { expires_at: prorationTimestamp + 300 },
      latest_invoice: {
        id: pendingInvoiceId,
        status: "open",
        hosted_invoice_url: `https://invoice.stripe.test/${pendingInvoiceId}`,
      },
    });

    const confirmed = await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("pending_payment");
    const reopened = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: sourceUserId, targetUsagePackUsd: 50 },
      }),
      [200],
    );
    expect(reopened.body.changeId).toBe(preview.body.changeId);
    const duplicateConfirmation = await accept(
      client.confirmChange({
        params: { changeId: reopened.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );
    expect(duplicateConfirmation.body.status).toBe("pending_payment");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      expect.objectContaining({
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: prorationTimestamp,
      }),
      { idempotencyKey: `usage-pack-change:${preview.body.changeId}:apply` },
    );
    const beforePayment = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(
      beforePayment.allocations.filter((allocation) => {
        return allocation.status === "active";
      }),
    ).toHaveLength(1);
    expect(beforePayment.allocations[0]?.usagePackUsd).toBe(20);
    expect(beforePayment.grants).toHaveLength(2);

    const paidInvoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: pendingInvoiceId,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      prorationTimestamp,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(fixture, newQuantities),
    );
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);

    const upgraded = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(upgraded.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ usagePackUsd: 20, status: "inactive" }),
        expect.objectContaining({ usagePackUsd: 50, status: "active" }),
      ]),
    );
    expect(upgraded.grants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grantType: "purchased",
          originalAmount: 15_000,
        }),
        expect.objectContaining({
          grantType: "bonus",
          originalAmount: 1100,
        }),
      ]),
    );
    expect(upgraded.grants).toHaveLength(4);
    expect(upgraded.refunds).toContainEqual(
      expect.objectContaining({
        userId: sourceUserId,
        sourceType: "invoice",
        sourceAmountCents: 1500,
        status: "available",
      }),
    );
    expect(upgraded.fulfillmentInvoiceIds).toHaveLength(2);
    expect(upgraded.changes).toStrictEqual([
      expect.objectContaining({
        id: preview.body.changeId,
        status: "completed",
        stripeInvoiceId: pendingInvoiceId,
      }),
    ]);
  });

  it("completes an immediately paid upgrade during confirmation", async () => {
    mockNow(new Date("2035-01-20T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const paymentMethodId = `pm_${randomUUID()}`;
    const oldSubscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      default_payment_method: paymentMethodId,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      oldSubscription,
    );
    mockUsagePackChangePreviews(1500, 5000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          memberId: userId,
          targetUsagePackUsd: 50,
          supportsInAppPreview: true,
          returnUrl: `${APP_ORIGIN}/billing`,
        },
      }),
      [200],
    );
    const paymentMethodPreviewToken = preview.body.paymentMethodPreviewToken;
    if (!paymentMethodPreviewToken) {
      throw new Error("Expected a saved-payment-method preview token");
    }
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const invoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      prorationTimestamp,
    });
    const upgradedSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      fixture.billingPeriod,
      { latestInvoice: invoice },
    );
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(oldSubscription)
      .mockResolvedValueOnce(oldSubscription)
      .mockResolvedValue(upgradedSubscription);
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      upgradedSubscription,
    );

    const confirmed = await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: { paymentMethodPreviewToken },
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("completed");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      1,
      fixture.subscriptionId,
      {
        default_payment_method: paymentMethodId,
      },
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      2,
      fixture.subscriptionId,
      expect.objectContaining({
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: prorationTimestamp,
      }),
      { idempotencyKey: `usage-pack-change:${preview.body.changeId}:apply` },
    );
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.changes[0]?.status).toBe("completed");
    expect(state.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ usagePackUsd: 20, status: "inactive" }),
        expect.objectContaining({ usagePackUsd: 50, status: "active" }),
      ]),
    );
    expect(state.grants).toHaveLength(4);
  });

  it("completes a fully discounted usage pack upgrade with nonrefundable credits", async () => {
    mockNow(new Date("2035-01-20T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const paymentMethodId = `pm_${randomUUID()}`;
    const oldSubscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      default_payment_method: paymentMethodId,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      oldSubscription,
    );
    mockUsagePackChangePreviews(0, 5000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          memberId: userId,
          targetUsagePackUsd: 50,
          supportsInAppPreview: true,
          returnUrl: `${APP_ORIGIN}/billing`,
        },
      }),
      [200],
    );
    expect(preview.body.immediateAmountCents).toBe(0);
    expect(preview.body.paymentMethodPreviewToken).toBeUndefined();
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const invoice = {
      ...managedUsagePackUpgradeInvoice(fixture, {
        invoiceId: `in_zero_upgrade_${randomUUID()}`,
        sourcePriceId: TEST_PRICE_USAGE_PACK_20,
        targetPriceId: TEST_PRICE_USAGE_PACK_50,
        prorationTimestamp,
      }),
      amount_due: 0,
      currency: "usd",
      paid: true,
      lines: {
        has_more: false,
        data: managedUsagePackUpgradeInvoice(fixture, {
          invoiceId: `in_zero_upgrade_lines_${randomUUID()}`,
          sourcePriceId: TEST_PRICE_USAGE_PACK_20,
          targetPriceId: TEST_PRICE_USAGE_PACK_50,
          prorationTimestamp,
        }).lines.data.map((line) => {
          return { ...line, amount: 0, subtotal: 0 };
        }),
      },
    };
    const upgradedSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      fixture.billingPeriod,
      { latestInvoice: invoice },
    );
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(oldSubscription)
      .mockResolvedValue(upgradedSubscription);
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      upgradedSubscription,
    );

    const confirmed = await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    expect(confirmed.body.status).toBe("completed");
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ usagePackUsd: 20, status: "inactive" }),
        expect.objectContaining({ usagePackUsd: 50, status: "active" }),
      ]),
    );
    expect(state.grants).toContainEqual(
      expect.objectContaining({
        userId,
        grantType: "purchased",
        originalAmount: 15_000,
      }),
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

  it("expires a failed pending upgrade without changing allocation or credits", async () => {
    const initialNow = new Date("2035-02-16T00:00:00.000Z");
    mockNow(initialNow);
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    const quantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
    const subscription = managedUsagePackSubscription(fixture, quantities);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    mockUsagePackChangePreviews(1500, 5000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: userId, targetUsagePackUsd: 50 },
      }),
      [200],
    );
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const pendingInvoiceId = `in_${randomUUID()}`;
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...subscription,
      pending_update: { expires_at: prorationTimestamp + 60 },
      latest_invoice: {
        id: pendingInvoiceId,
        status: "open",
        hosted_invoice_url: `https://invoice.stripe.test/${pendingInvoiceId}`,
      },
    });
    await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    mockNow(new Date(initialNow.getTime() + 10 * 60 * 1000));
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(fixture, quantities),
    );
    await reconcileBillingOrganization(fixture.orgId);

    const failed = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(failed.changes[0]?.status).toBe("failed");
    expect(failed.allocations).toHaveLength(1);
    expect(failed.allocations[0]).toStrictEqual(
      expect.objectContaining({ usagePackUsd: 20, status: "active" }),
    );
    expect(failed.grants).toHaveLength(2);
  });

  it.each(["free", "limited-free-1"] as const)(
    "invites members from a %s workspace without billing",
    async (tier) => {
      const fixture = createOrgFixture();
      await seedOrgMetadata({ orgId: fixture.orgId, tier, credits: 0 });
      authenticateOrg(fixture);
      const billing = await readBillingStatus(fixture);
      expect(billing.status).toBe("active");
      expect(billing.showUsagePack).toBeFalsy();
      const invited = await accept(
        setupApp({ context, routes: orgInviteRoutes })(
          orgInviteContract,
        ).invite({
          headers: { authorization: "Bearer clerk-session" },
          body: { email: `${tier}@example.test`, role: "member" },
        }),
        [200],
      );
      expect(invited.body.message).toContain(`${tier}@example.test`);
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    { sourceTier: "pro", targetTier: "pro" },
    { sourceTier: "pro", targetTier: "team" },
    { sourceTier: "team", targetTier: "pro" },
    { sourceTier: "team", targetTier: "team" },
  ] as const)(
    "rejects a $sourceTier-to-$targetTier subscription change without a paid usage pack",
    async ({ sourceTier, targetTier }) => {
      const actor = createOrgFixture();
      await seedManagedUsagePack(
        [{ userId: actor.userId, usagePackUsd: 20 }],
        sourceTier,
        actor,
      );
      const client = setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackManagementContract,
      );
      const response = await accept(
        client.previewSubscriptionChange({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            targetTier,
            memberUsagePacks: [{ memberId: actor.userId, usagePackUsd: 0 }],
          },
        }),
        [400],
      );

      expect(response.body).toStrictEqual({
        error: {
          message: "At least one member must have a paid usage pack",
          code: "BAD_REQUEST",
        },
      });
    },
  );

  it("keeps a downgrade scheduled until the boundary and renews aggregate quantities", async () => {
    mockNow(new Date("2035-03-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const secondUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([
      { userId, usagePackUsd: 50 },
      { userId: secondUserId, usagePackUsd: 20 },
    ]);
    const currentQuantities = new Map([
      [TEST_PRICE_USAGE_PACK_50, 1],
      [TEST_PRICE_USAGE_PACK_20, 1],
    ]);
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      currentQuantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackChangePreviews(0, 4000);
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: "sub_sched_usage_pack_downgrade",
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: "sub_sched_usage_pack_downgrade",
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: userId, targetUsagePackUsd: 20 },
      }),
      [200],
    );
    const confirmed = await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("scheduled");
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      "sub_sched_usage_pack_downgrade",
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            start_date: fixture.billingPeriod.end,
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 2 },
            ]),
          }),
        ]),
      }),
      {
        idempotencyKey: `usage-pack-change:${preview.body.changeId}:schedule-update`,
      },
    );
    const scheduled = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(scheduled.changes[0]?.status).toBe("scheduled");
    expect(
      scheduled.allocations.find((allocation) => {
        return allocation.userId === userId && allocation.status === "active";
      })?.usagePackUsd,
    ).toBe(50);
    expect(scheduled.grants).toHaveLength(4);

    const nextPeriod = {
      start: fixture.billingPeriod.end,
      end: fixture.billingPeriod.end + 30 * 86_400,
    };
    const boundarySubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
      nextPeriod,
      { scheduleId: "sub_sched_usage_pack_downgrade" },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      boundarySubscription,
    );
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: "sub_sched_usage_pack_downgrade",
      end_behavior: "release",
      current_phase: {
        start_date: nextPeriod.start,
        end_date: nextPeriod.end,
      },
      phases: [],
    });
    await postManagedUsagePackEvent(
      "customer.subscription.updated",
      boundarySubscription,
    );
    const completed = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(completed.changes[0]?.status).toBe("completed");
    expect(
      completed.allocations.filter((allocation) => {
        return allocation.status === "active";
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId, usagePackUsd: 20 }),
        expect.objectContaining({ userId: secondUserId, usagePackUsd: 20 }),
      ]),
    );
    expect(completed.grants).toHaveLength(4);
  });

  it("adds concurrency without replacing a scheduled usage pack downgrade", async () => {
    mockNow(new Date("2035-03-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const actor = createOrgFixture();
    const fixture = await seedManagedUsagePack(
      [{ userId: actor.userId, usagePackUsd: 100 }],
      "team",
      actor,
    );
    const currentQuantities = new Map([[TEST_PRICE_USAGE_PACK_100, 1]]);
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      currentQuantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackChangePreviews(0, 2000);
    const scheduleId = `sub_sched_usage_pack_${randomUUID()}`;
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const usagePackClient = setupApp({
      context,
      routes: billingCheckoutRoutes,
    })(billingUsagePackManagementContract);
    const usagePackPreview = await accept(
      usagePackClient.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: actor.userId, targetUsagePackUsd: 20 },
      }),
      [200],
    );
    const usagePackChange = await accept(
      usagePackClient.confirmChange({
        params: { changeId: usagePackPreview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );
    expect(usagePackChange.body.status).toBe("scheduled");

    const futurePeriodEnd = fixture.billingPeriod.end + 30 * 86_400;
    const schedule = {
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: fixture.billingPeriod.start,
        end_date: fixture.billingPeriod.end,
      },
      phases: [
        {
          start_date: fixture.billingPeriod.start,
          end_date: fixture.billingPeriod.end,
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_100, quantity: 1 },
          ],
        },
        {
          start_date: fixture.billingPeriod.end,
          end_date: futurePeriodEnd,
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
          ],
        },
      ],
    };
    const scheduledSubscription = managedUsagePackSubscription(
      fixture,
      currentQuantities,
      fixture.billingPeriod,
      { scheduleId },
    );
    const concurrencyInvoiceId = `in_concurrency_${randomUUID()}`;
    const updatedSubscription = managedUsagePackSubscription(
      fixture,
      new Map([
        [TEST_PRICE_USAGE_PACK_100, 1],
        [TEST_PRICE_CONCURRENCY, 3],
      ]),
      fixture.billingPeriod,
      {
        scheduleId,
        latestInvoice: {
          id: concurrencyInvoiceId,
          status: "draft",
          paid: false,
          hosted_invoice_url: null,
        },
      },
    );
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(scheduledSubscription)
      .mockResolvedValueOnce(scheduledSubscription)
      .mockResolvedValue(updatedSubscription);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockReset();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      schedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: concurrencyInvoiceId,
      status: "open",
      paid: false,
      hosted_invoice_url: `https://stripe.test/invoices/${concurrencyInvoiceId}`,
    });
    context.mocks.stripe.invoices.pay.mockResolvedValue({
      id: concurrencyInvoiceId,
      status: "paid",
      paid: true,
      hosted_invoice_url: `https://stripe.test/invoices/${concurrencyInvoiceId}`,
    });
    context.mocks.stripe.subscriptionSchedules.release.mockClear();
    context.mocks.stripe.subscriptions.update.mockClear();
    context.mocks.stripe.invoices.createPreview.mockReset();
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (
        typeof input === "object" &&
        input !== null &&
        "subscription_details" in input &&
        typeof input.subscription_details === "object" &&
        input.subscription_details !== null &&
        "proration_date" in input.subscription_details &&
        typeof input.subscription_details.proration_date === "number"
      ) {
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 15_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 15_000,
                price: { id: TEST_PRICE_CONCURRENCY },
                period: { start: input.subscription_details.proration_date },
                parent: {
                  subscription_item_details: { proration: true },
                },
              },
            ],
          },
        });
      }
      return Promise.resolve({
        id: `in_recurring_${randomUUID()}`,
        amount_due: 30_000,
        currency: "usd",
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${randomUUID()}`,
              amount: 30_000,
              price: { id: TEST_PRICE_CONCURRENCY },
              period: {
                start: fixture.billingPeriod.end,
                end: futurePeriodEnd,
              },
              parent: {
                subscription_item_details: { proration: false },
              },
            },
          ],
        },
      });
    });

    const concurrencyClient = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);
    const concurrencyPreview = await accept(
      concurrencyClient.preview({
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;
    const concurrencyPurchase = await accept(
      concurrencyClient.create({
        body: {
          quantity: 3,
          successUrl,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const expectedPhases = [
      {
        start_date: fixture.billingPeriod.start,
        end_date: fixture.billingPeriod.end,
        items: [
          { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
          { price: TEST_PRICE_USAGE_PACK_100, quantity: 1 },
          { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
        ],
        proration_behavior: "none",
      },
      {
        start_date: fixture.billingPeriod.end,
        end_date: futurePeriodEnd,
        items: [
          { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1 },
          { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
          { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
        ],
        proration_behavior: "none",
      },
    ];
    expect(concurrencyPreview.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 15_000,
      nextRecurringAmountCents: 30_000,
      currency: "usd",
    });
    expect(concurrencyPurchase.body).toStrictEqual({ url: successUrl });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "release",
        proration_behavior: "none",
        phases: expectedPhases,
      },
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "always_invoice",
        phases: expectedPhases,
      },
      {
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:[^:]+:[^:]+:schedule-update$/u,
        ),
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.finalizeInvoice).toHaveBeenCalledWith(
      concurrencyInvoiceId,
      {},
      {
        idempotencyKey: `concurrency-change:${fixture.subscriptionId}:${concurrencyInvoiceId}:finalize`,
      },
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      concurrencyInvoiceId,
      {},
      {
        idempotencyKey: `concurrency-change:${fixture.subscriptionId}:${concurrencyInvoiceId}:pay`,
      },
    );

    await postManagedUsagePackEvent("invoice.paid", {
      id: concurrencyInvoiceId,
      customer: fixture.customerId,
      metadata: managedUsagePackMetadata(fixture),
      status: "paid",
      parent: {
        subscription_details: {
          subscription: fixture.subscriptionId,
          metadata: managedUsagePackMetadata(fixture),
        },
      },
      lines: {
        has_more: false,
        data: [
          managedConcurrencyInvoiceLine({
            quantity: 3,
            billingPeriod: fixture.billingPeriod,
            proration: true,
          }),
        ],
      },
    });

    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      concurrencySubscriptions: [
        {
          id: fixture.subscriptionId,
          quantity: 3,
        },
      ],
    });
  });

  it("retries a deferred change when the Stripe schedule update fails", async () => {
    const initialNow = new Date("2035-04-01T00:00:00.000Z");
    mockNow(initialNow);
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 50 }]);
    const quantities = new Map([[TEST_PRICE_USAGE_PACK_50, 1]]);
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      quantities,
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    mockUsagePackChangePreviews(0, 2000);
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: "sub_sched_usage_pack_retry",
    });
    context.mocks.stripe.subscriptionSchedules.update
      .mockRejectedValueOnce(new Error("temporary Stripe failure"))
      .mockResolvedValue({ id: "sub_sched_usage_pack_retry" });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: userId, targetUsagePackUsd: 20 },
      }),
      [200],
    );
    await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [500],
    );
    const applying = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(applying.changes[0]?.status).toBe("applying");

    mockNow(new Date(initialNow.getTime() + 10 * 60 * 1000));
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(fixture, quantities, fixture.billingPeriod, {
        scheduleId: "sub_sched_usage_pack_retry",
      }),
    );
    await reconcileBillingOrganization(fixture.orgId);

    const scheduled = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(scheduled.changes[0]?.status).toBe("scheduled");
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledTimes(2);
  });

  it("refunds a removed member exactly once across admin and Clerk removal ingress", async () => {
    mockNow(new Date("2035-04-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const targetUserId = `user_${randomUUID()}`;
    const targetEmail = `${targetUserId}@example.test`;
    const fixture = await seedManagedUsagePack([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
      { userId: targetUserId, usagePackUsd: 50 },
    ]);
    await usagePackStateAction({
      action: "set-grant-remaining",
      orgId: fixture.orgId,
      userId: targetUserId,
      grantType: "purchased",
      remainingAmount: 25_000,
    });
    const adminUserId =
      (
        await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId)
      ).allocations.find((allocation) => {
        return allocation.userId !== targetUserId;
      })?.userId ?? "";
    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: targetUserId }],
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          { publicUserData: { userId: adminUserId } },
          { publicUserData: { userId: targetUserId } },
        ],
      },
    );
    const deletionStarted = createDeferredPromise<void>(context.signal);
    const deletionGate = createDeferredPromise<void>(context.signal);
    context.mocks.clerk.organizations.deleteOrganizationMembership.mockImplementation(
      async () => {
        deletionStarted.resolve(undefined);
        await deletionGate.promise;
        return {};
      },
    );
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([
        [TEST_PRICE_USAGE_PACK_20, 1],
        [TEST_PRICE_USAGE_PACK_50, 1],
      ]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      currentSubscription,
    );
    context.mocks.stripe.creditNotes.preview.mockResolvedValue({
      id: "cn_preview_usage_pack_removal",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 2500,
      refunds: [],
    });
    const invoicePaymentIntentId = "pi_usage_pack_removal";
    context.mocks.stripe.invoices.retrieve.mockResolvedValue({
      id: "in_usage_pack_removal",
      payments: {
        data: [
          {
            status: "paid",
            amount_paid: 5000,
            payment: {
              type: "payment_intent",
              payment_intent: invoicePaymentIntentId,
            },
          },
        ],
      },
    });
    context.mocks.stripe.refunds.create
      .mockResolvedValueOnce({
        id: "re_usage_pack_removal_failed",
        status: "failed",
      })
      .mockResolvedValueOnce({
        id: "re_usage_pack_removal",
        status: "succeeded",
      });
    context.mocks.stripe.creditNotes.create.mockResolvedValue({
      id: "cn_usage_pack_removal",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 2500,
      refunds: [
        {
          amount_refunded: 2500,
          refund: "re_usage_pack_removal",
        },
      ],
    });

    const responsePromise = setupApp({ context, routes: orgMembersRoutes })(
      orgMembersContract,
    ).removeMember({
      headers: { authorization: "Bearer clerk-session" },
      body: { email: targetEmail },
    });
    await deletionStarted.promise;
    const reserved = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(reserved.changes).toContainEqual(
      expect.objectContaining({
        userId: targetUserId,
        kind: "removal",
        status: "previewed",
      }),
    );
    expect(
      reserved.remainingCredits.find((credits) => {
        return credits.userId === targetUserId;
      })?.amount,
    ).toBeGreaterThan(0);
    deletionGate.resolve(undefined);

    const response = await accept(responsePromise, [200]);
    expect(response.body.message).toBe(`Removed ${targetEmail} from org`);
    const retryPending = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(retryPending.refunds).toContainEqual(
      expect.objectContaining({
        userId: targetUserId,
        status: "pending",
        stripeCreditNoteId: null,
        stripeRefundId: null,
      }),
    );
    expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();

    await runBillingReconciliation(fixture.orgId);

    const duplicateEvent = {
      type: "organizationMembership.deleted",
      data: {
        id: `mem_removed_${randomUUID()}`,
        organization: { id: fixture.orgId },
        publicUserData: { userId: targetUserId },
        role: "org:member",
      },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(duplicateEvent);
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({ body: JSON.stringify(duplicateEvent) }),
      [200],
    );
    await flushWaitUntilForTest();

    const removed = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(removed.remainingCredits).toContainEqual({
      userId: targetUserId,
      amount: 0,
    });
    expect(removed.refunds).toContainEqual(
      expect.objectContaining({
        userId: targetUserId,
        sourceType: "invoice",
        sourceAmountCents: 5000,
        status: "succeeded",
        refundCredits: 25_000,
        requestedAmountCents: 2500,
        refundedAmountCents: 2500,
        stripeCreditNoteId: "cn_usage_pack_removal",
        stripeRefundId: "re_usage_pack_removal",
      }),
    );
    expect(removed.changes).toContainEqual(
      expect.objectContaining({
        userId: targetUserId,
        kind: "removal",
        status: "completed",
      }),
    );
    expect(
      removed.allocations.find((allocation) => {
        return allocation.userId === targetUserId;
      })?.status,
    ).toBe("inactive");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: expect.arrayContaining([
          { id: `si_${TEST_PRICE_USAGE_PACK_20}`, quantity: 1 },
          { id: `si_${TEST_PRICE_USAGE_PACK_50}`, deleted: true },
        ]),
        proration_behavior: "none",
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("member-removal"),
      }),
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(2);
    expect(context.mocks.stripe.refunds.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        payment_intent: invoicePaymentIntentId,
        amount: 2500,
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:[0-9a-f-]+:1:refund$/u,
        ),
      }),
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payment_intent: invoicePaymentIntentId,
        amount: 2500,
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:[0-9a-f-]+:2:refund$/u,
        ),
      }),
    );
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.stringMatching(/^in_/u),
        lines: [
          expect.objectContaining({
            type: "invoice_line_item",
            invoice_line_item: expect.stringMatching(/^il_/u),
            amount: 2500,
          }),
        ],
        refunds: [
          {
            refund: "re_usage_pack_removal",
            amount_refunded: 2500,
          },
        ],
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:[0-9a-f-]+:2:credit-note$/u,
        ),
      }),
    );

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
    );
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 5000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const billingClient = setupApp({
      context,
      routes: billingCheckoutRoutes,
    })(billingUsagePackManagementContract);
    const management = await accept(
      billingClient.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(management.body.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: adminUserId,
        usagePackUsd: 20,
        pendingChange: null,
      }),
    ]);
    await accept(
      billingClient.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: adminUserId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );
  });

  it("infers a legacy invoice refund when the removed member owns the last package", async () => {
    mockNow(new Date("2035-04-20T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const targetUserId = `user_${randomUUID()}`;
    const targetEmail = `${targetUserId}@example.test`;
    const fixture = await seedManagedUsagePack([
      { userId: targetUserId, usagePackUsd: 20 },
    ]);
    await usagePackStateAction({
      action: "delete-refund-source",
      orgId: fixture.orgId,
      userId: targetUserId,
    });
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: targetUserId }],
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          { publicUserData: { userId: fixture.userId } },
          { publicUserData: { userId: targetUserId } },
        ],
      },
    );
    context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValue(
      {},
    );
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      currentSubscription,
    );
    context.mocks.stripe.subscriptions.update.mockClear();
    context.mocks.stripe.subscriptionSchedules.create.mockClear();
    context.mocks.stripe.creditNotes.preview.mockResolvedValue({
      id: "cn_preview_last_usage_pack_removal",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 2000,
      refunds: [],
    });
    const invoicePaymentIntentId = "pi_last_usage_pack_removal";
    context.mocks.stripe.invoices.retrieve.mockResolvedValue({
      id: "in_last_usage_pack_removal",
      payments: {
        data: [
          {
            status: "paid",
            amount_paid: 2000,
            payment: {
              type: "payment_intent",
              payment_intent: invoicePaymentIntentId,
            },
          },
        ],
      },
    });
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: "re_last_usage_pack_removal",
      status: "succeeded",
    });
    context.mocks.stripe.creditNotes.create.mockResolvedValue({
      id: "cn_last_usage_pack_removal",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 2000,
      refunds: [
        {
          amount_refunded: 2000,
          refund: "re_last_usage_pack_removal",
        },
      ],
    });

    await accept(
      setupApp({ context, routes: orgMembersRoutes })(
        orgMembersContract,
      ).removeMember({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: targetEmail },
      }),
      [200],
    );

    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      { cancel_at_period_end: true },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.remainingCredits).toContainEqual({
      userId: targetUserId,
      amount: 0,
    });
    expect(state.refunds).toContainEqual(
      expect.objectContaining({
        userId: targetUserId,
        sourceType: "invoice",
        sourceAmountCents: 2000,
        status: "succeeded",
        requestedAmountCents: 2000,
        refundedAmountCents: 2000,
        stripeCreditNoteId: "cn_last_usage_pack_removal",
        stripeRefundId: "re_last_usage_pack_removal",
      }),
    );
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.stringMatching(/^in_/u),
        amount: 2000,
        refunds: [
          {
            refund: "re_last_usage_pack_removal",
            amount_refunded: 2000,
          },
        ],
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:[0-9a-f-]+:1:credit-note$/u,
        ),
      }),
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: invoicePaymentIntentId,
        amount: 2000,
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:[0-9a-f-]+:1:refund$/u,
        ),
      }),
    );
    expect(state.changes[0]).toStrictEqual(
      expect.objectContaining({ kind: "removal", status: "scheduled" }),
    );
    expect(state.subscription?.cancelAtPeriodEnd).toBeTruthy();
    expect(state.org?.cancelAtPeriodEnd).toBeTruthy();
  });

  it("removes a member when a legacy invoice has no refundable amount", async () => {
    mockNow(new Date("2035-04-20T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const targetUserId = `user_${randomUUID()}`;
    const targetEmail = `${targetUserId}@example.test`;
    const fixture = await seedManagedUsagePack([
      { userId: targetUserId, usagePackUsd: 20 },
    ]);
    await usagePackStateAction({
      action: "delete-refund-source",
      orgId: fixture.orgId,
      userId: targetUserId,
    });
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: targetUserId }],
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          { publicUserData: { userId: fixture.userId } },
          { publicUserData: { userId: targetUserId } },
        ],
      },
    );
    context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValue(
      {},
    );
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      currentSubscription,
    );
    context.mocks.stripe.creditNotes.preview.mockResolvedValue({
      id: "cn_preview_zero_usage_pack_removal",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 0,
      refunds: [],
    });

    await accept(
      setupApp({ context, routes: orgMembersRoutes })(
        orgMembersContract,
      ).removeMember({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: targetEmail },
      }),
      [200],
    );

    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.remainingCredits).toContainEqual({
      userId: targetUserId,
      amount: 0,
    });
    expect(state.refunds).toContainEqual(
      expect.objectContaining({
        userId: targetUserId,
        sourceType: "invoice",
        sourceAmountCents: 2000,
        status: "succeeded",
        requestedAmountCents: 2000,
        refundedAmountCents: 0,
        stripeCreditNoteId: null,
        stripeRefundId: null,
      }),
    );
    expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
    expect(context.mocks.stripe.refunds.retrieve).not.toHaveBeenCalled();
    expect(state.changes[0]).toStrictEqual(
      expect.objectContaining({ kind: "removal", status: "scheduled" }),
    );
  });

  it("recovers a failed refund from an already-issued invoice credit note", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    await usagePackStateAction({
      action: "set-grant-remaining",
      orgId: fixture.orgId,
      userId,
      grantType: "purchased",
      remainingAmount: 10_000,
      prepareRefund: true,
      refundState: {
        status: "failed",
        refundedAmountCents: 1000,
        stripeCreditNoteId: "cn_historical_failed",
        stripeRefundId: "re_historical_failed",
        attempt: 1,
        failureReason: "stripe_refund_failed",
      },
    });
    context.mocks.stripe.creditNotes.retrieve.mockResolvedValue({
      id: "cn_historical_failed",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 1000,
      refunds: [{ amount_refunded: 1000, refund: "re_historical_failed" }],
    });
    context.mocks.stripe.refunds.retrieve.mockResolvedValue({
      id: "re_historical_failed",
      status: "failed",
    });

    await runBillingReconciliation(fixture.orgId);

    const retryPending = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(retryPending.refunds).toContainEqual(
      expect.objectContaining({
        userId,
        status: "pending",
        attempt: 2,
        stripeCreditNoteId: "cn_historical_failed",
        stripeRefundId: null,
      }),
    );

    const recoveryPaymentIntentId = "pi_historical_recovery";
    context.mocks.stripe.invoices.retrieve.mockResolvedValue({
      id: "in_historical_recovery",
      payments: {
        data: [
          {
            status: "paid",
            amount_paid: 2000,
            payment: {
              type: "payment_intent",
              payment_intent: recoveryPaymentIntentId,
            },
          },
        ],
      },
    });
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: "re_historical_recovery",
      status: "succeeded",
    });

    await runBillingReconciliation(fixture.orgId);

    const recovered = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(recovered.refunds).toContainEqual(
      expect.objectContaining({
        userId,
        status: "succeeded",
        attempt: 2,
        stripeCreditNoteId: "cn_historical_failed",
        stripeRefundId: "re_historical_recovery",
      }),
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: recoveryPaymentIntentId,
        amount: 1000,
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:[0-9a-f-]+:2:refund$/u,
        ),
      }),
    );
    expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
  });

  it("stops retrying an invoice refund after the third failed attempt", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    await usagePackStateAction({
      action: "set-grant-remaining",
      orgId: fixture.orgId,
      userId,
      grantType: "purchased",
      remainingAmount: 10_000,
      prepareRefund: true,
    });
    context.mocks.stripe.creditNotes.preview.mockResolvedValue({
      id: "cn_preview_terminal_refund",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 1000,
      refunds: [],
    });
    context.mocks.stripe.invoices.retrieve.mockResolvedValue({
      id: "in_terminal_refund",
      payments: {
        data: [
          {
            status: "paid",
            amount_paid: 2000,
            payment: {
              type: "payment_intent",
              payment_intent: "pi_terminal_refund",
            },
          },
        ],
      },
    });
    context.mocks.stripe.refunds.create
      .mockResolvedValueOnce({ id: "re_failed_1", status: "failed" })
      .mockResolvedValueOnce({ id: "re_failed_2", status: "canceled" })
      .mockResolvedValueOnce({
        id: "re_failed_3",
        status: "failed",
        failure_reason: "declined",
      });

    await runBillingReconciliation(fixture.orgId);
    await runBillingReconciliation(fixture.orgId);
    await runBillingReconciliation(fixture.orgId);
    await runBillingReconciliation(fixture.orgId);

    const failed = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(failed.refunds).toContainEqual(
      expect.objectContaining({
        userId,
        status: "failed",
        attempt: 3,
        failureReason: "stripe_refund_failed:declined",
        stripeCreditNoteId: null,
        stripeRefundId: "re_failed_3",
      }),
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(3);
    expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
  });

  it("fails closed when an invoice has multiple refundable PaymentIntents", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([{ userId, usagePackUsd: 20 }]);
    await usagePackStateAction({
      action: "set-grant-remaining",
      orgId: fixture.orgId,
      userId,
      grantType: "purchased",
      remainingAmount: 10_000,
      prepareRefund: true,
    });
    context.mocks.stripe.creditNotes.preview.mockResolvedValue({
      id: "cn_preview_ambiguous_refund",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 1000,
      refunds: [],
    });
    context.mocks.stripe.invoices.retrieve.mockResolvedValue({
      id: "in_ambiguous_refund",
      payments: {
        data: ["first", "second"].map((suffix) => {
          return {
            status: "paid",
            amount_paid: 2000,
            payment: {
              type: "payment_intent",
              payment_intent: `pi_ambiguous_${suffix}`,
            },
          };
        }),
      },
    });

    await runBillingReconciliation(fixture.orgId);

    const failed = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(failed.refunds).toContainEqual(
      expect.objectContaining({
        userId,
        status: "failed",
        attempt: 1,
        failureReason: "invoice_refund_payment_intent_count_2",
        stripeCreditNoteId: null,
        stripeRefundId: null,
      }),
    );
    expect(context.mocks.stripe.refunds.create).not.toHaveBeenCalled();
    expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
  });

  it("continues reconciling refunds after one candidate throws", async () => {
    const firstUserId = `user_${randomUUID()}`;
    const secondUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([
      { userId: firstUserId, usagePackUsd: 20 },
      { userId: secondUserId, usagePackUsd: 20 },
    ]);
    for (const userId of [firstUserId, secondUserId]) {
      await usagePackStateAction({
        action: "set-grant-remaining",
        orgId: fixture.orgId,
        userId,
        grantType: "purchased",
        remainingAmount: 10_000,
        prepareRefund: true,
      });
    }
    context.mocks.stripe.creditNotes.preview.mockResolvedValue({
      id: "cn_preview_isolated_refund",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 1000,
      refunds: [],
    });
    context.mocks.stripe.invoices.retrieve
      .mockRejectedValueOnce(new Error("bad Stripe invoice"))
      .mockResolvedValueOnce({
        id: "in_isolated_refund",
        payments: {
          data: [
            {
              status: "paid",
              amount_paid: 4000,
              payment: {
                type: "payment_intent",
                payment_intent: "pi_isolated_refund",
              },
            },
          ],
        },
      });
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: "re_isolated_refund",
      status: "succeeded",
    });
    context.mocks.stripe.creditNotes.create.mockResolvedValue({
      id: "cn_isolated_refund",
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 1000,
      refunds: [{ amount_refunded: 1000, refund: "re_isolated_refund" }],
    });

    await runBillingReconciliation(fixture.orgId);

    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(
      state.refunds.filter((refund) => {
        return refund.status === "processing";
      }),
    ).toHaveLength(1);
    expect(
      state.refunds.filter((refund) => {
        return refund.status === "succeeded";
      }),
    ).toHaveLength(1);
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledTimes(1);
  });

  it.each(["pro", "team"] as const)(
    "invites members without purchasing a package on managed %s plans",
    async (tier) => {
      const fixture = await seedManagedUsagePack(
        [{ userId: `user_${randomUUID()}`, usagePackUsd: 20 }],
        tier,
      );
      const billing = await readBillingStatus(fixture);
      expect(billing.showUsagePack).toBeTruthy();

      const client = setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      );
      const invited = await accept(
        client.invite({
          headers: { authorization: "Bearer clerk-session" },
          body: { email: "paid@example.test", role: "member" },
        }),
        [200],
      );
      expect(invited.body.message).toContain("paid@example.test");
      expect(
        context.mocks.clerk.organizations.createOrganizationInvitation,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: fixture.orgId,
          emailAddress: "paid@example.test",
          role: "org:member",
        }),
      );
    },
  );

  it.each(["pro", "team"] as const)(
    "keeps legacy %s invitation entitlements package-free",
    async (tier) => {
      const fixture = await createSubscriptionOrg({ tier });
      const billing = await readBillingStatus(fixture);
      expect(billing.showUsagePack).toBeFalsy();

      context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
        { id: `inv_${randomUUID()}` },
      );
      const invited = await accept(
        setupApp({ context, routes: orgInviteRoutes })(
          orgInviteContract,
        ).invite({
          headers: { authorization: "Bearer clerk-session" },
          body: { email: `legacy-${tier}@example.test`, role: "member" },
        }),
        [200],
      );
      expect(invited.body.message).toContain(`legacy-${tier}@example.test`);
    },
  );

  it("keeps suspended plans from inviting members", async () => {
    const fixture = await seedManagedUsagePack([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
    ]);
    const client = setupApp({ context, routes: orgInviteRoutes })(
      orgInviteContract,
    );

    for (const tier of ["pro-suspend"] as const) {
      await seedOrgMetadata({ orgId: fixture.orgId, tier, credits: 0 });
      const blocked = await accept(
        client.invite({
          headers: { authorization: "Bearer clerk-session" },
          body: { email: `${tier}@example.test`, role: "member" },
        }),
        [403],
      );
      expect(blocked.body.error).toStrictEqual({
        message: "Reactivate your workspace plan to invite members",
        code: "FORBIDDEN",
      });
      const preview = await accept(
        client.previewPurchase({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            email: `${tier}@example.test`,
            role: "member",
            usagePackUsd: 20,
          },
        }),
        [403],
      );
      const confirm = await accept(
        client.confirmPurchase({
          headers: { authorization: "Bearer clerk-session" },
          params: { purchaseId: randomUUID() },
          body: {},
        }),
        [403],
      );
      expect(preview.body.error).toStrictEqual(blocked.body.error);
      expect(confirm.body.error).toStrictEqual(blocked.body.error);
    }
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("supports invitation purchase for a non-staff org", async () => {
    const fixture = createOrgFixture();
    expect(isStaffOrg(fixture.orgId)).toBeFalsy();
    authenticateOrg(fixture);
    await seedOrgMetadata({ orgId: fixture.orgId, tier: "pro", credits: 0 });

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      ).previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          email: "non-staff@example.test",
          role: "member",
          usagePackUsd: 20,
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe(
      "INVITATION_PURCHASE_SUBSCRIPTION_NOT_FOUND",
    );
  });

  it("explains when an invitation purchase targets an existing member", async () => {
    const existingMemberUserId = `user_${randomUUID()}`;
    const existingMemberEmail = `existing-${randomUUID()}@example.test`;
    await seedManagedUsagePack([
      { userId: existingMemberUserId, usagePackUsd: 20 },
    ]);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: {
              userId: existingMemberUserId,
              identifier: existingMemberEmail,
            },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      ).previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          email: existingMemberEmail,
          role: "member",
          usagePackUsd: 20,
        },
      }),
      [409],
    );

    expect(response.body.error).toStrictEqual({
      code: "INVITATION_PURCHASE_INVITEE_UNAVAILABLE",
      message: "This person is already a member or has a pending invitation.",
    });
  });

  it("purchases, accepts, and removes a fully discounted invitation through Stripe", async () => {
    mockNow(new Date("2035-02-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const existingMemberUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([
      { userId: existingMemberUserId, usagePackUsd: 20 },
    ]);
    const subscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      default_payment_method: null,
      default_source: null,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: fixture.customerId,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: {
              userId: existingMemberUserId,
              identifier: `${existingMemberUserId}@example.test`,
            },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    mockUsagePackChangePreviews(0, 2000);
    const email = `zero-proration-${randomUUID()}@example.test`;
    const invitationId = `inv_zero_${randomUUID()}`;
    const acceptedUserId = `user_zero_${randomUUID()}`;
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
      {
        id: invitationId,
        emailAddress: email,
        organizationId: fixture.orgId,
        status: "pending",
      },
    );

    const client = setupApp({ context, routes: orgInviteRoutes })(
      orgInviteContract,
    );
    const preview = await accept(
      client.previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          email,
          role: "member",
          usagePackUsd: 20,
        },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual({
      purchaseId: expect.any(String),
      usagePackUsd: 20,
      immediateAmountCents: 0,
      currency: "usd",
      purchasedCredits: 10_000,
      bonusCredits: 200,
      totalCredits: 10_200,
      currentPeriodEnd: new Date(
        fixture.billingPeriod.end * 1000,
      ).toISOString(),
      expiresAt: expect.any(String),
    });

    const invoiceId = `in_zero_invite_${randomUUID()}`;
    const metadata = {
      purpose: "usage_pack_invitation_purchase",
      usagePackInvitationPurchaseId: preview.body.purchaseId,
    };
    context.mocks.stripe.invoices.create.mockResolvedValue({
      id: invoiceId,
      customer: fixture.customerId,
      metadata,
      amount_due: 0,
      currency: "usd",
      status: "draft",
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    context.mocks.stripe.invoiceItems.create.mockResolvedValue({
      id: `ii_zero_invite_${randomUUID()}`,
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: invoiceId,
      customer: fixture.customerId,
      metadata,
      amount_due: 0,
      currency: "usd",
      status: "paid",
      paid: true,
      hosted_invoice_url: null,
      lines: { has_more: false, data: [] },
      parent: null,
    });
    context.mocks.stripe.invoices.retrieve.mockResolvedValue({
      id: invoiceId,
      customer: fixture.customerId,
      metadata,
      amount_due: 0,
      currency: "usd",
      status: "paid",
      paid: true,
      hosted_invoice_url: null,
      status_transitions: { paid_at: Math.floor(now() / 1000) },
      payments: { data: [] },
      lines: { has_more: false, data: [] },
      parent: null,
    });

    const confirmation = await accept(
      client.confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: preview.body.purchaseId },
        body: {},
      }),
      [200],
    );
    expect(confirmation.body.message).toBe("Invitation purchased and sent");
    expect(context.mocks.stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: invoiceId,
        amount: 0,
        currency: "usd",
      }),
      expect.any(Object),
    );
    expect(context.mocks.stripe.invoices.pay).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();

    const pending = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(pending.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({
        status: "invitation_pending",
        expectedAmountCents: 0,
        amountPaidCents: 0,
        stripePaymentIntentId: null,
        clerkInvitationId: invitationId,
      }),
    );

    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    const purchase: InvitationPurchaseFixture = {
      fixture,
      existingMemberUserId,
      email,
      purchaseId: preview.body.purchaseId,
      paymentIntentId: `pi_unused_${randomUUID()}`,
    };
    await postClerkInvitationAccepted({
      purchase,
      invitationId,
      userId: acceptedUserId,
    });

    const accepted = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(accepted.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({ status: "accepted", acceptedUserId }),
    );
    expect(
      accepted.grants.filter((grant) => {
        return grant.userId === acceptedUserId;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grantType: "purchased",
          originalAmount: 10_000,
        }),
        expect.objectContaining({ grantType: "bonus", originalAmount: 200 }),
      ]),
    );
    expect(
      accepted.refunds.filter((refund) => {
        return refund.userId === acceptedUserId;
      }),
    ).toStrictEqual([]);

    context.mocks.stripe.subscriptions.update.mockClear();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
      ),
    );
    const removalEvent = {
      type: "organizationMembership.deleted",
      data: {
        id: `mem_zero_${randomUUID()}`,
        organization: { id: fixture.orgId },
        publicUserData: { userId: acceptedUserId },
        role: "org:member",
      },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(removalEvent);
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({ body: JSON.stringify(removalEvent) }),
      [200],
    );
    await flushWaitUntilForTest();

    const removed = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(
      removed.allocations.find((allocation) => {
        return allocation.userId === acceptedUserId;
      })?.status,
    ).toBe("inactive");
    expect(removed.remainingCredits).toContainEqual({
      userId: acceptedUserId,
      amount: 0,
    });
    expect(
      removed.refunds.filter((refund) => {
        return refund.userId === acceptedUserId;
      }),
    ).toStrictEqual([]);
    expect(context.mocks.stripe.refunds.create).not.toHaveBeenCalled();
    expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ id: `si_${TEST_PRICE_USAGE_PACK_20}`, quantity: 1 }],
        proration_behavior: "none",
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("member-removal"),
      }),
    );
  });

  it("asks the buyer to restore a canceling subscription before inviting", async () => {
    const existingMemberUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([
      { userId: existingMemberUserId, usagePackUsd: 20 },
    ]);
    const endingSubscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      cancel_at: fixture.billingPeriod.end,
      cancel_at_period_end: true,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      endingSubscription,
    );
    await postManagedUsagePackEvent(
      "customer.subscription.updated",
      endingSubscription,
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      ).previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          email: `canceling-${randomUUID()}@example.test`,
          role: "member",
          usagePackUsd: 20,
        },
      }),
      [409],
    );

    expect(response.body.error).toStrictEqual({
      code: "INVITATION_PURCHASE_SUBSCRIPTION_CANCELING",
      message: "Restore your subscription before purchasing a member package.",
    });
  });

  it.each([
    {
      label: "exclusive tax",
      lineAmountCents: 1000,
      subtotalCents: 1000,
      exclusiveTaxCents: 100,
      expectedAmountCents: 1100,
    },
    {
      label: "discount",
      lineAmountCents: 800,
      subtotalCents: 1000,
      exclusiveTaxCents: 0,
      expectedAmountCents: 800,
    },
    {
      label: "discount and exclusive tax",
      lineAmountCents: 800,
      subtotalCents: 1000,
      exclusiveTaxCents: 80,
      expectedAmountCents: 880,
    },
  ])(
    "keeps invitation credits time-based with $label",
    async ({
      lineAmountCents,
      subtotalCents,
      exclusiveTaxCents,
      expectedAmountCents,
    }) => {
      const { fixture, email } =
        await setupInvitationPreviewContext("priced-invite");
      mockInvitationChargePreview({
        lines: [{ lineAmountCents, subtotalCents, exclusiveTaxCents }],
        periodEnd: fixture.billingPeriod.end,
      });

      const response = await accept(
        setupApp({ context, routes: orgInviteRoutes })(
          orgInviteContract,
        ).previewPurchase({
          headers: { authorization: "Bearer clerk-session" },
          body: { email, role: "member", usagePackUsd: 20 },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        purchaseId: expect.any(String),
        usagePackUsd: 20,
        immediateAmountCents: expectedAmountCents,
        currency: "usd",
        purchasedCredits: 10_000,
        bonusCredits: 200,
        totalCredits: 10_200,
        currentPeriodEnd: new Date(
          fixture.billingPeriod.end * 1000,
        ).toISOString(),
        expiresAt: expect.any(String),
      });
      const state = await readUsagePackState(
        fixture.orgId,
        fixture.usagePackSubscriptionId,
      );
      expect(state.invitationPurchases).toContainEqual(
        expect.objectContaining({
          id: response.body.purchaseId,
          expectedAmountCents,
          purchasedCredits: 10_000,
          bonusCredits: 200,
        }),
      );
    },
  );

  it("finds an invitation proration line across every preview page", async () => {
    const { fixture, email } =
      await setupInvitationPreviewContext("paginated-invite");
    let prorationTimestamp: number | null = null;
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      const details = previewSubscriptionDetails(input);
      if (typeof details?.proration_date !== "number") {
        throw new Error("Expected an invitation proration timestamp");
      }
      prorationTimestamp = details.proration_date;
      return Promise.resolve({
        id: "in_paginated_invitation_preview",
        amount_due: 1000,
        currency: "usd",
        lines: { has_more: true, data: [] },
      });
    });
    context.mocks.stripe.invoices.listLineItems.mockImplementation(
      (_invoiceId, params) => {
        const startingAfter =
          typeof params === "object" && params !== null
            ? Reflect.get(params, "starting_after")
            : undefined;
        if (!startingAfter) {
          return Promise.resolve({
            has_more: true,
            data: [
              {
                id: "il_unrelated",
                amount: 2000,
                price: { id: TEST_PRICE_USAGE_PACK_20 },
                period: {
                  start: fixture.billingPeriod.end,
                  end: fixture.billingPeriod.end + 30 * 86_400,
                },
                parent: {
                  type: "subscription_item_details" as const,
                  subscription_item_details: { proration: false },
                },
              },
            ],
          });
        }
        expect(startingAfter).toBe("il_unrelated");
        if (prorationTimestamp === null) {
          throw new Error("Preview did not capture its proration timestamp");
        }
        return Promise.resolve({
          has_more: false,
          data: [
            {
              id: "il_invitation_proration",
              amount: 1000,
              price: { id: TEST_PRICE_USAGE_PACK_20 },
              period: {
                start: prorationTimestamp,
                end: fixture.billingPeriod.end,
              },
              parent: {
                type: "subscription_item_details" as const,
                subscription_item_details: { proration: true },
              },
            },
          ],
        });
      },
    );

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      ).previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: { email, role: "member", usagePackUsd: 20 },
      }),
      [200],
    );

    expect(response.body).toStrictEqual(
      expect.objectContaining({
        immediateAmountCents: 1000,
        purchasedCredits: 10_000,
        bonusCredits: 200,
      }),
    );
    expect(context.mocks.stripe.invoices.listLineItems).toHaveBeenNthCalledWith(
      1,
      "in_paginated_invitation_preview",
      { limit: 100 },
    );
    expect(context.mocks.stripe.invoices.listLineItems).toHaveBeenNthCalledWith(
      2,
      "in_paginated_invitation_preview",
      { limit: 100, starting_after: "il_unrelated" },
    );
  });

  it("prices an invitation from only the added package proration", async () => {
    mockNow(new Date("2035-05-15T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const existingMemberUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([
      { userId: existingMemberUserId, usagePackUsd: 20 },
    ]);
    const email = `incremental-invite-${randomUUID()}@example.test`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: {
              userId: existingMemberUserId,
              identifier: `${existingMemberUserId}@example.test`,
            },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      const details = previewSubscriptionDetails(input);
      const prorationTimestamp = details?.proration_date;
      if (!details || typeof prorationTimestamp !== "number") {
        throw new Error("Expected an invitation proration timestamp");
      }
      expect(details.items).toStrictEqual([
        { id: `si_${TEST_PRICE_USAGE_PACK_20}`, quantity: 2 },
      ]);
      return Promise.resolve({
        id: `in_preview_${randomUUID()}`,
        amount_due: 4000,
        currency: "usd",
        lines: {
          has_more: false,
          data: [
            {
              id: `il_renewal_${randomUUID()}`,
              amount: 4000,
              price: { id: TEST_PRICE_USAGE_PACK_20 },
              period: {
                start: fixture.billingPeriod.end,
                end: fixture.billingPeriod.end + 30 * 86_400,
              },
              parent: {
                type: "subscription_item_details" as const,
                subscription_item_details: { proration: false },
              },
            },
            {
              id: `il_proration_credit_${randomUUID()}`,
              amount: -2000,
              price: { id: TEST_PRICE_USAGE_PACK_20 },
              period: {
                start: prorationTimestamp,
                end: fixture.billingPeriod.end,
              },
              parent: {
                type: "subscription_item_details" as const,
                subscription_item_details: { proration: true },
              },
            },
            {
              id: `il_proration_charge_${randomUUID()}`,
              amount: 4000,
              price: { id: TEST_PRICE_USAGE_PACK_20 },
              period: {
                start: prorationTimestamp,
                end: fixture.billingPeriod.end,
              },
              parent: {
                type: "subscription_item_details" as const,
                subscription_item_details: { proration: true },
              },
            },
          ],
        },
      });
    });

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      ).previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: { email, role: "member", usagePackUsd: 20 },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      purchaseId: expect.any(String),
      usagePackUsd: 20,
      immediateAmountCents: 2000,
      currency: "usd",
      purchasedCredits: 10_000,
      bonusCredits: 200,
      totalCredits: 10_200,
      currentPeriodEnd: new Date(
        fixture.billingPeriod.end * 1000,
      ).toISOString(),
      expiresAt: expect.any(String),
    });
  });

  it("preserves the invitation preview Impact snapshot and discounted exclusive-tax amount", async () => {
    const { fixture, email } =
      await setupInvitationPreviewContext("taxed-invite");
    const paymentMethodId = `pm_invite_${randomUUID()}`;
    const invoiceId = `in_invite_${randomUUID()}`;
    const hostedInvoiceUrl = `https://invoice.stripe.test/${invoiceId}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      default_payment_method: paymentMethodId,
    });
    mockInvitationChargePreview({
      lines: [
        {
          lineAmountCents: -2000,
          subtotalCents: -2000,
          exclusiveTaxCents: -200,
        },
        {
          lineAmountCents: 2800,
          subtotalCents: 3000,
          exclusiveTaxCents: 280,
        },
      ],
      periodEnd: fixture.billingPeriod.end,
      automaticTax: true,
    });
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    const capturedAt = new Date(now()).toISOString();
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: fixture.userId, privateMetadata: {} }],
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: fixture.customerId,
      metadata: {},
    });
    const recordImpact = (clickId: string, timestamp: string) => {
      return accept(
        setupApp({ context, routes: acquisitionAttributionRoutes })(
          acquisitionAttributionContract,
        ).recordSignup({
          body: {
            attribution: {},
            impactAttribution: { clickId, capturedAt: timestamp },
          },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
    };
    await recordImpact("invitation-preview-partner", capturedAt);
    const client = setupApp({ context, routes: orgInviteRoutes })(
      orgInviteContract,
    );
    const preview = await accept(
      client.previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: { email, role: "member", usagePackUsd: 20 },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual(
      expect.objectContaining({
        immediateAmountCents: 880,
        purchasedCredits: 10_000,
        bonusCredits: 200,
      }),
    );
    const metadata = {
      purpose: "usage_pack_invitation_purchase",
      usagePackInvitationPurchaseId: preview.body.purchaseId,
      impact_click_id: "invitation-preview-partner",
      impact_click_at: capturedAt,
    };
    context.mocks.stripe.invoices.create.mockResolvedValue({
      id: invoiceId,
      metadata,
      status: "draft",
      hosted_invoice_url: null,
    });
    context.mocks.stripe.invoiceItems.create.mockResolvedValue({
      id: `ii_${randomUUID()}`,
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: invoiceId,
      metadata,
      status: "open",
      hosted_invoice_url: hostedInvoiceUrl,
    });
    context.mocks.stripe.invoices.pay.mockResolvedValue({
      id: invoiceId,
      metadata,
      status: "open",
      hosted_invoice_url: hostedInvoiceUrl,
    });

    mockNow(new Date(now() + 60_000));
    await recordImpact(
      "partner-after-invitation-preview",
      new Date(now()).toISOString(),
    );
    const confirmation = await accept(
      client.confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: preview.body.purchaseId },
        body: {},
      }),
      [200],
    );

    expect(confirmation.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      {
        customer: fixture.customerId,
        auto_advance: false,
        default_payment_method: paymentMethodId,
        metadata,
        discounts: "",
        automatic_tax: {
          enabled: true,
          liability: { type: "self" },
        },
      },
      {
        idempotencyKey: `usage-pack-invitation:${preview.body.purchaseId}:invoice`,
      },
    );
    expect(context.mocks.stripe.invoiceItems.create).toHaveBeenCalledWith(
      {
        invoice: invoiceId,
        customer: fixture.customerId,
        amount: 800,
        currency: "usd",
        description: `Member usage pack for ${email}`,
        discountable: false,
        period: {
          start: expect.any(Number),
          end: fixture.billingPeriod.end,
        },
        subscription: fixture.subscriptionId,
        tax_behavior: "exclusive",
        tax_code: "txcd_10000000",
      },
      {
        idempotencyKey: `usage-pack-invitation:${preview.body.purchaseId}:invoice-item`,
      },
    );
  });

  it("uses one hosted invoice payment when an invitation buyer has no saved card", async () => {
    const existingMemberUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([
      { userId: existingMemberUserId, usagePackUsd: 20 },
    ]);
    const email = `setup-invite-${randomUUID()}@example.test`;
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: {
              userId: existingMemberUserId,
              identifier: `${existingMemberUserId}@example.test`,
            },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      default_payment_method: null,
      default_source: null,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: fixture.customerId,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    mockUsagePackChangePreviews(1000, 2000);

    const client = setupApp({ context, routes: orgInviteRoutes })(
      orgInviteContract,
    );
    const firstReturnUrl = `${APP_ORIGIN}/billing?invite=first`;
    const secondReturnUrl = `${APP_ORIGIN}/settings?invite=second`;
    const previewBody = {
      email,
      role: "member" as const,
      usagePackUsd: 20 as const,
      supportsInAppPreview: true,
    };
    const first = await accept(
      client.previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: { ...previewBody, returnUrl: firstReturnUrl },
      }),
      [200],
    );
    const second = await accept(
      client.previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: { ...previewBody, returnUrl: secondReturnUrl },
      }),
      [200],
    );

    expect(first.body.purchaseId).toBe(second.body.purchaseId);
    expect(first.body).not.toHaveProperty("checkoutUrl");
    expect(first.body).not.toHaveProperty("paymentMethodPreviewToken");
    expect(second.body).not.toHaveProperty("checkoutUrl");
    expect(second.body).not.toHaveProperty("paymentMethodPreviewToken");
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();

    const invoiceId = `in_${randomUUID()}`;
    const hostedInvoiceUrl = `https://invoice.stripe.test/${invoiceId}`;
    const metadata = {
      purpose: "usage_pack_invitation_purchase",
      usagePackInvitationPurchaseId: first.body.purchaseId,
    };
    context.mocks.stripe.invoices.create.mockResolvedValue({
      id: invoiceId,
      metadata,
      status: "draft",
      hosted_invoice_url: null,
    });
    context.mocks.stripe.invoiceItems.create.mockResolvedValue({
      id: `ii_${randomUUID()}`,
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: invoiceId,
      metadata,
      status: "open",
      hosted_invoice_url: hostedInvoiceUrl,
    });
    context.mocks.stripe.invoices.pay.mockRejectedValue(
      new Error("No payment method"),
    );
    context.mocks.stripe.invoices.retrieve.mockResolvedValue({
      id: invoiceId,
      metadata,
      status: "open",
      hosted_invoice_url: hostedInvoiceUrl,
    });

    const confirmation = await accept(
      client.confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: first.body.purchaseId },
        body: {},
      }),
      [200],
    );
    expect(confirmation.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      {
        customer: fixture.customerId,
        auto_advance: false,
        metadata,
        discounts: "",
      },
      {
        idempotencyKey: `usage-pack-invitation:${first.body.purchaseId}:invoice`,
      },
    );
  });

  it("recovers a saved-card invitation from a transient post-payment Clerk server failure", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockNow(new Date("2035-05-15T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const existingMemberUserId = `user_${randomUUID()}`;
    const fixture = await seedManagedUsagePack([
      { userId: existingMemberUserId, usagePackUsd: 20 },
    ]);
    const email = `direct-invite-${randomUUID()}@example.test`;
    const paymentMethodId = `pm_invite_${randomUUID()}`;
    const invoiceId = `in_invite_${randomUUID()}`;
    const paymentIntentId = `pi_invite_${randomUUID()}`;
    const invitationId = `inv_direct_${randomUUID()}`;
    const subscription = {
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      default_payment_method: paymentMethodId,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: {
              userId: existingMemberUserId,
              identifier: `${existingMemberUserId}@example.test`,
            },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
      {
        id: invitationId,
        emailAddress: email,
        organizationId: fixture.orgId,
        status: "pending",
      },
    );
    mockUsagePackChangePreviews(1000, 2000);
    context.mocks.stripe.checkout.sessions.create.mockClear();

    const client = setupApp({ context, routes: orgInviteRoutes })(
      orgInviteContract,
    );
    const previewBody = {
      email,
      role: "member" as const,
      usagePackUsd: 20 as const,
    };
    const preview = await accept(
      client.previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: previewBody,
        extraHeaders: { origin: "https://app.okou.ai" },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual({
      purchaseId: expect.any(String),
      usagePackUsd: 20,
      immediateAmountCents: 1000,
      currency: "usd",
      purchasedCredits: 10_000,
      bonusCredits: 200,
      totalCredits: 10_200,
      currentPeriodEnd: new Date(
        fixture.billingPeriod.end * 1000,
      ).toISOString(),
      expiresAt: expect.any(String),
    });
    const previewCallCount =
      context.mocks.stripe.invoices.createPreview.mock.calls.length;
    const repeatedPreview = await accept(
      client.previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: previewBody,
        extraHeaders: { origin: "https://app.okou.ai" },
      }),
      [200],
    );
    expect(repeatedPreview.body.purchaseId).toBe(preview.body.purchaseId);
    expect(context.mocks.stripe.invoices.createPreview.mock.calls).toHaveLength(
      previewCallCount,
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    const replacedPreview = await accept(
      client.previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: { ...previewBody, role: "admin" },
        extraHeaders: { origin: "https://app.okou.ai" },
      }),
      [200],
    );
    expect(replacedPreview.body.purchaseId).not.toBe(preview.body.purchaseId);
    const activePurchaseId = replacedPreview.body.purchaseId;
    const supersededConfirmation = await accept(
      client.confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: preview.body.purchaseId },
        body: {},
      }),
      [409],
    );
    expect(supersededConfirmation.body.error).toStrictEqual({
      code: "INVITATION_PURCHASE_INACTIVE",
      message:
        "This invitation purchase is no longer active. Review the invitation again.",
    });
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();

    const metadata = {
      purpose: "usage_pack_invitation_purchase",
      usagePackInvitationPurchaseId: activePurchaseId,
    };
    context.mocks.stripe.invoices.create.mockResolvedValue({
      id: invoiceId,
      metadata,
      status: "draft",
      hosted_invoice_url: null,
    });
    context.mocks.stripe.invoiceItems.create.mockResolvedValue({
      id: `ii_invite_${randomUUID()}`,
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: invoiceId,
      status: "open",
      hosted_invoice_url: `https://invoice.stripe.test/${invoiceId}`,
    });
    context.mocks.stripe.invoices.pay.mockResolvedValue({
      id: invoiceId,
      status: "paid",
    });
    const paidInvoice = {
      id: invoiceId,
      customer: fixture.customerId,
      metadata,
      status: "paid",
      paid: true,
      currency: "usd",
      status_transitions: { paid_at: Math.floor(now() / 1000) },
      payments: {
        data: [
          {
            status: "paid",
            amount_paid: 1000,
            payment: {
              type: "payment_intent",
              payment_intent: paymentIntentId,
            },
          },
        ],
      },
    };
    context.mocks.stripe.invoices.retrieve.mockResolvedValue(paidInvoice);
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockClear();
    context.mocks.clerk.organizations.getOrganizationMembershipList
      .mockResolvedValueOnce({
        data: [
          {
            publicUserData: {
              userId: existingMemberUserId,
              identifier: `${existingMemberUserId}@example.test`,
            },
            createdAt: now(),
          },
        ],
      })
      .mockRejectedValueOnce(new ClerkApiResponseTestError(2, 521))
      .mockResolvedValue({
        data: [
          {
            publicUserData: {
              userId: existingMemberUserId,
              identifier: `${existingMemberUserId}@example.test`,
            },
            createdAt: now(),
          },
        ],
      });

    const confirmed = await accept(
      client.confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: activePurchaseId },
        body: {},
      }),
      [200],
    );

    expect(confirmed.body.message).toBe("Invitation purchased and sent");
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(3);
    expect(context.mocks.signalTimers.delay).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      {
        customer: fixture.customerId,
        auto_advance: false,
        default_payment_method: paymentMethodId,
        metadata,
        discounts: "",
      },
      {
        idempotencyKey: `usage-pack-invitation:${activePurchaseId}:invoice`,
      },
    );
    expect(context.mocks.stripe.invoiceItems.create).toHaveBeenCalledWith(
      {
        invoice: invoiceId,
        customer: fixture.customerId,
        amount: 1000,
        currency: "usd",
        description: `Member usage pack for ${email}`,
        discountable: false,
        period: {
          start: expect.any(Number),
          end: fixture.billingPeriod.end,
        },
        subscription: fixture.subscriptionId,
        tax_behavior: "exclusive",
        tax_code: "txcd_10000000",
      },
      {
        idempotencyKey: `usage-pack-invitation:${activePurchaseId}:invoice-item`,
      },
    );
    expect(context.mocks.stripe.invoices.finalizeInvoice).toHaveBeenCalledWith(
      invoiceId,
      {},
      {
        idempotencyKey: `billing-operation:usage-pack-invitation:${activePurchaseId}:finalize`,
      },
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      invoiceId,
      {},
      {
        idempotencyKey: `billing-operation:usage-pack-invitation:${activePurchaseId}:pay`,
      },
    );
    await postManagedUsagePackEvent("invoice.paid", {
      id: invoiceId,
      customer: fixture.customerId,
      metadata,
      status: "paid",
    });
    await accept(
      client.confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: activePurchaseId },
        body: {},
      }),
      [200],
    );
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: fixture.orgId,
        emailAddress: email,
        inviterUserId: fixture.userId,
        role: "org:admin",
        redirectUrl: "https://app.okou.ai",
        privateMetadata: {
          usagePackInvitationPurchaseId: activePurchaseId,
        },
      }),
    );
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledTimes(1);

    mockClerkOrganization(fixture);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      {
        data: [
          {
            id: invitationId,
            emailAddress: email,
            organizationId: fixture.orgId,
            role: "org:admin",
            status: "pending",
            createdAt: now(),
          },
        ],
      },
    );
    server.use(
      http.get(
        "https://api.clerk.com/v1/organizations/:orgId/membership_requests",
        () => {
          return HttpResponse.json({ data: [] });
        },
      ),
    );
    const members = await accept(
      setupApp({ context, routes: orgReadRoutes })(orgMembersContract).members({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(members.body.pendingInvitations).toStrictEqual([
      expect.objectContaining({
        id: invitationId,
        email,
        usagePackUsd: 20,
      }),
    ]);
  });

  it("returns a retryable 503 before starting payment on the first Clerk rate limit", async () => {
    const purchase = await beginInvitationPurchase();
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockClear();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkApiResponseTestError(7),
    );
    context.mocks.stripe.invoices.createPreview.mockClear();

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      ).previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          email: `rate-limited-${randomUUID()}@example.test`,
          role: "member",
          usagePackUsd: 20,
        },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Billing organization members are temporarily unavailable",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
    expect(
      (
        await readUsagePackState(
          purchase.fixture.orgId,
          purchase.fixture.usagePackSubscriptionId,
        )
      ).invitationPurchases,
    ).toHaveLength(1);
  });

  it("preserves non-rate-limit Clerk invitation purchase failures", async () => {
    const purchase = await beginInvitationPurchase();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockClear();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new Error("Clerk membership read failed"),
    );
    context.mocks.stripe.invoices.createPreview.mockClear();

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      ).previewPurchase({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          email: `failed-${randomUUID()}@example.test`,
          role: "member",
          usagePackUsd: 20,
        },
      }),
      [500],
    );

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(
      (
        await readUsagePackState(
          purchase.fixture.orgId,
          purchase.fixture.usagePackSubscriptionId,
        )
      ).invitationPurchases,
    ).toHaveLength(1);
  });

  it("stops Clerk 5xx retries when an invitation purchase is cancelled", async () => {
    await beginInvitationPurchase();
    const controller = new AbortController();
    const retryStarted = createDeferredPromise<void>(context.signal);
    let retrySignal: AbortSignal | undefined;
    context.mocks.signalTimers.delay.mockImplementation((_ms, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("Expected Clerk retry delay to receive a signal");
      }
      retrySignal = signal;
      retryStarted.resolve();
      return createDeferredPromise<void>(signal).promise;
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockClear();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkApiResponseTestError(1, 521),
    );
    context.mocks.stripe.invoices.createPreview.mockClear();
    const request = setupApp({ context, routes: orgInviteRoutes })(
      orgInviteContract,
    ).previewPurchase({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        email: `cancelled-${randomUUID()}@example.test`,
        role: "member",
        usagePackUsd: 20,
      },
      fetchOptions: { signal: controller.signal },
    });

    await retryStarted.promise;
    const abortError = new Error("invitation purchase cancelled");
    abortError.name = "AbortError";
    controller.abort(abortError);
    expect(retrySignal?.aborted).toBeTruthy();
    const response = await accept(request, [500]);

    expect(response.status).toBe(500);
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("resumes invitation creation on a later request after a post-payment Clerk rate limit", async () => {
    const purchase = await beginInvitationPurchase();
    const paymentIntentId = mockSavedCardInvitationPayment(purchase);
    const invitationId = `inv_resumed_${randomUUID()}`;
    const existingMember = {
      publicUserData: {
        userId: purchase.existingMemberUserId,
        identifier: `${purchase.existingMemberUserId}@example.test`,
      },
      createdAt: now(),
    };
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockClear();
    context.mocks.clerk.organizations.getOrganizationMembershipList
      .mockResolvedValueOnce({ data: [existingMember] })
      .mockRejectedValue(new ClerkApiResponseTestError(9));
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    const client = setupApp({ context, routes: orgInviteRoutes })(
      orgInviteContract,
    );

    const limited = await accept(
      client.confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: purchase.purchaseId },
        body: {},
      }),
      [503],
    );

    expect(limited.headers.get("Retry-After")).toBe("9");
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(2);
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    const paid = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(paid.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({
        status: "payment_succeeded",
        stripePaymentIntentId: paymentIntentId,
        clerkInvitationId: null,
        allocationId: null,
      }),
    );
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();

    context.mocks.clerk.organizations.getOrganizationMembershipList.mockClear();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [existingMember] },
    );
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
      {
        id: invitationId,
        emailAddress: purchase.email,
        organizationId: purchase.fixture.orgId,
        status: "pending",
      },
    );
    const resumed = await accept(
      client.confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: purchase.purchaseId },
        body: {},
      }),
      [200],
    );

    expect(resumed.body.message).toBe("Invitation purchased and sent");
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledTimes(1);
    const completed = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(completed.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({
        status: "invitation_pending",
        clerkInvitationId: invitationId,
      }),
    );
  });

  it("does not reclassify a Clerk invitation mutation rate limit as a retryable read", async () => {
    const purchase = await beginInvitationPurchase();
    mockSavedCardInvitationPayment(purchase);
    const existingMember = {
      publicUserData: {
        userId: purchase.existingMemberUserId,
        identifier: `${purchase.existingMemberUserId}@example.test`,
      },
      createdAt: now(),
    };
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [existingMember] },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.clerk.organizations.createOrganizationInvitation.mockRejectedValueOnce(
      new ClerkApiResponseTestError(4),
    );

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      ).confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: purchase.purchaseId },
        body: {},
      }),
      [500],
    );

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledTimes(1);
    const state = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(state.invitationPurchases[0]?.status).toBe("creating_invitation");
  });

  it("rejects an invalid invitation payment preview with a stable error", async () => {
    const purchase = await beginInvitationPurchase();

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      ).confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: purchase.purchaseId },
        body: { paymentMethodPreviewToken: "invalid-preview-token" },
      }),
      [409],
    );

    expect(response.body.error).toStrictEqual({
      code: "INVITATION_PURCHASE_PREVIEW_INVALID",
      message:
        "This invitation purchase preview is no longer valid. Review the invitation again.",
    });
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();
  });

  it("returns a hosted invoice for a pending invitation payment to an older client", async () => {
    const purchase = await beginInvitationPurchase();
    const paymentMethodId = `pm_invite_${randomUUID()}`;
    const invoiceId = `in_invite_${randomUUID()}`;
    const hostedInvoiceUrl = `https://invoice.stripe.test/${invoiceId}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...managedUsagePackSubscription(
        purchase.fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      default_payment_method: paymentMethodId,
    });
    const metadata = {
      purpose: "usage_pack_invitation_purchase",
      usagePackInvitationPurchaseId: purchase.purchaseId,
    };
    context.mocks.stripe.invoices.create.mockResolvedValue({
      id: invoiceId,
      metadata,
      status: "draft",
      hosted_invoice_url: null,
    });
    context.mocks.stripe.invoiceItems.create.mockResolvedValue({
      id: `ii_invite_${randomUUID()}`,
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: invoiceId,
      metadata,
      status: "open",
      hosted_invoice_url: hostedInvoiceUrl,
    });
    context.mocks.stripe.invoices.pay.mockResolvedValue({
      id: invoiceId,
      metadata,
      status: "open",
      hosted_invoice_url: hostedInvoiceUrl,
    });

    const response = await accept(
      setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      ).confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: purchase.purchaseId },
        body: {},
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl,
    });
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("ignores invitation PaymentIntents from another preview job", async () => {
    const purchase = await beginInvitationPurchase();
    mockEnv("ENV", "preview");
    mockOptionalEnv("OKOU_PREVIEW_JOB_REF", "pr-current");

    await postManagedUsagePackEvent("payment_intent.succeeded", {
      id: purchase.paymentIntentId,
      status: "succeeded",
      customer: purchase.fixture.customerId,
      payment_method: null,
      amount_received: 1000,
      currency: "usd",
      created: Math.floor(now() / 1000),
      metadata: {
        purpose: "usage_pack_invitation_purchase",
        usagePackInvitationPurchaseId: purchase.purchaseId,
        vm0_environment: "preview",
        job_ref: "pr-other",
      },
    });
    mockEnv("ENV", "development");

    const state = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(state.invitationPurchases[0]?.status).toBe("checkout_pending");
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("activates one paid invitation exactly once after Clerk acceptance", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_paid_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    await payInvitationPurchase(purchase, invitationId);

    const pending = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(pending.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({
        status: "invitation_pending",
        amountPaidCents: 1000,
        stripePaymentIntentId: purchase.paymentIntentId,
        clerkInvitationId: invitationId,
      }),
    );
    expect(
      pending.allocations.find((allocation) => {
        return allocation.invitationId === invitationId;
      })?.status,
    ).toBe("paid_pending_invitation");
    expect(
      new Set(
        pending.grants.map((grant) => {
          return grant.userId;
        }),
      ),
    ).toStrictEqual(new Set([purchase.existingMemberUserId]));
    expect(pending.grants).toHaveLength(2);
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    const acceptedUserId = `user_invited_${randomUUID()}`;
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    await postClerkInvitationAccepted({
      purchase,
      invitationId,
      userId: acceptedUserId,
    });
    await postClerkInvitationAccepted({
      purchase,
      invitationId,
      userId: acceptedUserId,
    });

    const accepted = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(accepted.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({
        status: "accepted",
        acceptedUserId,
      }),
    );
    expect(
      accepted.allocations.filter((allocation) => {
        return allocation.userId === acceptedUserId;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        invitationId: null,
        status: "active",
        usagePackUsd: 20,
      }),
    ]);
    expect(
      accepted.grants.filter((grant) => {
        return grant.userId === acceptedUserId;
      }),
    ).toStrictEqual([
      {
        userId: acceptedUserId,
        grantType: "bonus",
        originalAmount: 200,
        expiresAt: new Date(
          purchase.fixture.billingPeriod.end * 1000,
        ).toISOString(),
      },
      {
        userId: acceptedUserId,
        grantType: "purchased",
        originalAmount: 10_000,
        expiresAt: new Date(
          purchase.fixture.billingPeriod.end * 1000,
        ).toISOString(),
      },
    ]);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      purchase.fixture.subscriptionId,
      {
        items: [{ id: `si_${TEST_PRICE_USAGE_PACK_20}`, quantity: 2 }],
        proration_behavior: "none",
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(purchase.purchaseId),
      }),
    );
  });

  it("activates one paid invitation exactly once after Clerk creates the membership", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_membership_${randomUUID()}`;
    const acceptedUserId = `user_membership_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});

    await postClerkMembershipCreated({
      purchase,
      userId: acceptedUserId,
    });
    await postClerkMembershipCreated({
      purchase,
      userId: acceptedUserId,
    });

    const acceptedActor = {
      orgId: purchase.fixture.orgId,
      userId: acceptedUserId,
    };
    authenticateOrg(acceptedActor, "org:member");
    const credits = await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(credits.body).toStrictEqual({
      totalCredits: 10_200,
      purchasedCredits: 10_000,
      bonusCredits: 200,
      hasUsagePack: true,
      creditGrants: expect.arrayContaining([
        expect.objectContaining({
          grantType: "bonus",
          amount: 200,
          remaining: 200,
          expiresAt: new Date(
            purchase.fixture.billingPeriod.end * 1000,
          ).toISOString(),
        }),
        expect.objectContaining({
          grantType: "purchased",
          amount: 10_000,
          remaining: 10_000,
          expiresAt: new Date(
            purchase.fixture.billingPeriod.end * 1000,
          ).toISOString(),
        }),
      ]),
    });
    expect(credits.body.creditGrants).toHaveLength(2);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  it("infers a legacy invitation grant's refund source when Clerk removes the member", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_removed_${randomUUID()}`;
    const acceptedUserId = `user_removed_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    await postClerkInvitationAccepted({
      purchase,
      invitationId,
      userId: acceptedUserId,
    });
    context.mocks.stripe.subscriptions.update.mockClear();
    await usagePackStateAction({
      action: "set-grant-remaining",
      orgId: purchase.fixture.orgId,
      userId: acceptedUserId,
      grantType: "purchased",
      remainingAmount: 5000,
    });
    const sourced = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(sourced.refunds).toContainEqual(
      expect.objectContaining({
        userId: acceptedUserId,
        sourceType: "payment_intent",
        status: "available",
      }),
    );
    await usagePackStateAction({
      action: "delete-refund-source",
      orgId: purchase.fixture.orgId,
      userId: acceptedUserId,
    });

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        purchase.fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
      ),
    );
    context.mocks.stripe.refunds.create
      .mockResolvedValueOnce({
        id: `re_removed_failed_${randomUUID()}`,
        status: "failed",
      })
      .mockResolvedValueOnce({
        id: `re_removed_succeeded_${randomUUID()}`,
        status: "succeeded",
      });
    const event = {
      type: "organizationMembership.deleted",
      data: {
        id: `mem_removed_${randomUUID()}`,
        organization: { id: purchase.fixture.orgId },
        publicUserData: { userId: acceptedUserId },
        role: "org:member",
      },
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
      await accept(
        setupApp({ context, routes: webhooksClerkRoutes })(
          webhookClerkContract,
        ).post({ body: JSON.stringify(event) }),
        [200],
      );
      await flushWaitUntilForTest();
    }

    const removed = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(removed.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({
        status: "accepted",
        acceptedUserId,
      }),
    );
    expect(
      removed.allocations.find((allocation) => {
        return allocation.userId === acceptedUserId;
      })?.status,
    ).toBe("inactive");
    expect(removed.remainingCredits).toContainEqual({
      userId: acceptedUserId,
      amount: 0,
    });
    expect(removed.changes).toContainEqual(
      expect.objectContaining({
        userId: acceptedUserId,
        kind: "removal",
        status: "completed",
      }),
    );
    expect(removed.refunds).toContainEqual(
      expect.objectContaining({
        userId: acceptedUserId,
        sourceType: "payment_intent",
        sourceAmountCents: 1000,
        status: "succeeded",
        refundCredits: 5000,
        requestedAmountCents: 500,
        refundedAmountCents: 500,
      }),
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(2);
    expect(context.mocks.stripe.refunds.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        payment_intent: purchase.paymentIntentId,
        amount: 500,
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:[0-9a-f-]+:1$/u,
        ),
      }),
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payment_intent: purchase.paymentIntentId,
        amount: 500,
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:[0-9a-f-]+:2$/u,
        ),
      }),
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      purchase.fixture.subscriptionId,
      {
        items: [{ id: `si_${TEST_PRICE_USAGE_PACK_20}`, quantity: 1 }],
        proration_behavior: "none",
      },
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("member-removal"),
      }),
    );
  });

  it("reconciles an in-flight member refund without creating a duplicate Stripe refund", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_processing_${randomUUID()}`;
    const acceptedUserId = `user_processing_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    await postClerkInvitationAccepted({
      purchase,
      invitationId,
      userId: acceptedUserId,
    });
    context.mocks.stripe.subscriptions.update.mockClear();
    await usagePackStateAction({
      action: "set-grant-remaining",
      orgId: purchase.fixture.orgId,
      userId: acceptedUserId,
      grantType: "purchased",
      remainingAmount: 5000,
    });

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        purchase.fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
      ),
    );
    const stripeRefundId = `re_processing_${randomUUID()}`;
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: stripeRefundId,
      status: "pending",
    });
    const event = {
      type: "organizationMembership.deleted",
      data: {
        id: `mem_processing_${randomUUID()}`,
        organization: { id: purchase.fixture.orgId },
        publicUserData: { userId: acceptedUserId },
        role: "org:member",
      },
    };
    context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({ body: JSON.stringify(event) }),
      [200],
    );
    await flushWaitUntilForTest();

    const processing = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(processing.refunds).toContainEqual(
      expect.objectContaining({
        userId: acceptedUserId,
        status: "processing",
        stripeRefundId,
      }),
    );

    context.mocks.stripe.refunds.retrieve.mockResolvedValue({
      id: stripeRefundId,
      status: "succeeded",
    });
    await reconcileBillingOrganization(purchase.fixture.orgId);

    const reconciled = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(reconciled.refunds).toContainEqual(
      expect.objectContaining({
        userId: acceptedUserId,
        status: "succeeded",
        refundedAmountCents: 500,
        stripeRefundId,
      }),
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.refunds.retrieve).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.refunds.retrieve).toHaveBeenCalledWith(
      stripeRefundId,
    );
  });

  async function prepareAlreadyRefundedMember(
    sourceType: "invoice" | "payment_intent",
  ) {
    const actor = createOrgFixture();
    let fixture: ManagedUsagePackFixture;
    let userId: string;
    let paymentIntentId: string;
    if (sourceType === "payment_intent") {
      const purchase = await beginInvitationPurchase(actor);
      const invitationId = `inv_${randomUUID()}`;
      userId = `user_${randomUUID()}`;
      await payInvitationPurchase(purchase, invitationId);
      context.mocks.stripe.subscriptions.update.mockResolvedValue({});
      await postClerkInvitationAccepted({ purchase, invitationId, userId });
      fixture = purchase.fixture;
      paymentIntentId = purchase.paymentIntentId;
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        managedUsagePackSubscription(
          fixture,
          new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
        ),
      );
    } else {
      userId = actor.userId;
      fixture = await seedManagedUsagePack(
        [{ userId, usagePackUsd: 20 }],
        "pro",
        actor,
      );
      paymentIntentId = `pi_${randomUUID()}`;
      context.mocks.stripe.creditNotes.preview.mockResolvedValue({
        id: `cn_preview_${randomUUID()}`,
        status: "issued",
        pre_payment_amount: 0,
        post_payment_amount: 500,
        refunds: [],
      });
      context.mocks.stripe.invoices.retrieve.mockResolvedValue({
        payments: {
          data: [
            {
              status: "paid",
              amount_paid: 2000,
              payment: {
                type: "payment_intent",
                payment_intent: paymentIntentId,
              },
            },
          ],
        },
      });
    }
    await usagePackStateAction({
      action: "set-grant-remaining",
      orgId: fixture.orgId,
      userId,
      grantType: "purchased",
      remainingAmount: 5000,
      prepareRefund: true,
      refundState: {
        status: "processing",
        refundedAmountCents: null,
        stripeCreditNoteId: null,
        stripeRefundId: null,
        attempt: 1,
        failureReason: null,
      },
    });
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    const localRefund = state.refunds.find((refund) => {
      return refund.userId === userId;
    });
    if (!localRefund) {
      throw new Error("Expected a prepared member refund");
    }
    const existingRefund = {
      id: `re_${randomUUID()}`,
      status: "succeeded",
      amount: 500,
      payment_intent: paymentIntentId,
      metadata: {
        purpose: "usage_pack_member_credit_refund",
        orgId: fixture.orgId,
        userId,
        creditGrantId: localRefund.creditGrantId,
      },
    };
    context.mocks.stripe.refunds.create.mockRejectedValue(
      new StripeSDK.errors.StripeInvalidRequestError({
        type: "invalid_request_error",
        code: "charge_already_refunded",
        message: "Charge has already been refunded.",
      }),
    );
    context.mocks.stripe.creditNotes.create.mockResolvedValue({
      id: `cn_${randomUUID()}`,
      status: "issued",
      pre_payment_amount: 0,
      post_payment_amount: 500,
      refunds: [{ amount_refunded: 500, refund: existingRefund.id }],
    });
    return { fixture, userId, existingRefund };
  }

  it.each(["invoice", "payment_intent"] as const)(
    "recovers an already-refunded %s charge and stops retrying",
    async (sourceType) => {
      const { fixture, userId, existingRefund } =
        await prepareAlreadyRefundedMember(sourceType);
      const unrelatedRefund = {
        ...existingRefund,
        id: `re_other_${randomUUID()}`,
        amount: 100,
      };
      context.mocks.stripe.refunds.list
        .mockResolvedValueOnce({ data: [unrelatedRefund], has_more: true })
        .mockResolvedValueOnce({ data: [existingRefund], has_more: false });

      await runBillingReconciliation(fixture.orgId);
      await runBillingReconciliation(fixture.orgId);

      const state = await readUsagePackState(
        fixture.orgId,
        fixture.usagePackSubscriptionId,
      );
      expect(state.refunds).toContainEqual(
        expect.objectContaining({
          userId,
          status: "succeeded",
          stripeRefundId: existingRefund.id,
          refundedAmountCents: 500,
          failureReason: null,
        }),
      );
      expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(1);
      expect(context.mocks.stripe.refunds.list).toHaveBeenLastCalledWith({
        payment_intent: existingRefund.payment_intent,
        limit: 100,
        starting_after: unrelatedRefund.id,
      });
      if (sourceType === "invoice") {
        expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledWith(
          expect.objectContaining({
            refunds: [{ refund: existingRefund.id, amount_refunded: 500 }],
          }),
          expect.any(Object),
        );
      } else {
        expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["amount", "ownership", "status", "ambiguous"])(
    "stops already-refunded charge retries for an unresolved %s mismatch",
    async (mismatch) => {
      const { fixture, userId, existingRefund } =
        await prepareAlreadyRefundedMember("payment_intent");
      const refund = {
        ...existingRefund,
        amount: mismatch === "amount" ? 1000 : existingRefund.amount,
        status: mismatch === "status" ? "pending" : existingRefund.status,
        metadata: {
          ...existingRefund.metadata,
          creditGrantId:
            mismatch === "ownership"
              ? randomUUID()
              : existingRefund.metadata.creditGrantId,
        },
      };
      context.mocks.stripe.refunds.list.mockResolvedValue({
        data:
          mismatch === "ambiguous"
            ? [refund, { ...refund, id: `re_other_${randomUUID()}` }]
            : [refund],
        has_more: false,
      });

      await runBillingReconciliation(fixture.orgId);
      await runBillingReconciliation(fixture.orgId);

      const state = await readUsagePackState(
        fixture.orgId,
        fixture.usagePackSubscriptionId,
      );
      expect(state.refunds).toContainEqual(
        expect.objectContaining({
          userId,
          status: "failed",
          stripeRefundId: null,
          refundedAmountCents: null,
          failureReason:
            mismatch === "ambiguous"
              ? "stripe_charge_already_refunded_ambiguous"
              : "stripe_charge_already_refunded_unmatched",
        }),
      );
      expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(1);
      expect(context.mocks.stripe.refunds.list).toHaveBeenCalledTimes(1);
    },
  );

  it("retries a failed Stripe refund lookup without claiming a terminal outcome", async () => {
    const { fixture, userId, existingRefund } =
      await prepareAlreadyRefundedMember("payment_intent");
    context.mocks.stripe.refunds.list
      .mockRejectedValueOnce(new Error("Stripe temporarily unavailable"))
      .mockResolvedValueOnce({ data: [existingRefund], has_more: false });

    await runBillingReconciliation(fixture.orgId);
    const pending = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(pending.refunds).toContainEqual(
      expect.objectContaining({ userId, status: "processing", attempt: 1 }),
    );
    await runBillingReconciliation(fixture.orgId);
    const reconciled = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(reconciled.refunds).toContainEqual(
      expect.objectContaining({
        userId,
        status: "succeeded",
        stripeRefundId: existingRefund.id,
      }),
    );
    const requests = context.mocks.stripe.refunds.create.mock.calls;
    expect(requests).toHaveLength(2);
    expect(requests[1]).toStrictEqual(requests[0]);
  });

  it("reconciles acceptance when the Stripe projection response is lost", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_projection_retry_${randomUUID()}`;
    const acceptedUserId = `user_projection_retry_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.stripe.subscriptions.update.mockRejectedValueOnce(
      new Error("Stripe response lost"),
    );

    await postClerkInvitationAccepted({
      purchase,
      invitationId,
      userId: acceptedUserId,
    });

    const activating = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(activating.invitationPurchases[0]?.status).toBe("activating");
    expect(
      activating.allocations.find((allocation) => {
        return allocation.userId === acceptedUserId;
      })?.status,
    ).toBe("paid_pending_invitation");
    expect(
      activating.grants.filter((grant) => {
        return grant.userId === acceptedUserId;
      }),
    ).toHaveLength(0);

    const renewalPeriod = {
      start: purchase.fixture.billingPeriod.end,
      end: purchase.fixture.billingPeriod.end + 30 * 86_400,
    };
    const renewalQuantities = new Map([[TEST_PRICE_USAGE_PACK_20, 2]]);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        purchase.fixture,
        renewalQuantities,
        renewalPeriod,
      ),
    );
    mockNow(new Date(renewalPeriod.start * 1000 + 1000));
    onTestFinished(() => {
      clearMockNow();
    });
    await postManagedUsagePackEvent(
      "invoice.paid",
      managedUsagePackInvoice(purchase.fixture, {
        invoiceId: `in_invitation_renewal_${randomUUID()}`,
        quantities: renewalQuantities,
        billingPeriod: renewalPeriod,
      }),
    );
    const renewed = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(renewed.invitationPurchases[0]?.status).toBe("activating");
    expect(
      renewed.allocations.find((allocation) => {
        return allocation.userId === acceptedUserId;
      })?.status,
    ).toBe("active");
    await runBillingReconciliation(purchase.fixture.orgId);

    const accepted = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(accepted.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({ status: "accepted", acceptedUserId }),
    );
    expect(
      accepted.allocations.find((allocation) => {
        return allocation.userId === acceptedUserId;
      })?.status,
    ).toBe("active");
    expect(
      accepted.grants.filter((grant) => {
        return grant.userId === acceptedUserId;
      }),
    ).toHaveLength(4);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  it("revokes and refunds a paid pending invitation exactly once", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_refund_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [{ id: invitationId }] },
    );
    context.mocks.clerk.organizations.revokeOrganizationInvitation.mockResolvedValue(
      {},
    );
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: `re_${randomUUID()}`,
      status: "succeeded",
    });
    const client = setupApp({ context, routes: orgInviteRoutes })(
      orgInviteContract,
    );
    await accept(
      client.revoke({
        headers: { authorization: "Bearer clerk-session" },
        body: { invitationId },
      }),
      [200],
    );
    await accept(
      client.revoke({
        headers: { authorization: "Bearer clerk-session" },
        body: { invitationId },
      }),
      [200],
    );

    const state = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(state.invitationPurchases[0]?.status).toBe("refunded");
    expect(
      state.allocations.find((allocation) => {
        return allocation.invitationId === invitationId;
      })?.status,
    ).toBe("inactive");
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: purchase.paymentIntentId,
        amount: 1000,
      }),
      expect.any(Object),
    );
  });

  it("honors acceptance just before expiration when reconciliation races the boundary", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_near_expiry_${randomUUID()}`;
    const acceptedUserId = `user_near_expiry_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            publicUserData: {
              userId: acceptedUserId,
              identifier: purchase.email,
            },
            createdAt: purchase.fixture.billingPeriod.end * 1000 - 1000,
          },
        ],
      },
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    mockNow(new Date(purchase.fixture.billingPeriod.end * 1000 + 1000));
    onTestFinished(() => {
      clearMockNow();
    });

    await runBillingReconciliation(purchase.fixture.orgId);

    const state = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(state.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({
        status: "accepted",
        acceptedUserId,
      }),
    );
    expect(
      state.allocations.filter((allocation) => {
        return allocation.userId === acceptedUserId;
      }),
    ).toStrictEqual([
      expect.objectContaining({ status: "active", usagePackUsd: 20 }),
    ]);
    expect(context.mocks.stripe.refunds.create).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).not.toHaveBeenCalled();
  });

  it("automatically expires an invitation and retries a failed refund", async () => {
    const purchase = await beginInvitationPurchase();
    const invitationId = `inv_expired_${randomUUID()}`;
    await payInvitationPurchase(purchase, invitationId);
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [{ id: invitationId }] },
    );
    context.mocks.stripe.refunds.create
      .mockResolvedValueOnce({
        id: `re_failed_${randomUUID()}`,
        status: "failed",
      })
      .mockResolvedValueOnce({
        id: `re_succeeded_${randomUUID()}`,
        status: "succeeded",
      });
    mockNow(new Date(purchase.fixture.billingPeriod.end * 1000));
    onTestFinished(() => {
      clearMockNow();
    });

    await runBillingReconciliation(purchase.fixture.orgId);
    const retryPending = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(retryPending.invitationPurchases[0]).toStrictEqual(
      expect.objectContaining({ status: "refund_pending", refundAttempt: 2 }),
    );

    await runBillingReconciliation(purchase.fixture.orgId);

    const refunded = await readUsagePackState(
      purchase.fixture.orgId,
      purchase.fixture.usagePackSubscriptionId,
    );
    expect(refunded.invitationPurchases[0]?.status).toBe("refunded");
    expect(
      refunded.allocations.find((allocation) => {
        return allocation.invitationId === invitationId;
      })?.status,
    ).toBe("inactive");
    expect(
      context.mocks.clerk.organizations.revokeOrganizationInvitation,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(2);
    expect(context.mocks.stripe.refunds.create).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      {
        idempotencyKey: `usage-pack-invitation:${purchase.purchaseId}:refund:1`,
      },
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      {
        idempotencyKey: `usage-pack-invitation:${purchase.purchaseId}:refund:2`,
      },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/checkout/complete", () => {
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
      expect((await readCredits()).body).toStrictEqual(
        creditsBeforeWebhook.body,
      );
    },
  );

  async function trackedSeed(values?: {
    readonly onboardingPaymentPending?: boolean;
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
      const fixture = values.onboardingPaymentPending
        ? await createOnboardingPaymentPendingOrg()
        : createOrgFixture();
      if (!values.onboardingPaymentPending) {
        authenticateOrg(fixture);
      }
      await createStripeCustomerOrgForFixture(fixture, values.stripeCustomerId);
      return fixture;
    }
    if (values?.onboardingPaymentPending) {
      return createOnboardingPaymentPendingOrg();
    }
    return createOrgFixture();
  }

  it("finds the plan item in a completed multi-item subscription", async () => {
    setUsagePackPrices();
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const fixture = await trackedSeed({
      onboardingPaymentPending: true,
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
    expect(status.onboardingPaymentPending).toBeTruthy();
    expect(status.currentPeriodEnd).toBeNull();
  });

  it("keeps checkout pending when the subscription is incomplete", async () => {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const fixture = await trackedSeed({
      onboardingPaymentPending: true,
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
    expect(status.onboardingPaymentPending).toBeTruthy();
    expect(status.currentPeriodEnd).toBeNull();
  });

  it.each([
    {
      campaignId: "24220469665",
      accountId: "7935750692",
      amountPaid: 20_000,
      key: "vm0_campaign_id",
    },
    {
      campaignId: "24220469665",
      accountId: "7935750692",
      amountPaid: 20_000,
      key: "okou_campaign_id",
    },
    { campaignId: "24154967178", accountId: null, amountPaid: 20_000 },
    { campaignId: undefined, accountId: null, amountPaid: 20_000 },
    { campaignId: "99999999999", accountId: null, amountPaid: 20_000 },
    { campaignId: "24220469665", accountId: null, amountPaid: undefined },
  ])(
    "returns a website paid conversion only for the owning account: $campaignId, amount $amountPaid",
    async ({ campaignId, accountId, amountPaid, key = "vm0_campaign_id" }) => {
      const customerId = `cus_${randomUUID().slice(0, 8)}`;
      const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
      const fixture = await trackedSeed({
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: "active",
        tier: "team",
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
        status: "active",
        cancel_at_period_end: false,
        latest_invoice: {
          id: "in_checkout_paid",
          metadata: {
            gclid: "original-paid-click",
            ...(campaignId ? { [key]: campaignId } : {}),
          },
          status: "paid",
          currency: "usd",
          amount_paid: amountPaid,
        },
        items: {
          data: [
            {
              price: { id: TEST_PRICE_TEAM },
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

      expect(response.body).toStrictEqual({
        completed: true,
        ...(accountId
          ? {
              googleAdsConversion: {
                transactionId: "in_checkout_paid",
                valueUsd: 200,
                googleAdsAccountId: accountId,
              },
            }
          : {}),
      });
    },
  );

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
      onboardingPaymentPending: true,
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

  it("rejects checkout sessions from another customer", async () => {
    const fixture = await trackedSeed({
      stripeCustomerId: `cus_${randomUUID().slice(0, 8)}`,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_other_customer",
      mode: "subscription",
      status: "complete",
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
  });
});

describe("POST /api/billing/concurrency-checkout", () => {
  beforeEach(() => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    setTierPrices();
  });

  async function trackedSeed(
    tier: OrgTier = "team",
  ): Promise<{ orgId: string; userId: string }> {
    const fixture = createOrgFixture();
    await seedOrgMetadata({ orgId: fixture.orgId, tier, credits: 0 });
    return fixture;
  }

  function recurringConcurrencyPreviewInvoice(quantity: number) {
    const line = {
      id: `il_${randomUUID()}`,
      amount: 10_000 * quantity,
      subtotal: 10_000 * quantity,
      quantity,
      price: { id: TEST_PRICE_CONCURRENCY },
      period: { start: 4_075_660_800, end: 4_078_252_800 },
      parent: {
        type: "subscription_item_details" as const,
        subscription_item_details: { proration: false },
      },
    };
    return {
      id: `in_recurring_${randomUUID()}`,
      amount_due: line.amount,
      currency: "usd",
      lines: { has_more: false, data: [line] },
    };
  }

  it("requires an active Plan subscription for a concurrency purchase", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await accept(
      setupApp({
        context,
        routes: billingConcurrencyCheckoutRoutes,
      })(billingConcurrencyCheckoutContract).create({
        body: {
          quantity: 3,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "An active Plan subscription is required to buy concurrency",
        code: "BAD_REQUEST",
      },
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("previews and adds concurrency to a Custom usage allowance subscription", async () => {
    const fixture = await trackedSeed("custom");
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID()}`;
    const periodStart = new Date(now() - 86_400_000);
    const periodEnd = new Date(now() + 30 * 86_400_000);
    await postSubscriptionInvoicePaid(context.signal, {
      ...fixture,
      tier: "custom",
      customerId,
      subscriptionId,
      currentPeriodEnd: periodEnd,
    });
    await postUsageAllowanceInvoicePaid(context.signal, {
      ...fixture,
      customerId,
      subscriptionId,
      shortWindowSeconds: 18_000,
      shortWindowUnits: 625_000,
      weeklyWindowSeconds: 604_800,
      weeklyWindowUnits: 5_000_000,
      effectiveAt: periodStart,
      expiresAt: periodEnd,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const paymentMethodId = `pm_${randomUUID()}`;
    const allowanceItem = {
      id: `si_${TEST_PRICE_USAGE_ALLOWANCE}`,
      price: { id: TEST_PRICE_USAGE_ALLOWANCE },
      quantity: 1,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
      customer: customerId,
      default_payment_method: paymentMethodId,
      latest_invoice: null,
      pending_update: null,
      items: { data: [allowanceItem] },
    });
    const recurringInvoice = recurringConcurrencyPreviewInvoice(3);
    const allowanceLine = {
      ...recurringInvoice.lines.data[0],
      id: `il_${randomUUID()}`,
      amount: 200_000,
      subtotal: 200_000,
      quantity: 1,
      price: { id: TEST_PRICE_USAGE_ALLOWANCE },
    };
    context.mocks.stripe.invoices.createPreview
      .mockImplementationOnce((input) => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("subscription_details" in input) ||
          typeof input.subscription_details !== "object" ||
          input.subscription_details === null ||
          !("proration_date" in input.subscription_details) ||
          typeof input.subscription_details.proration_date !== "number"
        ) {
          throw new Error("Expected a concurrency proration preview");
        }
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 5500,
          currency: "usd",
          lines: {
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 5500,
                pricing: {
                  price_details: { price: TEST_PRICE_CONCURRENCY },
                },
                parent: {
                  subscription_item_details: { proration: true },
                },
                period: { start: input.subscription_details.proration_date },
              },
            ],
          },
        });
      })
      .mockResolvedValueOnce({
        ...recurringInvoice,
        amount_due: 230_000,
        lines: {
          has_more: false,
          data: [allowanceLine, ...recurringInvoice.lines.data],
        },
      });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          allowanceItem,
          {
            id: `si_${TEST_PRICE_CONCURRENCY}`,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 3,
          },
        ],
      },
    });

    const client = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);
    const preview = await accept(
      client.preview({
        body: {
          quantity: 3,
          supportsInAppPreview: true,
          returnUrl: `${APP_ORIGIN}/billing`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const paymentMethodPreviewToken = preview.body.paymentMethodPreviewToken;
    if (!paymentMethodPreviewToken) {
      throw new Error("Expected a saved-payment-method preview token");
    }
    const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;
    const purchase = await accept(
      client.create({
        body: {
          quantity: 3,
          paymentMethodPreviewToken,
          successUrl,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 5500,
      nextRecurringAmountCents: 30_000,
      currency: "usd",
      paymentMethodPreviewToken: expect.any(String),
    });
    expect(purchase.body).toStrictEqual({ url: successUrl });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: subscriptionId,
      preview_mode: "next",
      subscription_details: {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
      },
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: subscriptionId,
      preview_mode: "recurring",
      subscription_details: {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
      },
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      1,
      subscriptionId,
      {
        default_payment_method: paymentMethodId,
      },
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      2,
      subscriptionId,
      {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("preserves an Atom allowance schedule and returns one payment page when adding concurrency", async () => {
    const fixture = await trackedSeed("custom");
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID()}`;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const periodStart = new Date(now() - 86_400_000);
    const allowanceEnd = new Date(now() + 30 * 86_400_000);
    const customEnd = new Date(now() + 180 * 86_400_000);
    const legacyAllowanceCancelAt = new Date(
      allowanceEnd.getTime() + 86_400_000,
    ).toISOString();
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    await postSubscriptionInvoicePaid(context.signal, {
      ...fixture,
      tier: "custom",
      customerId,
      subscriptionId,
      currentPeriodEnd: customEnd,
    });
    await postUsageAllowanceInvoicePaid(context.signal, {
      ...fixture,
      customerId,
      subscriptionId,
      shortWindowSeconds: 18_000,
      shortWindowUnits: 625_000,
      weeklyWindowSeconds: 604_800,
      weeklyWindowUnits: 5_000_000,
      effectiveAt: periodStart,
      expiresAt: allowanceEnd,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const periodStartUnix = Math.floor(periodStart.getTime() / 1000);
    const allowanceEndUnix = Math.floor(allowanceEnd.getTime() / 1000);
    const customEndUnix = Math.floor(customEnd.getTime() / 1000);
    const customItem = {
      id: `si_${TEST_PRICE_CUSTOM}`,
      price: { id: TEST_PRICE_CUSTOM },
      quantity: 1,
      metadata: {},
    };
    const allowanceMetadata = {
      allowanceStatus: "active",
      allowanceCancelAt: allowanceEnd.toISOString(),
      purpose: "usage_allowance",
      source: "atom_usage_allowance",
      orgId: fixture.orgId,
    };
    const allowanceItem = {
      id: `si_${TEST_PRICE_USAGE_ALLOWANCE}`,
      price: { id: TEST_PRICE_USAGE_ALLOWANCE },
      quantity: 1,
      metadata: allowanceMetadata,
    };
    const discountId = `di_${randomUUID()}`;
    const couponId = `coupon_${randomUUID()}`;
    const phaseDiscounts = [
      {
        coupon: null,
        discount: discountId,
        promotion_code: null,
      },
      {
        coupon: couponId,
        discount: null,
        promotion_code: null,
      },
    ];
    const schedule = {
      id: scheduleId,
      end_behavior: "cancel",
      current_phase: {
        start_date: periodStartUnix,
        end_date: allowanceEndUnix,
      },
      phases: [
        {
          start_date: periodStartUnix,
          end_date: allowanceEndUnix,
          currency: "usd",
          discounts: phaseDiscounts,
          metadata: {
            allowanceStatus: "active",
            allowanceCancelAt: legacyAllowanceCancelAt,
          },
          items: [customItem, allowanceItem],
          proration_behavior: "create_prorations",
        },
        {
          start_date: allowanceEndUnix,
          end_date: customEndUnix,
          currency: "usd",
          metadata: {
            allowanceStatus: "active",
            allowanceCancelAt: legacyAllowanceCancelAt,
            phase: "after-allowance",
          },
          items: [customItem],
          proration_behavior: "create_prorations",
        },
      ],
    };
    const subscription = {
      id: subscriptionId,
      customer: customerId,
      default_payment_method: null,
      default_source: null,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      latest_invoice: null,
      metadata: {
        allowanceStatus: "canceled",
        allowanceCancelAt: allowanceEnd.toISOString(),
      },
      pending_update: null,
      schedule: scheduleId,
      items: { data: [customItem, allowanceItem] },
    };
    const concurrencyInvoiceId = `in_concurrency_${randomUUID()}`;
    const updatedSubscription = {
      ...subscription,
      latest_invoice: {
        id: concurrencyInvoiceId,
        status: "draft",
        paid: false,
        hosted_invoice_url: null,
      },
      items: {
        data: [
          customItem,
          allowanceItem,
          {
            id: `si_${TEST_PRICE_CONCURRENCY}`,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 3,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(subscription)
      .mockResolvedValueOnce(subscription)
      .mockResolvedValueOnce(subscription)
      .mockResolvedValueOnce(updatedSubscription);
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockReset();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      schedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.invoices.createPreview.mockReset();
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (
        typeof input === "object" &&
        input !== null &&
        "subscription_details" in input &&
        typeof input.subscription_details === "object" &&
        input.subscription_details !== null &&
        "proration_date" in input.subscription_details &&
        typeof input.subscription_details.proration_date === "number"
      ) {
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 15_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 15_000,
                price: { id: TEST_PRICE_CONCURRENCY },
                period: { start: input.subscription_details.proration_date },
                parent: {
                  subscription_item_details: { proration: true },
                },
              },
            ],
          },
        });
      }
      return Promise.resolve(recurringConcurrencyPreviewInvoice(3));
    });
    const hostedInvoiceUrl = `https://invoice.stripe.test/${concurrencyInvoiceId}`;
    const openConcurrencyInvoice = {
      id: concurrencyInvoiceId,
      status: "open",
      paid: false,
      hosted_invoice_url: hostedInvoiceUrl,
    };
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue(
      openConcurrencyInvoice,
    );
    context.mocks.stripe.invoices.pay.mockRejectedValue(
      new Error("No payment method"),
    );
    context.mocks.stripe.invoices.retrieve.mockResolvedValue(
      openConcurrencyInvoice,
    );

    const client = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);
    const preview = await accept(
      client.preview({
        body: {
          quantity: 3,
          supportsInAppPreview: true,
          returnUrl: `${APP_ORIGIN}/billing`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;
    const purchase = await accept(
      client.create({
        body: {
          quantity: 3,
          successUrl,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const expectedPhases = [
      {
        start_date: periodStartUnix,
        end_date: allowanceEndUnix,
        currency: "usd",
        metadata: {
          allowanceStatus: "canceled",
          allowanceCancelAt: allowanceEnd.toISOString(),
        },
        items: [
          {
            price: TEST_PRICE_CUSTOM,
            quantity: 1,
            metadata: {},
          },
          {
            price: TEST_PRICE_USAGE_ALLOWANCE,
            quantity: 1,
            metadata: allowanceMetadata,
          },
          { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
        ],
        proration_behavior: "create_prorations",
        discounts: [{ discount: discountId }, { coupon: couponId }],
      },
      {
        start_date: allowanceEndUnix,
        end_date: customEndUnix,
        currency: "usd",
        items: [
          {
            price: TEST_PRICE_CUSTOM,
            quantity: 1,
            metadata: {},
          },
          { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
        ],
        metadata: {
          allowanceStatus: "canceled",
          allowanceCancelAt: allowanceEnd.toISOString(),
          phase: "after-allowance",
        },
        proration_behavior: "create_prorations",
      },
    ];
    expect(preview.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 15_000,
      nextRecurringAmountCents: 30_000,
      currency: "usd",
    });
    expect(preview.body).not.toHaveProperty("checkoutUrl");
    expect(preview.body).not.toHaveProperty("paymentMethodPreviewToken");
    expect(purchase.body).toStrictEqual({ url: hostedInvoiceUrl });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "cancel",
        proration_behavior: "none",
        phases: expectedPhases,
      },
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "cancel",
        proration_behavior: "always_invoice",
        phases: expectedPhases,
      },
      {
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:[^:]+:[^:]+:schedule-update$/u,
        ),
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.finalizeInvoice).toHaveBeenCalledWith(
      concurrencyInvoiceId,
      {},
      {
        idempotencyKey: `concurrency-change:${subscriptionId}:${concurrencyInvoiceId}:finalize`,
      },
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      concurrencyInvoiceId,
      {},
      {
        idempotencyKey: `concurrency-change:${subscriptionId}:${concurrencyInvoiceId}:pay`,
      },
    );
  });

  it("schedules a concurrency reduction at its monthly renewal inside an Atom allowance schedule", async () => {
    const fixture = await trackedSeed("custom");
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID()}`;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const currentTimestamp = currentSecond();
    const periodStart = new Date((currentTimestamp - 86_400) * 1000);
    const concurrencyPeriodEnd = new Date(
      (currentTimestamp + 29 * 86_400) * 1000,
    );
    const allowanceEnd = new Date((currentTimestamp + 90 * 86_400) * 1000);
    const customEnd = new Date((currentTimestamp + 180 * 86_400) * 1000);
    const legacyAllowanceCancelAt = new Date(
      (currentTimestamp + 91 * 86_400) * 1000,
    ).toISOString();
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    await postSubscriptionInvoicePaid(context.signal, {
      ...fixture,
      tier: "custom",
      customerId,
      subscriptionId,
      currentPeriodEnd: customEnd,
    });
    await postUsageAllowanceInvoicePaid(context.signal, {
      ...fixture,
      customerId,
      subscriptionId,
      shortWindowSeconds: 18_000,
      shortWindowUnits: 625_000,
      weeklyWindowSeconds: 604_800,
      weeklyWindowUnits: 5_000_000,
      effectiveAt: periodStart,
      expiresAt: allowanceEnd,
    });
    const periodStartUnix = Math.floor(periodStart.getTime() / 1000);
    const concurrencyPeriodEndUnix = Math.floor(
      concurrencyPeriodEnd.getTime() / 1000,
    );
    const allowanceEndUnix = Math.floor(allowanceEnd.getTime() / 1000);
    const customEndUnix = Math.floor(customEnd.getTime() / 1000);
    const concurrencyItemId = `si_${TEST_PRICE_CONCURRENCY}`;
    const concurrencyInvoiceEvent = {
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID()}`,
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
                id: `il_${randomUUID()}`,
                quantity: 10,
                price: { id: TEST_PRICE_CONCURRENCY },
                parent: { type: "subscription_item_details" },
                period: {
                  start: periodStartUnix,
                  end: concurrencyPeriodEndUnix,
                },
              },
            ],
          },
        },
      },
    };
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(
      concurrencyInvoiceEvent,
    );
    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(concurrencyInvoiceEvent),
        extraHeaders: { "stripe-signature": "t=1,v1=concurrency-monthly" },
      }),
      [200],
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const customItem = {
      id: `si_${TEST_PRICE_CUSTOM}`,
      price: { id: TEST_PRICE_CUSTOM },
      quantity: 1,
    };
    const allowanceMetadata = {
      purpose: "usage_allowance",
      source: "atom_usage_allowance",
      orgId: fixture.orgId,
    };
    const allowanceItem = {
      id: `si_${TEST_PRICE_USAGE_ALLOWANCE}`,
      price: { id: TEST_PRICE_USAGE_ALLOWANCE },
      quantity: 1,
      metadata: allowanceMetadata,
    };
    const concurrencyItem = {
      id: concurrencyItemId,
      price: {
        id: TEST_PRICE_CONCURRENCY,
        recurring: { interval: "month" as const, interval_count: 1 },
      },
      quantity: 10,
      current_period_start: periodStartUnix,
      current_period_end: concurrencyPeriodEndUnix,
    };
    const schedule = {
      id: scheduleId,
      end_behavior: "cancel" as const,
      current_phase: {
        start_date: periodStartUnix,
        end_date: allowanceEndUnix,
      },
      phases: [
        {
          start_date: periodStartUnix,
          end_date: allowanceEndUnix,
          currency: "usd",
          metadata: {
            allowanceStatus: "active",
            allowanceCancelAt: legacyAllowanceCancelAt,
          },
          items: [customItem, allowanceItem, concurrencyItem],
          proration_behavior: "none" as const,
        },
        {
          start_date: allowanceEndUnix,
          end_date: customEndUnix,
          currency: "usd",
          metadata: {
            allowanceStatus: "active",
            allowanceCancelAt: legacyAllowanceCancelAt,
            phase: "after-allowance",
          },
          items: [customItem, concurrencyItem],
          proration_behavior: "none" as const,
        },
      ],
    };
    const subscription = {
      id: subscriptionId,
      customer: customerId,
      status: "active",
      cancel_at_period_end: false,
      latest_invoice: null,
      metadata: {
        allowanceStatus: "canceled",
        allowanceCancelAt: allowanceEnd.toISOString(),
      },
      pending_update: null,
      schedule: scheduleId,
      items: { data: [customItem, allowanceItem, concurrencyItem] },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockReset();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      schedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.invoices.createPreview.mockReset();
    context.mocks.stripe.invoices.createPreview.mockResolvedValue(
      recurringConcurrencyPreviewInvoice(5),
    );

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);
    const preview = await accept(
      client.previewChange({
        params: { subscriptionId },
        body: { quantity: 5 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const expectedPhases = [
      {
        start_date: periodStartUnix,
        end_date: concurrencyPeriodEndUnix,
        currency: "usd",
        metadata: {
          allowanceStatus: "canceled",
          allowanceCancelAt: allowanceEnd.toISOString(),
        },
        items: [
          { price: TEST_PRICE_CUSTOM, quantity: 1 },
          {
            price: TEST_PRICE_USAGE_ALLOWANCE,
            quantity: 1,
            metadata: allowanceMetadata,
          },
          { price: TEST_PRICE_CONCURRENCY, quantity: 10 },
        ],
        proration_behavior: "none",
      },
      {
        start_date: concurrencyPeriodEndUnix,
        end_date: allowanceEndUnix,
        currency: "usd",
        metadata: {
          allowanceStatus: "canceled",
          allowanceCancelAt: allowanceEnd.toISOString(),
        },
        items: [
          { price: TEST_PRICE_CUSTOM, quantity: 1 },
          {
            price: TEST_PRICE_USAGE_ALLOWANCE,
            quantity: 1,
            metadata: allowanceMetadata,
          },
          { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
        ],
        proration_behavior: "none",
      },
      {
        start_date: allowanceEndUnix,
        end_date: customEndUnix,
        currency: "usd",
        items: [
          { price: TEST_PRICE_CUSTOM, quantity: 1 },
          { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
        ],
        metadata: {
          allowanceStatus: "canceled",
          allowanceCancelAt: allowanceEnd.toISOString(),
          phase: "after-allowance",
        },
        proration_behavior: "none",
      },
    ];
    expect(preview.body).toStrictEqual({
      currentQuantity: 10,
      targetQuantity: 5,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 50_000,
      currency: "usd",
      effectiveAt: concurrencyPeriodEnd.toISOString(),
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "cancel",
        proration_behavior: "none",
        phases: expectedPhases,
      },
    });

    const confirmed = await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 5 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmed.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
      effectiveAt: concurrencyPeriodEnd.toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "cancel",
        proration_behavior: "none",
        phases: expectedPhases,
      },
      { idempotencyKey: expect.any(String) },
    );
  });

  it("previews a concurrency purchase on the Plan subscription", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "custom" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_CUSTOM}`,
            price: {
              id: TEST_PRICE_CUSTOM,
            },
            quantity: 1,
          },
        ],
      },
    });
    const recurringInvoice = recurringConcurrencyPreviewInvoice(3);
    const planLine = {
      ...recurringInvoice.lines.data[0],
      id: `il_${randomUUID()}`,
      amount: 20_000,
      subtotal: 20_000,
      quantity: 1,
      price: { id: TEST_PRICE_TEAM },
    };
    context.mocks.stripe.invoices.listLineItems.mockResolvedValueOnce({
      has_more: false,
      data: [planLine, ...recurringInvoice.lines.data],
    });
    context.mocks.stripe.invoices.createPreview
      .mockImplementationOnce((input) => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("subscription_details" in input) ||
          typeof input.subscription_details !== "object" ||
          input.subscription_details === null ||
          !("proration_date" in input.subscription_details) ||
          typeof input.subscription_details.proration_date !== "number"
        ) {
          throw new Error("Expected a concurrency proration preview");
        }
        const prorationDate = input.subscription_details.proration_date;
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 5500,
          currency: "usd",
          lines: {
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 5500,
                pricing: {
                  price_details: { price: TEST_PRICE_CONCURRENCY },
                },
                parent: {
                  subscription_item_details: { proration: true },
                },
                period: { start: prorationDate },
              },
            ],
          },
        });
      })
      .mockResolvedValueOnce({
        ...recurringInvoice,
        amount_due: 50_000,
        lines: { has_more: true, data: [planLine] },
      });

    const response = await accept(
      setupApp({
        context,
        routes: billingConcurrencyCheckoutRoutes,
      })(billingConcurrencyCheckoutContract).preview({
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 5500,
      nextRecurringAmountCents: 30_000,
      currency: "usd",
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: fixture.subscriptionId,
      preview_mode: "next",
      subscription_details: {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
      },
    });
    expect(context.mocks.stripe.invoices.listLineItems).toHaveBeenCalledWith(
      recurringInvoice.id,
      { limit: 100 },
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: fixture.subscriptionId,
      preview_mode: "recurring",
      subscription_details: {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
      },
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("allows concurrency to expire with a Team subscription canceling at period end", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const periodStart = currentSecond() - 86_400;
    const periodEnd = currentSecond() + 29 * 86_400;
    const planItem = {
      id: `si_${TEST_PRICE_TEAM}`,
      price: { id: TEST_PRICE_TEAM },
      quantity: 1,
      current_period_start: periodStart,
      current_period_end: periodEnd,
    };
    const subscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: periodEnd,
      cancel_at_period_end: true,
      latest_invoice: null,
      metadata: {},
      pending_update: null,
      schedule: null,
      items: { data: [planItem] },
    };
    const concurrencyItem = {
      id: `si_${TEST_PRICE_CONCURRENCY}`,
      price: { id: TEST_PRICE_CONCURRENCY },
      quantity: 3,
      current_period_start: periodStart,
      current_period_end: periodEnd,
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.subscriptions.update.mockReset();
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...subscription,
      items: { data: [planItem, concurrencyItem] },
    });
    context.mocks.stripe.invoices.createPreview.mockReset();
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (
        typeof input === "object" &&
        input !== null &&
        "subscription_details" in input &&
        typeof input.subscription_details === "object" &&
        input.subscription_details !== null &&
        "proration_date" in input.subscription_details &&
        typeof input.subscription_details.proration_date === "number"
      ) {
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 15_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 15_000,
                price: { id: TEST_PRICE_CONCURRENCY },
                period: { start: input.subscription_details.proration_date },
                parent: {
                  subscription_item_details: { proration: true },
                },
              },
            ],
          },
        });
      }
      return Promise.reject(
        new StripeSDK.errors.StripeInvalidRequestError({
          type: "invalid_request_error",
          message:
            "Recurring estimates do not support the following features: subscription prorations, trials, cancellations, prebilling, schedules, and invoice item additions.",
        }),
      );
    });

    const client = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);
    const preview = await accept(
      client.preview({
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;
    const purchase = await accept(
      client.create({
        body: {
          quantity: 3,
          successUrl,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 15_000,
      nextRecurringAmountCents: 0,
      currency: "usd",
    });
    expect(purchase.body).toStrictEqual({ url: successUrl });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      1,
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: fixture.subscriptionId,
      preview_mode: "next",
      subscription_details: {
        cancel_at_period_end: false,
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
      },
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("previews and applies a concurrency increase without restoring the ending Plan", async () => {
    const periodStart = currentSecond() - 86_400;
    const periodEnd = currentSecond() + 29 * 86_400;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 5,
      periodEnd: new Date(periodEnd * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const planItem = {
      id: `si_${TEST_PRICE_TEAM}`,
      price: { id: TEST_PRICE_TEAM },
      quantity: 1,
      current_period_start: periodStart,
      current_period_end: periodEnd,
    };
    const concurrencyItem = {
      id: fixture.concurrencyItemId,
      price: {
        id: TEST_PRICE_CONCURRENCY,
        recurring: { interval: "month" as const, interval_count: 1 },
      },
      quantity: 5,
      current_period_start: periodStart,
      current_period_end: periodEnd,
    };
    const cancelingSubscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: periodEnd,
      cancel_at_period_end: false,
      latest_invoice: null,
      metadata: {},
      pending_update: null,
      schedule: null,
      items: { data: [planItem, concurrencyItem] },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      cancelingSubscription,
    );
    context.mocks.stripe.subscriptions.update.mockReset();
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...cancelingSubscription,
      items: {
        data: [planItem, { ...concurrencyItem, quantity: 7 }],
      },
    });
    context.mocks.stripe.invoices.createPreview.mockReset();
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      const details =
        typeof input === "object" &&
        input !== null &&
        "subscription_details" in input &&
        typeof input.subscription_details === "object" &&
        input.subscription_details !== null
          ? input.subscription_details
          : null;
      if (
        details &&
        "proration_date" in details &&
        typeof details.proration_date === "number"
      ) {
        if (
          !("cancel_at" in details) ||
          details.cancel_at !== "" ||
          "cancel_at_period_end" in details
        ) {
          throw new Error("Expected the preview to simulate an active Plan");
        }
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 12_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 12_000,
                pricing: {
                  price_details: { price: TEST_PRICE_CONCURRENCY },
                },
                parent: {
                  subscription_item_details: { proration: true },
                },
                period: { start: details.proration_date },
              },
            ],
          },
        });
      }
      return Promise.reject(
        new StripeSDK.errors.StripeInvalidRequestError({
          type: "invalid_request_error",
          message:
            "Recurring estimates do not support the following features: subscription prorations, trials, cancellations, prebilling, schedules, and invoice item additions.",
        }),
      );
    });
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    const preview = await accept(
      client.previewChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 7 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 5,
      targetQuantity: 7,
      immediateAmountCents: 12_000,
      nextRecurringAmountCents: 0,
      currency: "usd",
    });

    const confirmed = await accept(
      client.confirmChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 7 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "processing",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      1,
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: fixture.subscriptionId,
      preview_mode: "next",
      subscription_details: {
        cancel_at: "",
        items: [{ id: fixture.concurrencyItemId, quantity: 7 }],
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
      },
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ id: fixture.concurrencyItemId, quantity: 7 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    const updateParams =
      context.mocks.stripe.subscriptions.update.mock.calls[0]?.[1];
    expect(updateParams).not.toHaveProperty("cancel_at");
    expect(updateParams).not.toHaveProperty("cancel_at_period_end");
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
  });

  it("rejects deferred concurrency changes that cannot precede the Plan end", async () => {
    const periodStart = currentSecond() - 86_400;
    const periodEnd = currentSecond() + 29 * 86_400;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 5,
      periodEnd: new Date(periodEnd * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const cancelingSubscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: periodEnd,
      cancel_at_period_end: true,
      latest_invoice: null,
      metadata: {},
      pending_update: null,
      schedule: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_start: periodStart,
            current_period_end: periodEnd,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month" as const, interval_count: 1 },
            },
            quantity: 5,
            current_period_start: periodStart,
            current_period_end: periodEnd,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      cancelingSubscription,
    );
    context.mocks.stripe.invoices.createPreview.mockClear();
    context.mocks.stripe.subscriptions.update.mockClear();
    context.mocks.stripe.subscriptionSchedules.create.mockClear();
    context.mocks.stripe.subscriptionSchedules.update.mockClear();
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);
    const expectedReductionError = {
      error: {
        message:
          "Restore your Plan before reducing concurrency while a Plan downgrade or cancellation is scheduled.",
        code: "CONFLICT",
      },
    };

    const preview = await accept(
      client.previewChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    const confirm = await accept(
      client.confirmChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    const canceled = await accept(
      client.cancel({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(preview.body).toStrictEqual(expectedReductionError);
    expect(confirm.body).toStrictEqual(expectedReductionError);
    expect(canceled.body).toStrictEqual({
      error: {
        message:
          "Restore your Plan before canceling concurrency while a Plan downgrade or cancellation is scheduled.",
        code: "CONFLICT",
      },
    });
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("rejects a concurrency reduction at the end of a Plan cancellation schedule", async () => {
    const periodStart = currentSecond() - 86_400;
    const periodEnd = currentSecond() + 29 * 86_400;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 5,
      periodEnd: new Date(periodEnd * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const items = [
      {
        id: `si_${TEST_PRICE_TEAM}`,
        price: { id: TEST_PRICE_TEAM },
        quantity: 1,
        current_period_start: periodStart,
        current_period_end: periodEnd,
      },
      {
        id: fixture.concurrencyItemId,
        price: {
          id: TEST_PRICE_CONCURRENCY,
          recurring: { interval: "month" as const, interval_count: 1 },
        },
        quantity: 5,
        current_period_start: periodStart,
        current_period_end: periodEnd,
      },
    ];
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      latest_invoice: null,
      metadata: {},
      pending_update: null,
      schedule: scheduleId,
      items: { data: items },
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockReset();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      end_behavior: "cancel",
      current_phase: { start_date: periodStart, end_date: periodEnd },
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
        },
      ],
    });
    context.mocks.stripe.invoices.createPreview.mockClear();
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const response = await accept(
      setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract).previewChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Restore your Plan before reducing concurrency while a Plan downgrade or cancellation is scheduled.",
        code: "CONFLICT",
      },
    });
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("adds concurrency to an attached Team cancellation schedule", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const periodStart = currentSecond() - 86_400;
    const periodEnd = currentSecond() + 29 * 86_400;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const planItem = {
      id: `si_${TEST_PRICE_TEAM}`,
      price: { id: TEST_PRICE_TEAM },
      quantity: 1,
      current_period_start: periodStart,
      current_period_end: periodEnd,
    };
    const subscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      latest_invoice: null,
      metadata: {},
      pending_update: null,
      schedule: scheduleId,
      items: { data: [planItem] },
    };
    const schedule = {
      id: scheduleId,
      end_behavior: "cancel" as const,
      current_phase: { start_date: periodStart, end_date: periodEnd },
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
          proration_behavior: "none" as const,
        },
      ],
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockReset();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      schedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue(
      schedule,
    );
    context.mocks.stripe.invoices.createPreview.mockReset();
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (
        typeof input === "object" &&
        input !== null &&
        "subscription_details" in input &&
        typeof input.subscription_details === "object" &&
        input.subscription_details !== null &&
        "proration_date" in input.subscription_details &&
        typeof input.subscription_details.proration_date === "number"
      ) {
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 15_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 15_000,
                price: { id: TEST_PRICE_CONCURRENCY },
                period: { start: input.subscription_details.proration_date },
                parent: {
                  subscription_item_details: { proration: true },
                },
              },
            ],
          },
        });
      }
      return Promise.reject(
        new StripeSDK.errors.StripeInvalidRequestError({
          type: "invalid_request_error",
          code: "invoice_upcoming_none",
          message: `No upcoming invoices for schedule: ${scheduleId}`,
        }),
      );
    });

    const client = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);
    const preview = await accept(
      client.preview({
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;
    const purchase = await accept(
      client.create({
        body: {
          quantity: 3,
          successUrl,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const phases = [
      {
        start_date: periodStart,
        end_date: periodEnd,
        items: [
          { price: TEST_PRICE_TEAM, quantity: 1 },
          { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
        ],
        proration_behavior: "none",
      },
    ];
    expect(preview.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 15_000,
      nextRecurringAmountCents: 0,
      currency: "usd",
    });
    expect(purchase.body).toStrictEqual({ url: successUrl });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      2,
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "cancel",
        proration_behavior: "none",
        phases,
      },
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "cancel",
        proration_behavior: "always_invoice",
        phases,
      },
      {
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:[^:]+:[^:]+:schedule-update$/u,
        ),
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("rejects a concurrency purchase while the Plan has a scheduled change", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const scheduleId = `sub_sched_plan_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      latest_invoice: null,
      pending_update: null,
      schedule: scheduleId,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockClear();
    context.mocks.stripe.invoices.createPreview.mockClear();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockClear();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      end_behavior: "release",
      current_phase: { start_date: 1, end_date: 2 },
      phases: [
        {
          start_date: 1,
          end_date: 2,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
        },
        {
          start_date: 2,
          end_date: 3,
          items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const client = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);
    const preview = await accept(
      client.preview({
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    const purchase = await accept(
      client.create({
        body: {
          quantity: 3,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(preview.body).toStrictEqual({
      error: {
        message: "Complete the pending concurrency update before adding slots",
        code: "CONFLICT",
      },
    });
    expect(purchase.body).toStrictEqual(preview.body);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.retrieve,
    ).toHaveBeenCalledTimes(2);
    expect(
      context.mocks.stripe.subscriptionSchedules.retrieve,
    ).toHaveBeenCalledWith(scheduleId);
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("adds concurrency to the Plan subscription through a neutral schedule", async () => {
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const periodEndUnix = 4_102_444_800;
    const concurrencyItemId = `si_${TEST_PRICE_CONCURRENCY}`;
    const scheduleId = `sub_sched_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      latest_invoice: null,
      pending_update: null,
      schedule: scheduleId,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "release",
      current_phase: { start_date: 1, end_date: 2 },
      phases: [
        {
          start_date: 1,
          end_date: 2,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
        },
        {
          start_date: 2,
          end_date: 3,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_end: periodEndUnix,
          },
          {
            id: concurrencyItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 3,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    const successUrl = `${APP_ORIGIN}/billing?concurrency=success`;

    const response = await accept(
      setupApp({
        context,
        routes: billingConcurrencyCheckoutRoutes,
      })(billingConcurrencyCheckoutContract).create({
        body: {
          quantity: 3,
          successUrl,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ url: successUrl });
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      fixture.subscriptionId,
      { expand: ["latest_invoice"] },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId, {
      preserve_cancel_date: true,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([]);
  });

  it("reactivates a zero-quantity concurrency item on the Plan subscription", async () => {
    const fixture = await createSubscriptionOrg({ tier: "team" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const concurrencyItemId = `si_${TEST_PRICE_CONCURRENCY}`;
    const hostedInvoiceUrl =
      "https://invoice.stripe.test/pending-concurrency-purchase";
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
          },
          {
            id: concurrencyItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 0,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      latest_invoice: {
        id: `in_${randomUUID()}`,
        status: "open",
        hosted_invoice_url: hostedInvoiceUrl,
      },
      pending_update: {
        expires_at: 4_102_444_800,
        subscription_items: [
          {
            id: concurrencyItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 1,
          },
        ],
      },
    });

    const response = await accept(
      setupApp({
        context,
        routes: billingConcurrencyCheckoutRoutes,
      })(billingConcurrencyCheckoutContract).create({
        body: {
          quantity: 1,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ url: hostedInvoiceUrl });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ id: concurrencyItemId, quantity: 1 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
  });

  it("activates concurrency on the Plan subscription without renewing Plan credits", async () => {
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd,
    });

    const status = await readBillingStatus(fixture);
    expect(status.credits).toBe(fixture.planCredits);
    expect(status.hasSubscription).toBeTruthy();
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity: 3,
        currentPeriodEnd: periodEnd.toISOString(),
      }),
    ]);
  });

  it("updates Plan and concurrency state from one shared subscription event", async () => {
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd,
    });
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "past_due",
          cancel_at_period_end: true,
          cancel_at: null,
          schedule: null,
          metadata: {},
          items: {
            data: [
              {
                id: `si_${TEST_PRICE_TEAM}`,
                price: { id: TEST_PRICE_TEAM },
                quantity: 1,
                current_period_end: Math.floor(periodEnd.getTime() / 1000),
              },
              {
                id: fixture.concurrencyItemId,
                price: { id: TEST_PRICE_CONCURRENCY },
                quantity: 3,
                current_period_end: Math.floor(periodEnd.getTime() / 1000),
              },
            ],
          },
        },
        previous_attributes: { cancel_at_period_end: false },
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
    expect(status.subscriptionStatus).toBe("past_due");
    expect(status.cancelAtPeriodEnd).toBeTruthy();
    expect(status.concurrencySubscriptions[0]).toStrictEqual(
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity: 3,
        cancelAtPeriodEnd: false,
      }),
    );
  });

  it("keeps shared concurrency active when a Custom plan has an explicit end", async () => {
    const concurrencyPeriodEnd = new Date("2099-05-20T00:00:00Z");
    const customExpiresAt = new Date("2100-05-20T00:00:00Z");
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd: concurrencyPeriodEnd,
    });
    mockEnv("OKOU_PRICE_CUSTOM", TEST_PRICE_CUSTOM);
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "active",
          cancel_at_period_end: false,
          cancel_at: Math.floor(customExpiresAt.getTime() / 1000),
          schedule: null,
          metadata: {
            orgId: fixture.orgId,
            purpose: "custom_plan_subscription",
            tier: "custom",
            atomGrantExpiresAt: customExpiresAt.toISOString(),
          },
          items: {
            data: [
              {
                id: `si_${TEST_PRICE_CUSTOM}`,
                price: { id: TEST_PRICE_CUSTOM },
                quantity: 1,
                current_period_end: Math.floor(
                  concurrencyPeriodEnd.getTime() / 1000,
                ),
              },
              {
                id: fixture.concurrencyItemId,
                price: { id: TEST_PRICE_CONCURRENCY },
                quantity: 3,
                current_period_end: Math.floor(
                  concurrencyPeriodEnd.getTime() / 1000,
                ),
              },
            ],
          },
        },
        previous_attributes: { cancel_at: null },
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
    expect(status.tier).toBe("custom");
    expect(status.cancelAtPeriodEnd).toBeTruthy();
    expect(status.currentPeriodEnd).toBe(customExpiresAt.toISOString());
    expect(status.concurrencySubscriptions[0]).toStrictEqual(
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity: 3,
        currentPeriodEnd: concurrencyPeriodEnd.toISOString(),
        cancelAtPeriodEnd: false,
      }),
    );
  });

  it("ends Plan and concurrency state when the shared subscription is deleted", async () => {
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
    });
    const event = {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "canceled",
          metadata: {},
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
    expect(status.tier).toBe("limited-free-1");
    expect(status.hasSubscription).toBeFalsy();
    expect(status.concurrencySubscriptions).toStrictEqual([]);
  });

  it("activates concurrency on a Custom usage allowance subscription", async () => {
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createMergedUsageAllowanceConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd,
    });

    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("custom");
    expect(status.usageAllowance).not.toBeNull();
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity: 3,
        currentPeriodEnd: periodEnd.toISOString(),
      }),
    ]);
  });

  it("updates usage allowance and concurrency from one shared subscription event", async () => {
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const periodEndUnix = Math.floor(periodEnd.getTime() / 1000);
    const fixture = await createMergedUsageAllowanceConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd,
    });
    const initialStatus = await readBillingStatus(fixture);
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "past_due",
          cancel_at_period_end: true,
          cancel_at: periodEndUnix,
          schedule: null,
          metadata: { purpose: "usage_allowance" },
          items: {
            data: [
              {
                id: fixture.allowanceItemId,
                price: { id: TEST_PRICE_USAGE_ALLOWANCE },
                quantity: 1,
                current_period_end: periodEndUnix,
              },
              {
                id: fixture.concurrencyItemId,
                price: { id: TEST_PRICE_CONCURRENCY },
                quantity: 3,
                current_period_end: periodEndUnix,
              },
            ],
          },
        },
        previous_attributes: { cancel_at_period_end: false },
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
    expect(status.tier).toBe("custom");
    expect(status.subscriptionStatus).toBe(initialStatus.subscriptionStatus);
    expect(status.usageAllowance).not.toBeNull();
    expect(status.concurrencySubscriptions[0]).toStrictEqual(
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity: 3,
        cancelAtPeriodEnd: true,
      }),
    );
  });

  it("ends shared allowance and concurrency without ending the Custom plan", async () => {
    const fixture = await createMergedUsageAllowanceConcurrencySubscriptionOrg({
      slots: 3,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
    });
    const initialStatus = await readBillingStatus(fixture);
    const event = {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "canceled",
          metadata: { purpose: "usage_allowance" },
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
    expect(status.tier).toBe("custom");
    expect(status.subscriptionStatus).toBe(initialStatus.subscriptionStatus);
    expect(status.hasSubscription).toBeFalsy();
    expect(status.usageAllowance).toBeNull();
    expect(status.concurrencySubscriptions).toStrictEqual([]);
  });

  it("previews and confirms a concurrency change without Portal", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const hostedInvoiceUrl =
      "https://invoice.stripe.test/pending-concurrency-change";
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const paymentMethodId = `pm_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
      customer: fixture.customerId,
      default_payment_method: paymentMethodId,
      pending_update: null,
      items: {
        data: [
          {
            id: subscriptionItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 2,
          },
        ],
      },
    });
    context.mocks.stripe.invoices.createPreview
      .mockImplementationOnce((input) => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("subscription_details" in input) ||
          typeof input.subscription_details !== "object" ||
          input.subscription_details === null ||
          !("proration_date" in input.subscription_details) ||
          typeof input.subscription_details.proration_date !== "number"
        ) {
          throw new Error("Expected a concurrency proration preview");
        }
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 17_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 15_000,
                pricing: {
                  price_details: { price: TEST_PRICE_CONCURRENCY },
                },
                parent: {
                  subscription_item_details: { proration: true },
                },
                period: {
                  start: input.subscription_details.proration_date,
                },
              },
              {
                id: `il_${randomUUID()}`,
                amount: 2000,
                pricing: { price_details: { price: TEST_PRICE_TEAM } },
                parent: {
                  subscription_item_details: { proration: false },
                },
                period: {
                  start: input.subscription_details.proration_date,
                },
              },
            ],
          },
        });
      })
      .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(4));
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
      latest_invoice: {
        id: `in_${randomUUID()}`,
        status: "open",
        hosted_invoice_url: hostedInvoiceUrl,
      },
      pending_update: {
        expires_at: 4_102_444_800,
        subscription_items: [
          {
            id: subscriptionItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 4,
          },
        ],
      },
    });

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    const preview = await accept(
      client.previewChange({
        params: { subscriptionId },
        body: {
          quantity: 4,
          supportsInAppPreview: true,
          returnUrl: `${APP_ORIGIN}/billing`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 2,
      targetQuantity: 4,
      immediateAmountCents: 15_000,
      nextRecurringAmountCents: 40_000,
      currency: "usd",
      paymentMethodPreviewToken: expect.any(String),
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: subscriptionId,
      preview_mode: "next",
      subscription_details: {
        items: [{ id: subscriptionItemId, quantity: 4 }],
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
      },
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: subscriptionId,
      preview_mode: "recurring",
      subscription_details: {
        items: [{ id: subscriptionItemId, quantity: 4 }],
      },
    });

    const paymentMethodPreviewToken = preview.body.paymentMethodPreviewToken;
    if (!paymentMethodPreviewToken) {
      throw new Error("Expected a saved-payment-method preview token");
    }
    const confirmed = await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 4, paymentMethodPreviewToken },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      1,
      subscriptionId,
      {
        default_payment_method: paymentMethodId,
      },
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      2,
      subscriptionId,
      {
        items: [{ id: subscriptionItemId, quantity: 4 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 2 }),
    ]);
  });

  it("returns the pending invoice when confirming a matching pending update", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const hostedInvoiceUrl =
      "https://invoice.stripe.test/pending-concurrency-confirm";
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subscriptionId,
      customer: fixture.customerId,
      latest_invoice: {
        id: `in_${randomUUID()}`,
        status: "open",
        hosted_invoice_url: hostedInvoiceUrl,
      },
      pending_update: {
        expires_at: 4_102_444_800,
        subscription_items: [
          {
            id: subscriptionItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 4,
          },
        ],
      },
      items: {
        data: [
          {
            id: subscriptionItemId,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 2,
          },
        ],
      },
    });

    const confirmed = await accept(
      setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract).confirmChange({
        params: { subscriptionId },
        body: { quantity: 4 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 2 }),
    ]);
  });

  it("previews a concurrency reduction at the next billing date", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 5,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const scheduleId = `sub_sched_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscriptionId,
      pending_update: null,
      schedule: null,
      items: {
        data: [
          {
            id: subscriptionItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: {
                interval: "month",
                interval_count: 1,
                usage_type: "licensed",
                trial_period_days: null,
                meter: null,
              },
            },
            quantity: 5,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValueOnce(
      recurringConcurrencyPreviewInvoice(3),
    );
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: scheduleId,
    });

    const preview = await accept(
      setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract).previewChange({
        params: { subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 5,
      targetQuantity: 3,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 30_000,
      currency: "usd",
      effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: subscriptionId,
      preview_mode: "recurring",
      subscription_details: {
        items: [{ id: subscriptionItemId, quantity: 3 }],
      },
    });

    const confirmed = await accept(
      setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract).confirmChange({
        params: { subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
      effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            duration: { interval: "month", interval_count: 1 },
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
            proration_behavior: "none",
          },
        ],
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("reuses a concurrency schedule with no future billing changes", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 5,
      periodEnd: new Date(periodEndUnix * 1000),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const subscription = {
      id: subscriptionId,
      customer: `cus_${randomUUID()}`,
      status: "active",
      cancel_at_period_end: false,
      latest_invoice: null,
      pending_update: null,
      schedule: scheduleId,
      items: {
        data: [
          {
            id: subscriptionItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month" as const, interval_count: 1 },
            },
            quantity: 5,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    };
    const schedule = {
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: periodStartUnix,
        end_date: periodEndUnix,
      },
      phases: [
        {
          start_date: periodStartUnix,
          end_date: periodEndUnix,
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
        },
        {
          start_date: periodEndUnix,
          end_date: periodEndUnix + 30 * 86_400,
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
        },
      ],
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      schedule,
    );
    context.mocks.stripe.invoices.createPreview.mockResolvedValueOnce(
      recurringConcurrencyPreviewInvoice(3),
    );
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);
    const preview = await accept(
      client.previewChange({
        params: { subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(preview.body.targetQuantity).toBe(3);
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: subscriptionId,
      preview_mode: "recurring",
      subscription_details: {
        items: [{ id: subscriptionItemId, quantity: 3 }],
      },
    });

    const confirmed = await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmed.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
      effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            start_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
          }),
        ]),
      }),
      { idempotencyKey: expect.any(String) },
    );
  });

  it("rejects a schedule that repeats invoice items in a future phase", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 5,
      periodEnd: new Date(periodEndUnix * 1000),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const subscription = {
      id: subscriptionId,
      customer: `cus_${randomUUID()}`,
      status: "active",
      cancel_at_period_end: false,
      latest_invoice: null,
      pending_update: null,
      schedule: scheduleId,
      items: {
        data: [
          {
            id: subscriptionItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month" as const, interval_count: 1 },
            },
            quantity: 5,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    };
    const repeatedInvoiceItems = [
      { price: `price_${randomUUID()}`, quantity: 1 },
    ];
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: periodStartUnix,
        end_date: periodEndUnix,
      },
      phases: [
        {
          start_date: periodStartUnix,
          end_date: periodEndUnix,
          add_invoice_items: repeatedInvoiceItems,
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
        },
        {
          start_date: periodEndUnix,
          end_date: periodEndUnix + 30 * 86_400,
          add_invoice_items: repeatedInvoiceItems,
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
        },
      ],
    });

    const response = await accept(
      setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract).previewChange({
        params: { subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body.error.message).toBe(
      "Complete the pending concurrency update before changing slots",
    );
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("allows concurrency increases but blocks reductions during a Team to Pro downgrade", async () => {
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const periodEndUnix = Math.floor(periodEnd.getTime() / 1000);
    const periodStartUnix = periodEndUnix - 30 * 86_400;
    const futureEndUnix = periodEndUnix + 30 * 86_400;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 5,
      periodEnd,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const scheduleId = `sub_sched_plan_${randomUUID()}`;
    const subscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      default_payment_method: "pm_card",
      latest_invoice: null,
      pending_update: null,
      schedule: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month" as const, interval_count: 1 },
            },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month" as const, interval_count: 1 },
            },
            quantity: 5,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      subscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
      current_phase: {
        start_date: periodStartUnix,
        end_date: periodEndUnix,
      },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    await accept(
      setupApp({ context, routes: billingDowngradeRoutes })(
        billingDowngradeContract,
      ).create({
        body: { targetTier: "pro" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const attachedSubscription = { ...subscription, schedule: scheduleId };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      attachedSubscription,
    );
    context.mocks.stripe.subscriptions.update.mockClear();
    context.mocks.stripe.invoices.createPreview.mockClear();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockClear();
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: periodStartUnix,
        end_date: periodEndUnix,
      },
      phases: [
        {
          start_date: periodStartUnix,
          end_date: periodEndUnix,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
        },
        {
          start_date: periodEndUnix,
          end_date: futureEndUnix,
          items: [
            { price: TEST_PRICE_PRO, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
        },
      ],
    });
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
      if (
        typeof input === "object" &&
        input !== null &&
        "subscription_details" in input &&
        typeof input.subscription_details === "object" &&
        input.subscription_details !== null &&
        "proration_date" in input.subscription_details &&
        typeof input.subscription_details.proration_date === "number"
      ) {
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 10_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 10_000,
                pricing: {
                  price_details: { price: TEST_PRICE_CONCURRENCY },
                },
                parent: {
                  subscription_item_details: { proration: true },
                },
                period: {
                  start: input.subscription_details.proration_date,
                },
              },
            ],
          },
        });
      }
      return Promise.resolve({
        id: `in_preview_${randomUUID()}`,
        amount_due: 20_000,
        currency: "usd",
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${randomUUID()}`,
              amount: 20_000,
              pricing: {
                price_details: { price: TEST_PRICE_PRO },
              },
            },
          ],
        },
      });
    });
    context.mocks.stripe.subscriptionSchedules.release.mockClear();
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);
    const increasePreview = await accept(
      client.previewChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 6 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const preview = await accept(
      client.previewChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );
    const canceled = await accept(
      client.cancel({
        params: { subscriptionId: fixture.subscriptionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(increasePreview.body).toStrictEqual({
      currentQuantity: 5,
      targetQuantity: 6,
      immediateAmountCents: 10_000,
      nextRecurringAmountCents: 0,
      currency: "usd",
    });
    expect(preview.body).toStrictEqual({
      error: {
        message:
          "Restore your Plan before reducing concurrency while a Plan downgrade or cancellation is scheduled.",
        code: "CONFLICT",
      },
    });
    expect(canceled.body).toStrictEqual({
      error: {
        message:
          "Restore your Plan before canceling concurrency while a Plan downgrade or cancellation is scheduled.",
        code: "CONFLICT",
      },
    });

    const confirmed = await accept(
      client.confirmChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 6 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "processing",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      2,
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.retrieve,
    ).toHaveBeenCalledWith(scheduleId);
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "always_invoice",
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 6 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            end_date: futureEndUnix,
            items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
            proration_behavior: "none",
          },
        ],
      },
      { idempotencyKey: expect.any(String) },
    );
  });

  it("replaces an existing scheduled concurrency reduction", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const periodStartUnix = 4_075_660_800;
    const schedulePhaseStartUnix = periodStartUnix + 3600;
    const periodEndUnix = 4_078_252_800;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 5,
      periodEnd: new Date(periodEndUnix * 1000),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const currentItem = {
      id: subscriptionItemId,
      price: {
        id: TEST_PRICE_CONCURRENCY,
        recurring: { interval: "month" as const, interval_count: 1 },
      },
      quantity: 5,
      current_period_start: periodStartUnix,
      current_period_end: periodEndUnix,
    };
    const subscriptionWithoutSchedule = {
      id: subscriptionId,
      pending_update: null,
      schedule: null,
      items: { data: [currentItem] },
    };
    const subscriptionWithSchedule = {
      ...subscriptionWithoutSchedule,
      schedule: scheduleId,
    };
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(subscriptionWithoutSchedule)
      .mockResolvedValueOnce(subscriptionWithoutSchedule)
      .mockResolvedValueOnce(subscriptionWithSchedule)
      .mockResolvedValue(subscriptionWithSchedule);
    context.mocks.stripe.invoices.createPreview
      .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(3))
      .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(2));
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      current_phase: {
        start_date: schedulePhaseStartUnix,
        end_date: periodEndUnix,
      },
      phases: [
        {
          start_date: schedulePhaseStartUnix,
          end_date: periodEndUnix,
        },
        {
          start_date: periodEndUnix,
          end_date: periodEndUnix + 2_592_000,
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 3 }],
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    await accept(
      client.previewChange({
        params: { subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const statusAfterFirstChange = await readBillingStatus(fixture);
    expect(statusAfterFirstChange.concurrencySubscriptions[0]).toMatchObject({
      quantity: 5,
      scheduledQuantity: 3,
      scheduledChangeAt: new Date(periodEndUnix * 1000).toISOString(),
    });

    const replacementPreview = await accept(
      client.previewChange({
        params: { subscriptionId },
        body: { quantity: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(replacementPreview.body).toStrictEqual({
      currentQuantity: 5,
      targetQuantity: 2,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 20_000,
      currency: "usd",
      effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
    });
    expect(
      context.mocks.stripe.invoices.createPreview,
    ).toHaveBeenLastCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: schedulePhaseStartUnix,
            end_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 5 }],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            duration: { interval: "month", interval_count: 1 },
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 2 }],
            proration_behavior: "none",
          },
        ],
      },
    });

    await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const replacementOptions =
      context.mocks.stripe.subscriptionSchedules.update.mock.calls.at(-1)?.[2];
    if (
      typeof replacementOptions !== "object" ||
      replacementOptions === null ||
      !("idempotencyKey" in replacementOptions) ||
      typeof replacementOptions.idempotencyKey !== "string"
    ) {
      throw new Error("Expected replacement schedule update options");
    }

    await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const retryOptions =
      context.mocks.stripe.subscriptionSchedules.update.mock.calls.at(-1)?.[2];
    if (
      typeof retryOptions !== "object" ||
      retryOptions === null ||
      !("idempotencyKey" in retryOptions) ||
      typeof retryOptions.idempotencyKey !== "string"
    ) {
      throw new Error("Expected retry schedule update options");
    }

    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledOnce();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledTimes(3);
    expect(retryOptions.idempotencyKey).not.toBe(
      replacementOptions.idempotencyKey,
    );
    const statusAfterReplacement = await readBillingStatus(fixture);
    expect(statusAfterReplacement.concurrencySubscriptions[0]).toMatchObject({
      quantity: 5,
      scheduledQuantity: 2,
      scheduledChangeAt: new Date(periodEndUnix * 1000).toISOString(),
    });
  });

  it("releases a scheduled reduction before applying an increase", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const subscriptionItemId = `si_${randomUUID()}`;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const periodStartUnix = 4_075_660_800;
    const schedulePhaseStartUnix = periodStartUnix + 3600;
    const periodEndUnix = 4_078_252_800;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 10,
      periodEnd: new Date(periodEndUnix * 1000),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const currentItem = {
      id: subscriptionItemId,
      price: {
        id: TEST_PRICE_CONCURRENCY,
        recurring: { interval: "month" as const, interval_count: 1 },
      },
      quantity: 10,
      current_period_start: periodStartUnix,
      current_period_end: periodEndUnix,
    };
    const scheduledSubscription = {
      id: subscriptionId,
      schedule: scheduleId,
      pending_update: null,
      latest_invoice: null,
      items: { data: [currentItem] },
    };
    const subscriptionWithoutSchedule = {
      ...scheduledSubscription,
      schedule: null,
    };
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(subscriptionWithoutSchedule)
      .mockResolvedValueOnce(subscriptionWithoutSchedule)
      .mockResolvedValue(scheduledSubscription);
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: subscriptionId,
      schedule: null,
      pending_update: null,
      latest_invoice: null,
      items: { data: [{ ...currentItem, quantity: 20 }] },
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      current_phase: {
        start_date: schedulePhaseStartUnix,
        end_date: periodEndUnix,
      },
      phases: [
        {
          start_date: schedulePhaseStartUnix,
          end_date: periodEndUnix,
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 10 }],
        },
        {
          start_date: periodEndUnix,
          end_date: periodEndUnix + 2_592_000,
          items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 2 }],
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.invoices.createPreview
      .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(2))
      .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(10))
      .mockImplementationOnce((input) => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("subscription_details" in input) ||
          typeof input.subscription_details !== "object" ||
          input.subscription_details === null ||
          !("proration_date" in input.subscription_details) ||
          typeof input.subscription_details.proration_date !== "number"
        ) {
          throw new Error("Expected a concurrency proration preview");
        }
        return Promise.resolve({
          id: `in_preview_${randomUUID()}`,
          amount_due: 100_000,
          currency: "usd",
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount: 100_000,
                pricing: {
                  price_details: { price: TEST_PRICE_CONCURRENCY },
                },
                parent: {
                  subscription_item_details: { proration: true },
                },
                period: {
                  start: input.subscription_details.proration_date,
                },
              },
            ],
          },
        });
      })
      .mockResolvedValueOnce(recurringConcurrencyPreviewInvoice(20));
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValueOnce({
      id: scheduleId,
    });

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);
    await accept(
      client.previewChange({
        params: { subscriptionId },
        body: { quantity: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const scheduledStatus = await readBillingStatus(fixture);
    expect(scheduledStatus.concurrencySubscriptions[0]).toMatchObject({
      quantity: 10,
      scheduledQuantity: 2,
    });
    context.mocks.stripe.subscriptionSchedules.create.mockClear();
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const unchangedPreview = await accept(
      client.previewChange({
        params: { subscriptionId },
        body: { quantity: 10 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(unchangedPreview.body).toStrictEqual({
      currentQuantity: 10,
      targetQuantity: 10,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 100_000,
      currency: "usd",
    });
    expect(
      context.mocks.stripe.invoices.createPreview,
    ).toHaveBeenLastCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            start_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 10 }],
          }),
        ]),
      }),
    });
    const preview = await accept(
      client.previewChange({
        params: { subscriptionId },
        body: { quantity: 20 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 10,
      targetQuantity: 20,
      immediateAmountCents: 100_000,
      nextRecurringAmountCents: 200_000,
      currency: "usd",
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: schedulePhaseStartUnix,
            end_date: periodEndUnix,
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 10 }],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            duration: { interval: "month", interval_count: 1 },
            items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 20 }],
            proration_behavior: "none",
          },
        ],
      },
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.retrieve,
    ).toHaveBeenCalledWith(scheduleId);

    const response = await accept(
      client.confirmChange({
        params: { subscriptionId },
        body: { quantity: 20 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "processing",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subscriptionId,
      {
        items: [{ id: subscriptionItemId, quantity: 20 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId, {
      preserve_cancel_date: true,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
    const releaseCall =
      context.mocks.stripe.subscriptionSchedules.release.mock
        .invocationCallOrder[0];
    const updateCall =
      context.mocks.stripe.subscriptions.update.mock.invocationCallOrder[0];
    if (releaseCall === undefined || updateCall === undefined) {
      throw new Error(
        "Expected schedule release and subscription update calls",
      );
    }
    expect(releaseCall).toBeLessThan(updateCall);
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: subscriptionId,
          quantity: 10,
        }),
      ]),
    );
    expect(status.concurrencySubscriptions[0]).not.toHaveProperty(
      "scheduledQuantity",
    );
  });

  it("rejects in-app concurrency changes from non-admin members", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract).previewChange({
        params: { subscriptionId: `sub_${randomUUID()}` },
        body: { quantity: 2 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "Only org admins can manage concurrency subscriptions",
      code: "FORBIDDEN",
    });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("requires restoring a canceling concurrency subscription before adding slots", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
      tier: "team",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: subscriptionId,
    });
    await accept(
      setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract).cancel({
        params: { subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.update.mockClear();

    const response = await accept(
      setupApp({
        context,
        routes: billingConcurrencyCheckoutRoutes,
      })(billingConcurrencyCheckoutContract).create({
        body: {
          quantity: 1,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Restore the existing concurrency subscription before buying more slots",
        code: "BAD_REQUEST",
      },
    });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("uses the live Stripe quantity for proration invoices", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd,
      tier: "team",
    });
    const periodEndUnix = Math.floor(periodEnd.getTime() / 1000);
    const event = {
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID().slice(0, 8)}`,
          customer: fixture.customerId,
          metadata: { purpose: "concurrency_subscription" },
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: { purpose: "concurrency_subscription" },
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID().slice(0, 8)}`,
                amount: -20_000,
                quantity: 2,
                price: { id: TEST_PRICE_CONCURRENCY },
                parent: { type: "subscription_item_details" },
                period: {
                  start: periodEndUnix - 15 * 86_400,
                  end: periodEndUnix,
                },
              },
              {
                id: `il_${randomUUID().slice(0, 8)}`,
                amount: 50_000,
                quantity: 5,
                price: { id: TEST_PRICE_CONCURRENCY },
                parent: { type: "subscription_item_details" },
                period: {
                  start: periodEndUnix - 15 * 86_400,
                  end: periodEndUnix,
                },
              },
            ],
          },
        },
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subscriptionId,
      status: "active",
      customer: fixture.customerId,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: { purpose: "concurrency_subscription" },
      items: {
        data: [
          {
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 4,
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

    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 4 }),
    ]);
  });

  it("persists concurrency when shared subscription metadata has a stale usage pack ID", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "team" });
    const periodEndUnix = Math.floor(now() / 1000) + 30 * 86_400;
    const staleUsagePackSubscriptionId = randomUUID();
    const metadata = {
      purpose: "usage_pack_subscription",
      usagePackSubscriptionId: staleUsagePackSubscriptionId,
    };
    const event = {
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID().slice(0, 8)}`,
          customer: fixture.customerId,
          metadata,
          status: "paid",
          parent: {
            subscription_details: {
              subscription: fixture.subscriptionId,
              metadata,
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID().slice(0, 8)}`,
                amount: 30_000,
                quantity: 3,
                price: { id: TEST_PRICE_CONCURRENCY },
                parent: {
                  type: "subscription_item_details",
                  subscription_item_details: { proration: true },
                },
                period: {
                  start: periodEndUnix - 15 * 86_400,
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
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.subscriptionId,
        quantity: 3,
      }),
    ]);
  });

  it("adds concurrency to the Plan subscription for an agent token with billing write capability", async () => {
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [],
      has_more: false,
    });
    const fixture = await createSubscriptionOrg({ tier: "custom" });
    await seedMemberRole({
      orgId: fixture.orgId,
      userId: fixture.userId,
      role: "admin",
    });

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_CUSTOM}`,
            price: {
              id: TEST_PRICE_CUSTOM,
            },
            quantity: 1,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      latest_invoice: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_CUSTOM}`,
            price: {
              id: TEST_PRICE_CUSTOM,
            },
            quantity: 1,
            current_period_end: 4_102_444_800,
          },
          {
            id: `si_${TEST_PRICE_CONCURRENCY}`,
            price: { id: TEST_PRICE_CONCURRENCY },
            quantity: 2,
            current_period_end: 4_102_444_800,
          },
        ],
      },
    });
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["billing:write"],
    });

    const client = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          quantity: 2,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: `${APP_ORIGIN}/billing?concurrency=success`,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ price: TEST_PRICE_CONCURRENCY, quantity: 2 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: expect.any(Number),
        expand: ["latest_invoice"],
      },
    );
  });

  it("rejects concurrency checkout for Pro workspaces", async () => {
    const fixture = await trackedSeed("pro");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);
    const response = await accept(
      client.create({
        body: {
          quantity: 1,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Additional concurrency is only available for Team or Custom workspaces",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 when concurrency price is not configured", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockEnv("OKOU_PRICE_CONCURRENCY", undefined);

    const client = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);

    const response = await accept(
      client.create({
        body: {
          quantity: 1,
          successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
          cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Concurrency price not configured",
        code: "BAD_REQUEST",
      },
    });
  });

  it("cancels an active concurrency subscription at period end", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const periodEnd = new Date("2099-05-20T00:00:00Z");
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
    });

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    const response = await accept(
      client.cancel({
        params: { subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      currentPeriodEnd: periodEnd.toISOString(),
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subscriptionId,
      { cancel_at_period_end: true },
    );
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: subscriptionId,
          cancelAtPeriodEnd: true,
        }),
      ]),
    );
  });

  it("restores an active concurrency subscription renewal", async () => {
    const subscriptionId = `sub_${randomUUID()}`;
    const fixture = await createConcurrencySubscriptionOrg({
      subscriptionId,
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
    });

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    await accept(
      client.cancel({
        params: { subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.update.mockClear();

    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      id: subscriptionId,
    });

    const response = await accept(
      client.restore({
        params: { subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subscriptionId,
      { cancel_at_period_end: false },
    );
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: subscriptionId,
          cancelAtPeriodEnd: false,
        }),
      ]),
    );
  });

  it("restores a scheduled shared concurrency reduction", async () => {
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 5,
      periodEnd: new Date(periodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const subscription = {
      id: fixture.subscriptionId,
      schedule: null,
      pending_update: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 5,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      subscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockReset();
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: scheduleId,
    });
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    await accept(
      client.confirmChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    let status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions[0]?.scheduledQuantity).toBe(3);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      ...subscription,
      schedule: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "release",
    });
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValueOnce({
      id: scheduleId,
    });
    const response = await accept(
      client.restore({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId, { preserve_cancel_date: true });
    status = await readBillingStatus(fixture);
    expect(
      status.concurrencySubscriptions[0]?.scheduledQuantity,
    ).toBeUndefined();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeFalsy();
  });

  it("restores a concurrency reduction without removing the Plan cancellation", async () => {
    const periodStartUnix = 4_075_660_800;
    const concurrencyPeriodEndUnix = 4_078_252_800;
    const planEndUnix = concurrencyPeriodEndUnix + 2_592_000;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 5,
      periodEnd: new Date(concurrencyPeriodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const planItem = {
      id: `si_${TEST_PRICE_TEAM}`,
      price: { id: TEST_PRICE_TEAM },
      quantity: 1,
      current_period_start: periodStartUnix,
      current_period_end: planEndUnix,
    };
    const concurrencyItem = {
      id: fixture.concurrencyItemId,
      price: {
        id: TEST_PRICE_CONCURRENCY,
        recurring: { interval: "month" as const, interval_count: 1 },
      },
      quantity: 5,
      current_period_start: periodStartUnix,
      current_period_end: concurrencyPeriodEndUnix,
    };
    const subscription = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      pending_update: null,
      latest_invoice: null,
      items: { data: [planItem, concurrencyItem] },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      subscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockReset();
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);
    await accept(
      client.confirmChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const attachedSubscription = { ...subscription, schedule: scheduleId };
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(attachedSubscription)
      .mockResolvedValueOnce(attachedSubscription);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "cancel",
      current_phase: {
        start_date: periodStartUnix,
        end_date: concurrencyPeriodEndUnix,
      },
      phases: [
        {
          start_date: periodStartUnix,
          end_date: concurrencyPeriodEndUnix,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
        },
        {
          start_date: concurrencyPeriodEndUnix,
          end_date: planEndUnix,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
          ],
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const restored = await accept(
      client.restore({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(restored.body).toStrictEqual({ success: true });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "cancel",
        proration_behavior: "none",
        phases: [
          {
            start_date: periodStartUnix,
            end_date: concurrencyPeriodEndUnix,
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: concurrencyPeriodEndUnix,
            end_date: planEndUnix,
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
            ],
            proration_behavior: "none",
          },
        ],
      },
      {
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:[^:]+:[^:]+:schedule-update$/u,
        ),
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(
      status.concurrencySubscriptions[0]?.scheduledQuantity,
    ).toBeUndefined();
  });

  it("restores stale shared concurrency state after its schedule is removed", async () => {
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 2,
      periodEnd: new Date(periodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const subscription = {
      id: fixture.subscriptionId,
      schedule: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 2,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      subscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockReset();
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: scheduleId,
    });
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    await accept(
      client.cancel({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      ...subscription,
      cancel_at: periodEndUnix,
      cancel_at_period_end: true,
      schedule: null,
    });
    const response = await accept(
      client.restore({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeFalsy();
  });

  it("does not mark shared concurrency as restorable when the Plan cancels", async () => {
    const periodEndUnix = 4_078_252_800;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 2,
      periodEnd: new Date(periodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "active",
          cancel_at: periodEndUnix,
          cancel_at_period_end: true,
          schedule: null,
          metadata: {},
          items: {
            data: [
              {
                id: `si_${TEST_PRICE_TEAM}`,
                price: { id: TEST_PRICE_TEAM },
                quantity: 1,
                current_period_end: periodEndUnix,
              },
              {
                id: fixture.concurrencyItemId,
                price: { id: TEST_PRICE_CONCURRENCY },
                quantity: 2,
                current_period_end: periodEndUnix,
              },
            ],
          },
        },
        previous_attributes: { cancel_at_period_end: false },
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
    expect(status.cancelAtPeriodEnd).toBeTruthy();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeFalsy();
    expect(status.concurrencySubscriptions[0]?.canReduce).toBeTruthy();
  });

  it("does not release a Plan schedule when shared concurrency is not canceling", async () => {
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00Z"),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const scheduleId = `sub_sched_plan_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.subscriptionId,
      schedule: scheduleId,
    });
    context.mocks.stripe.subscriptions.retrieve.mockClear();
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    await accept(
      client.restore({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
  });

  it("cancels and restores a shared concurrency item without blocking later changes", async () => {
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const fixture = await createMergedConcurrencySubscriptionOrg({
      slots: 2,
      periodEnd: new Date(periodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      schedule: null,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 2,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);
    await accept(
      client.cancel({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledWith(
      { from_subscription: fixture.subscriptionId },
      { idempotencyKey: expect.any(String) },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenLastCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 2 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            duration: { interval: "month", interval_count: 1 },
            items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
            proration_behavior: "none",
          },
        ],
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    let status = await readBillingStatus(fixture);
    expect(status.cancelAtPeriodEnd).toBeFalsy();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeTruthy();

    const scheduledItemEvent = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: fixture.subscriptionId,
          customer: fixture.customerId,
          status: "active",
          cancel_at_period_end: false,
          cancel_at: null,
          schedule: scheduleId,
          metadata: {},
          items: {
            data: [
              {
                id: `si_${TEST_PRICE_TEAM}`,
                price: { id: TEST_PRICE_TEAM },
                quantity: 1,
              },
              {
                id: fixture.concurrencyItemId,
                price: { id: TEST_PRICE_CONCURRENCY },
                quantity: 2,
                current_period_end: periodEndUnix,
              },
            ],
          },
        },
        previous_attributes: {},
      },
    };
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "release",
      phases: [
        { start_date: periodStartUnix, end_date: periodEndUnix },
        {
          start_date: periodEndUnix,
          end_date: periodEndUnix + 2_592_000,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
        },
      ],
    });
    context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(
      scheduledItemEvent,
    );
    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(scheduledItemEvent),
        extraHeaders: { "stripe-signature": "t=1,v1=checkout-test" },
      }),
      [200],
    );

    status = await readBillingStatus(fixture);
    expect(status.cancelAtPeriodEnd).toBeFalsy();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeTruthy();

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      schedule: scheduleId,
      items: {
        data: [
          {
            id: `si_${TEST_PRICE_TEAM}`,
            price: { id: TEST_PRICE_TEAM },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 2,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: periodStartUnix,
        end_date: periodEndUnix,
      },
      phases: [
        {
          start_date: periodStartUnix,
          end_date: periodEndUnix,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 2 },
          ],
        },
        {
          start_date: periodEndUnix,
          end_date: periodEndUnix + 2_592_000,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
        },
      ],
    });
    await accept(
      client.restore({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId, {
      preserve_cancel_date: true,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledOnce();
    expect(
      context.mocks.stripe.subscriptionSchedules.retrieve,
    ).toHaveBeenCalledTimes(2);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    status = await readBillingStatus(fixture);
    expect(status.cancelAtPeriodEnd).toBeFalsy();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeFalsy();

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      pending_update: null,
      schedule: null,
      items: {
        data: [
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 2,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValueOnce(
      recurringConcurrencyPreviewInvoice(1),
    );

    const nextChange = await accept(
      client.previewChange({
        params: { subscriptionId: fixture.subscriptionId },
        body: { quantity: 1 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(nextChange.body).toStrictEqual({
      currentQuantity: 2,
      targetQuantity: 1,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 10_000,
      currency: "usd",
      effectiveAt: new Date(periodEndUnix * 1000).toISOString(),
    });
  });

  it("restores Custom concurrency without removing the main plan end", async () => {
    const periodStartUnix = 4_075_660_800;
    const periodEndUnix = 4_078_252_800;
    const customPlanEndUnix = periodEndUnix + 180 * 86_400;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const fixture = await createMergedUsageAllowanceConcurrencySubscriptionOrg({
      slots: 2,
      periodEnd: new Date(periodEndUnix * 1000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      cancel_at: customPlanEndUnix,
      cancel_at_period_end: false,
      schedule: null,
      items: {
        data: [
          {
            id: fixture.allowanceItemId,
            price: { id: TEST_PRICE_USAGE_ALLOWANCE },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 2,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: scheduleId,
    });
    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    await accept(
      client.cancel({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: periodStartUnix,
            end_date: periodEndUnix,
            items: [
              { price: TEST_PRICE_USAGE_ALLOWANCE, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 2 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: periodEndUnix,
            duration: { interval: "month", interval_count: 1 },
            items: [{ price: TEST_PRICE_USAGE_ALLOWANCE, quantity: 1 }],
            proration_behavior: "none",
          },
        ],
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    const status = await readBillingStatus(fixture);
    expect(status.tier).toBe("custom");
    expect(status.usageAllowance).not.toBeNull();
    expect(status.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeTruthy();

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: fixture.subscriptionId,
      cancel_at: customPlanEndUnix,
      cancel_at_period_end: false,
      schedule: scheduleId,
      items: {
        data: [
          {
            id: fixture.allowanceItemId,
            price: { id: TEST_PRICE_USAGE_ALLOWANCE },
            quantity: 1,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
          {
            id: fixture.concurrencyItemId,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 2,
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
    });

    await accept(
      client.restore({
        params: { subscriptionId: fixture.subscriptionId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId, { preserve_cancel_date: true });
    const restored = await readBillingStatus(fixture);
    expect(restored.tier).toBe("custom");
    expect(restored.usageAllowance).not.toBeNull();
    expect(restored.concurrencySubscriptions[0]?.cancelAtPeriodEnd).toBeFalsy();
  });

  it("returns 404 when restoring a concurrency subscription outside the org", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    const response = await accept(
      client.restore({
        params: { subscriptionId: `sub_${randomUUID()}` },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("returns 404 when cancelling a concurrency subscription outside the org", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({
      context,
      routes: billingConcurrencySubscriptionRoutes,
    })(billingConcurrencySubscriptionContract);

    const response = await accept(
      client.cancel({
        params: { subscriptionId: `sub_${randomUUID()}` },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

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
              creditsAmountMode: "amount_subtotal",
              requestedCreditsAmount: "20000",
            },
          },
        },
        metadata: {
          purpose: "credit_purchase",
          orgId: fixture.orgId,
          creditsAmountMode: "amount_subtotal",
          requestedCreditsAmount: "20000",
        },
      }),
    );
  });

  it("persists the latest org Impact click and snapshots it on new and existing customer checkouts", async () => {
    const fixture = await trackedSeed();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const capturedAt = new Date("2026-09-09T04:00:00.000Z");
    mockNow(capturedAt);
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const impact = {
      clickId: "partner-first",
      capturedAt: capturedAt.toISOString(),
    };
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        { id: fixture.userId, privateMetadata: { impact_attribution: impact } },
      ],
    });
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: {
        unrelated: "keep",
        impact_click_id: "partner-first",
        impact_click_at: capturedAt.toISOString(),
      },
    });
    context.mocks.stripe.customers.update.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      url: "https://checkout.stripe.com/session/impact-credit",
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingCheckoutContract,
    );
    const checkout = () => {
      return client.create({
        body: {
          tier: "pro",
          successUrl: `${APP_ORIGIN}/billing?credit=success`,
          cancelUrl: `${APP_ORIGIN}/billing?credit=canceled`,
        },
        headers: { authorization: "Bearer clerk-session" },
      });
    };
    await accept(checkout(), [200]);
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledWith({
      metadata: {
        orgId: fixture.orgId,
        impact_click_id: "partner-first",
        impact_click_at: capturedAt.toISOString(),
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ impact_click_id: "partner-first" }),
        subscription_data: {
          metadata: expect.objectContaining({
            impact_click_id: "partner-first",
          }),
        },
      }),
    );
    mockNow(new Date(capturedAt.getTime() + 60_000));
    impact.clickId = "partner-next";
    impact.capturedAt = new Date(capturedAt.getTime() + 60_000).toISOString();
    context.mocks.stripe.subscriptions.list.mockResolvedValueOnce({
      data: [
        {
          id: "sub_active_impact",
          status: "active",
          metadata: {
            impact_click_id: "partner-first",
            impact_click_at: capturedAt.toISOString(),
          },
        },
        { id: "sub_canceled_impact", status: "canceled", metadata: {} },
      ],
      has_more: false,
    });
    // Login records the new organization click before billing starts.
    await accept(
      setupApp({ context, routes: acquisitionAttributionRoutes })(
        acquisitionAttributionContract,
      ).recordSignup({
        body: { attribution: {}, impactAttribution: impact },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      context.mocks.stripe.subscriptions.update,
    ).toHaveBeenCalledExactlyOnceWith("sub_active_impact", {
      metadata: {
        impact_click_id: impact.clickId,
        impact_click_at: impact.capturedAt,
      },
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: {
        impact_click_id: impact.clickId,
        impact_click_at: impact.capturedAt,
      },
    });
    // A stale Clerk record must not roll the durable organization click back.
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: fixture.userId,
          privateMetadata: {
            impact_attribution: {
              clickId: "partner-first",
              capturedAt: capturedAt.toISOString(),
            },
          },
        },
      ],
    });
    await accept(checkout(), [200]);
    expect(context.mocks.stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.stripe.customers.update,
    ).toHaveBeenCalledExactlyOnceWith(customerId, {
      metadata: {
        impact_click_id: "partner-next",
        impact_click_at: impact.capturedAt,
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          impact_click_id: "partner-next",
          impact_click_at: impact.capturedAt,
        }),
        subscription_data: {
          metadata: expect.objectContaining({
            impact_click_id: "partner-next",
            impact_click_at: impact.capturedAt,
          }),
        },
      }),
    );
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: fixture.userId, privateMetadata: {} }],
    });
    await accept(checkout(), [200]);
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ impact_click_id: "partner-next" }),
      }),
    );
    // A member can retain their own referral but cannot change organization billing attribution.
    const memberId = `user_member_${randomUUID()}`;
    mocks.clerk.session(memberId, fixture.orgId, "org:member");
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: memberId, privateMetadata: {} }],
    });
    mockNow(new Date(capturedAt.getTime() + 120_000));
    await accept(
      setupApp({ context, routes: acquisitionAttributionRoutes })(
        acquisitionAttributionContract,
      ).recordSignup({
        body: {
          attribution: {},
          impactAttribution: {
            clickId: "member-partner",
            capturedAt: new Date(capturedAt.getTime() + 120_000).toISOString(),
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: fixture.userId, privateMetadata: {} }],
    });
    await accept(checkout(), [200]);
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ impact_click_id: "partner-next" }),
      }),
    );
  });

  it("snapshots the org Impact click on credit Checkout, invoice and PaymentIntent metadata", async () => {
    const fixture = await createSubscriptionOrg({ tier: "pro" });
    const impact = {
      clickId: "credit-partner",
      capturedAt: nowDate().toISOString(),
    };
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        { id: fixture.userId, privateMetadata: { impact_attribution: impact } },
      ],
    });
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
    const snapshot = expect.objectContaining({
      impact_click_id: impact.clickId,
      impact_click_at: impact.capturedAt,
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

  it("applies a customer coupon and preserves the preview Impact click without including renewal", async () => {
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
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        { id: fixture.userId, privateMetadata: { impact_attribution: impact } },
      ],
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
          impact_click_id: "credit-preview-partner",
          impact_click_at: capturedAt.toISOString(),
        }),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining("credit-purchase:"),
      }),
    );
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
  });

  it("rejects credit checkout when the plan capability is disabled", async () => {
    const fixture = await trackedSeed();
    await seedOrgMetadata({
      orgId: fixture.orgId,
      tier: "limited-free-1",
      credits: 0,
    });
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
              creditsAmountMode: "amount_subtotal",
              requestedCreditsAmount: "150000",
            },
          },
        },
        metadata: {
          purpose: "credit_purchase",
          orgId: fixture.orgId,
          creditsAmountMode: "amount_subtotal",
          requestedCreditsAmount: "150000",
        },
        payment_intent_data: {
          setup_future_usage: "off_session",
          metadata: {
            type: "credit_purchase",
            purpose: "credit_purchase",
            orgId: fixture.orgId,
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
