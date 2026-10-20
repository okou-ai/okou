import {
  createPublicBillingScenario,
  retainBillingSequence,
  type PublicBillingScenario,
} from "./helpers/public-billing-scenario";
import {
  withNowScopeForTest,
  clearMockNow,
  mockNow,
  now,
} from "../../../lib/time";

import { chargePublicSeoUsage } from "./helpers/public-seo-charge";
import { createBddApi } from "./helpers/api-bdd";
import { readGetStartedStatus } from "./helpers/get-started";
import { randomUUID } from "node:crypto";
import { mockClerkUsers } from "./helpers/clerk-users";
import {
  billingCheckoutContract,
  billingConcurrencyCheckoutContract,
  billingRestoreContract,
  billingStatusContract,
  billingUsagePackCheckoutContract,
  billingUsagePackCreditsContract,
  billingUsagePackManagementContract,
  billingUsagePackMigrationContract,
} from "@okouai/api-contracts/contracts/billing";
import {
  orgInviteContract,
  orgMembersContract,
} from "@okouai/api-contracts/contracts/org-member-routes";
import {
  webhookClerkContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";

import StripeSDK from "stripe";
import { onTestFinished } from "vitest";
import { accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";

import {
  mockStripeClient,
  type StripeInvoiceCreatePreviewParams,
} from "../../external/stripe-client";

import { billingCheckoutRoutes } from "../billing-checkout";
import { billingConcurrencyCheckoutRoutes } from "../billing-concurrency-checkout";
import { billingRestoreRoutes } from "../billing-restore";
import { billingStatusRoutes } from "../billing-status";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { flushWaitUntilForTest } from "../../context/wait-until";

import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { orgInviteRoutes } from "../org-invite";
import { orgMembersRoutes } from "../org-members";

import { webhooksStripeRoutes } from "../webhooks-stripe";

import {
  createBillingCheckoutFixture,
  type BillingOrgFixture,
  type SubscriptionFixture,
} from "./helpers/billing-checkout-fixture";

const {
  context,
  APP_ORIGIN,
  TEST_PRICE_PRO,
  TEST_PRICE_TEAM,
  TEST_PRICE_CUSTOM,
  TEST_PRICE_USAGE_PACK_PLAN_PRO,
  TEST_PRICE_USAGE_PACK_PLAN_TEAM,
  TEST_PRICE_USAGE_PACK_20,
  TEST_PRICE_USAGE_PACK_50,
  TEST_PRICE_USAGE_PACK_100,
  TEST_PRICE_USAGE_PACK_200,
  TEST_PRICE_CONCURRENCY,
  STRIPE_WEBHOOK_SECRET,
  ClerkApiResponseTestError,
  setTierPrices,
  setUsagePackPrices,
  usagePackPriceConfiguration,
  mockUsagePackCatalog,
  currentSecond,
  stripeInputMetadata,
  createOrgFixture,
  usagePackCheckoutBody,
  authenticateOrg,
  mockClerkOrganization,
  readBillingStatus,
  createSubscriptionOrg,
  createPublicBillingOrg,
} = createBillingCheckoutFixture();

beforeEach(async () => {
  await setupApp({ context, routes: billingCheckoutRoutes, isolatePg: true });
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
    readonly paymentIntentId: string;
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

  async function seedLegacyMigrationFixture(args: {
    readonly tier: "pro" | "team";
    readonly invitation?: boolean;
    readonly orgId?: string;
  }): Promise<LegacyMigrationFixture> {
    const orgId = args.orgId ?? `org_migration_${randomUUID()}`;
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
    const result: LegacyMigrationFixture = {
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
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    const sessionId = `cs_legacy_${randomUUID()}`;
    context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
      id: sessionId,
      url: `https://checkout.stripe.test/${sessionId}`,
    });
    await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingCheckoutContract,
      ).create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tier: args.tier,
          successUrl: `${APP_ORIGIN}/billing?billing=success`,
          cancelUrl: `${APP_ORIGIN}/billing?billing=canceled`,
        },
      }),
      [200],
    );
    const checkout =
      context.mocks.stripe.checkout.sessions.create.mock.calls.at(-1)?.[0];
    const metadata = stripeInputMetadata(checkout);
    expect(metadata.orgId).toBe(fixture.orgId);
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...legacyMigrationSubscription(result),
      metadata,
    });
    await postMigrationInvoice({
      id: legacyCreditInvoiceId,
      customer: customerId,
      metadata,
      parent: {
        subscription_details: { subscription: subscriptionId, metadata },
      },
      lines: {
        has_more: false,
        data: [
          {
            price: { id: legacyPriceId },
            parent: { type: "subscription_item_details" },
            period,
          },
        ],
      },
    });
    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      tier: args.tier,
      subscriptionStatus: "active",
      credits: args.tier === "pro" ? 20_000 : 120_000,
    });
    context.mocks.stripe.checkout.sessions.create.mockClear();
    return result;
  }

  async function readMigrationCredits(fixture: BillingOrgFixture) {
    authenticateOrg(fixture);
    const response = await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    return (response.body.memberCredits ?? [])
      .flatMap((member) => {
        return member.creditGrants.map((grant) => {
          return {
            ...grant,
            memberId: member.memberId,
          };
        });
      })
      .sort((a, b) => {
        return a.id.localeCompare(b.id);
      });
  }

  async function readMigrationAllocations(fixture: BillingOrgFixture) {
    authenticateOrg(fixture);
    return (
      await accept(
        setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackManagementContract,
        ).get({ headers: { authorization: "Bearer clerk-session" } }),
        [200],
      )
    ).body.allocations;
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
      paymentIntentId,
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

  it("confirms a migration when an extra unpaid member joins after preview", async () => {
    const fixture = await seedLegacyMigrationFixture({ tier: "pro" });
    mockMigrationStripe({
      fixture,
      packageQuantity: 1,
      currentRecurringAmountCents: 2000,
      amountDueCents: 2000,
      amountPaidCents: 2000,
    });
    const billingBefore = await readBillingStatus(fixture);
    const creditsBefore = await readMigrationCredits(fixture);
    const preview = await previewMigration(fixture);
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
            publicUserData: { userId: `user_unpaid_${randomUUID()}` },
            createdAt: now(),
          },
        ],
      },
    );
    const confirmed = await accept(
      migrationClient().confirm({
        params: { migrationId: preview.migrationId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("scheduled");
    const current = await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(current.body).toMatchObject({
      status: "scheduled",
      migrationId: preview.migrationId,
      configuration: {
        memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
      },
    });
    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      tier: billingBefore.tier,
      credits: billingBefore.credits,
      creditGrants: billingBefore.creditGrants,
    });
    await expect(readMigrationCredits(fixture)).resolves.toStrictEqual(
      creditsBefore,
    );
  });

  async function mockScheduleFromCurrentSubscription(): Promise<void> {
    const subscription = (await context.mocks.stripe.subscriptions.retrieve(
      "current",
    )) as MigrationSubscriptionMock;
    const item = subscription.items.data[0];
    if (!item) {
      throw new Error("A migration subscription must have a plan item");
    }
    mockNow(item.current_period_start * 1000);
    const currentPhase = {
      start_date: item.current_period_start,
      end_date: item.current_period_end,
    };
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: subscription.schedule,
      end_behavior: "release",
      current_phase: currentPhase,
      phases: [
        {
          ...currentPhase,
          items: subscription.items.data.map((item) => {
            return { price: item.price.id, quantity: item.quantity ?? 1 };
          }),
        },
      ],
    });
  }

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

    await expect(readMigrationAllocations(fixture)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: fixture.userId,
          usagePackUsd: 20,
        }),
      ]),
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [{ id: fixture.invitation.id }] },
    );
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: `re_${randomUUID()}`,
      status: "succeeded",
    });

    await mockScheduleFromCurrentSubscription();
    await accept(
      setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).revoke({
        headers: { authorization: "Bearer clerk-session" },
        body: { invitationId: fixture.invitation.id },
      }),
      [200],
    );

    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: stripe.paymentIntentId,
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
      undefined,
    );
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

    await expect(readMigrationAllocations(fixture)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: fixture.userId,
          usagePackUsd: 20,
        }),
      ]),
    );

    await mockScheduleFromCurrentSubscription();
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
    await expect(readMigrationAllocations(fixture)).resolves.toHaveLength(1);
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
      undefined,
    );
  });
});

describe("usage pack allocation management", () => {
  function createManagedUsagePackHelpers(lifecycle?: PublicBillingScenario) {
    const run =
      lifecycle?.run ??
      (<T>(operation: () => Promise<T>) => {
        return operation();
      });
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
        readonly billingPeriod?: {
          readonly start: number;
          readonly end: number;
        };
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
          data: [
            line(args.sourcePriceId, -1000),
            line(args.targetPriceId, 2500),
          ],
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
      return await run(async () => {
        const event = {
          id: `evt_${randomUUID()}`,
          type,
          created,
          data: { object },
        };
        if (lifecycle) {
          lifecycle.expectStripeEvent(event);
        } else {
          context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(
            event,
          );
        }
        lifecycle?.captureExternalState();
        await run(() => {
          return accept(
            setupApp({ context, routes: webhooksStripeRoutes })(
              webhookStripeContract,
            ).post({
              body: JSON.stringify(event),
              extraHeaders: { "stripe-signature": "t=1,v1=usage-pack-change" },
            }),
            [200],
          );
        });
      });
    }

    async function purchaseManagedUsagePack(
      allocations: readonly {
        readonly userId: string;
        readonly usagePackUsd: 20 | 50 | 100 | 200;
      }[],
      tier: ManagedUsagePackFixture["tier"] = "pro",
      actor?: BillingOrgFixture,
    ): Promise<
      ManagedUsagePackFixture & {
        readonly purchaseInvoice: ReturnType<typeof managedUsagePackInvoice>;
      }
    > {
      return await run(async () => {
        const firstMember = allocations[0];
        if (!firstMember) {
          throw new Error(
            "A managed usage pack purchase requires a paid member",
          );
        }
        const fixture = actor ?? createOrgFixture();
        authenticateOrg(fixture);
        mockClerkOrganization(fixture);
        const memberIds = [
          ...new Set([
            fixture.userId,
            ...allocations.map(({ userId }) => {
              return userId;
            }),
          ]),
        ];
        context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
          {
            data: memberIds.map((userId) => {
              return {
                role: userId === fixture.userId ? "org:admin" : "org:member",
                publicUserData: {
                  userId,
                  identifier: `${userId}@example.test`,
                },
                createdAt: now(),
              };
            }),
          },
        );
        lifecycle?.captureExternalState();
        context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
          { data: [] },
        );
        lifecycle?.captureExternalState();
        const customerId = `cus_${randomUUID()}`;
        const subscriptionId = `sub_${randomUUID()}`;
        const checkoutSessionId = `cs_${randomUUID()}`;
        if (lifecycle) {
          (() => {
            retainBillingSequence(context.mocks.stripe.customers.create, [
              () => {
                return Promise.resolve({
                  id: customerId,
                });
              },
            ]);
            lifecycle?.captureExternalState();
          })();
        } else {
          context.mocks.stripe.customers.create.mockResolvedValueOnce({
            id: customerId,
          });
        }
        lifecycle?.captureExternalState();
        let checkoutMetadata: Record<string, string> | undefined;
        const checkoutSession = (input: unknown) => {
          checkoutMetadata = stripeInputMetadata(input);
          return Promise.resolve({
            id: checkoutSessionId,
            url: `https://checkout.stripe.test/${checkoutSessionId}`,
          });
        };
        if (lifecycle) {
          retainBillingSequence(context.mocks.stripe.checkout.sessions.create, [
            checkoutSession,
          ]);
          lifecycle?.captureExternalState();
        } else {
          context.mocks.stripe.checkout.sessions.create.mockImplementationOnce(
            checkoutSession,
          );
        }
        const appOrigin = new URL(env("APP_URL")).origin;
        const checkout = await run(() => {
          return accept(
            setupApp({ context, routes: billingCheckoutRoutes })(
              billingUsagePackCheckoutContract,
            ).create({
              headers: { authorization: "Bearer clerk-session" },
              body: {
                ...usagePackCheckoutBody(fixture.userId),
                tier,
                successUrl: `${appOrigin}/billing?billing=success`,
                cancelUrl: `${appOrigin}/billing?billing=canceled`,
                memberUsagePacks: memberIds.map((memberId) => {
                  return {
                    memberId,
                    usagePackUsd:
                      allocations.find(({ userId }) => {
                        return userId === memberId;
                      })?.usagePackUsd ?? 0,
                  };
                }),
              },
            }),
            [200],
          );
        });
        expect(checkout.body).toStrictEqual({
          url: `https://checkout.stripe.test/${checkoutSessionId}`,
        });
        const metadata = checkoutMetadata;
        if (!metadata) {
          throw new Error("Stripe did not receive checkout metadata");
        }
        const usagePackSubscriptionId = metadata.usagePackSubscriptionId;
        if (!usagePackSubscriptionId) {
          throw new Error(
            "Checkout did not identify its usage pack subscription",
          );
        }
        const managedFixture: ManagedUsagePackFixture = {
          ...fixture,
          customerId,
          subscriptionId,
          usagePackSubscriptionId,
          tier,
          billingPeriod: {
            start: currentSecond() - 15 * 86_400,
            end: currentSecond() + 15 * 86_400,
          },
        };
        const quantities = new Map<string, number>();
        for (const allocation of allocations) {
          const priceId = priceIdForManagedUsagePack(allocation.usagePackUsd);
          quantities.set(priceId, (quantities.get(priceId) ?? 0) + 1);
        }
        expect(
          context.mocks.stripe.checkout.sessions.create,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            customer: customerId,
            metadata: managedUsagePackMetadata(managedFixture),
            subscription_data: {
              metadata: managedUsagePackMetadata(managedFixture),
            },
            line_items: [
              { price: managedUsagePackPlanPriceId(tier), quantity: 1 },
              ...([20, 50, 100, 200] as const).flatMap((amount) => {
                const price = priceIdForManagedUsagePack(amount);
                const quantity = quantities.get(price);
                return quantity === undefined ? [] : [{ price, quantity }];
              }),
            ],
          }),
          { idempotencyKey: `usage-pack-checkout:${usagePackSubscriptionId}` },
        );
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          managedUsagePackSubscription(managedFixture, quantities),
        );
        lifecycle?.captureExternalState();
        const purchaseInvoice = managedUsagePackInvoice(managedFixture, {
          invoiceId: `in_${randomUUID()}`,
          quantities,
        });
        await postManagedUsagePackEvent("invoice.paid", purchaseInvoice);
        expect(
          (
            await run(() => {
              return readBillingStatus(fixture);
            })
          ).tier,
        ).toBe(tier);
        const management = await readManagedUsagePacks(fixture);
        expect(management.allocations).toHaveLength(allocations.length);
        for (const allocation of allocations) {
          expect(management.allocations).toContainEqual(
            expect.objectContaining({
              memberId: allocation.userId,
              usagePackUsd: allocation.usagePackUsd,
              pendingChange: null,
            }),
          );
        }
        // Subsequent cases assert whether their action opens another Checkout.
        context.mocks.stripe.checkout.sessions.create.mockClear();
        return { ...managedFixture, purchaseInvoice };
      });
    }

    async function readManagedUsagePacks(fixture: BillingOrgFixture) {
      return await run(async () => {
        authenticateOrg(fixture);
        const response = await run(() => {
          return accept(
            setupApp({ context, routes: billingCheckoutRoutes })(
              billingUsagePackManagementContract,
            ).get({
              headers: { authorization: "Bearer clerk-session" },
            }),
            [200],
          );
        });
        return response.body;
      });
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
      return "id" in item && item.id?.startsWith("si_")
        ? item.id.slice(3)
        : null;
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
          pricing: { price_details: { price: targetPriceId } },
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
      scheduledSubscriptionId?: string,
    ): void {
      context.mocks.stripe.invoices.createPreview.mockImplementation(
        (input) => {
          if (typeof input !== "object" || input === null) {
            throw new Error("Expected Stripe invoice preview input");
          }
          if (
            scheduledSubscriptionId &&
            "preview_mode" in input &&
            input.preview_mode === "recurring" &&
            "subscription" in input &&
            input.subscription === scheduledSubscriptionId
          ) {
            throw new Error(
              "Recurring estimates do not support subscription schedules",
            );
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
            amount_due: immediate
              ? immediateAmountCents
              : nextRecurringAmountCents,
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
        },
      );
      lifecycle?.captureExternalState();
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
      context.mocks.stripe.invoices.createPreview.mockImplementation(
        (input) => {
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
        },
      );
      lifecycle?.captureExternalState();
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
      context.mocks.stripe.invoices.createPreview.mockImplementation(
        (input) => {
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
        },
      );
      lifecycle?.captureExternalState();
    }

    function mockUsagePackSubscriptionPackagePreviews(args: {
      readonly immediateAmountCents: number;
      readonly nextRecurringAmountCents: number;
      readonly sourcePriceId: string;
      readonly targetPriceId: string;
      readonly rejectScheduledSubscriptionRecurringPreview?: boolean;
    }): void {
      context.mocks.stripe.invoices.createPreview.mockImplementation(
        (input) => {
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
        },
      );
      lifecycle?.captureExternalState();
    }

    async function setupInvitationPreviewContext(
      emailPrefix: string,
      actor = createOrgFixture(),
      createManagedSubscription = purchaseManagedUsagePack,
    ): Promise<{
      readonly fixture: ManagedUsagePackFixture;
      readonly existingMemberUserId: string;
      readonly email: string;
    }> {
      return await run(async () => {
        mockNow(new Date("2035-05-15T00:00:00.000Z"));
        if (!lifecycle) {
          onTestFinished(() => {
            clearMockNow();
          });
        }
        const existingMemberUserId = `user_${randomUUID()}`;
        const fixture = await createManagedSubscription(
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
        lifecycle?.captureExternalState();
        context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
          { data: [] },
        );
        lifecycle?.captureExternalState();
        return { fixture, existingMemberUserId, email };
      });
    }

    function mockUsagePackSubscriptionAdditionPreviews(args: {
      readonly immediateAmountCents: number;
      readonly nextRecurringAmountCents: number;
      readonly targetPriceId: string;
    }): void {
      context.mocks.stripe.invoices.createPreview.mockImplementation(
        (input) => {
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
        },
      );
      lifecycle?.captureExternalState();
    }

    async function readDeferredReplayCredits(fixture: BillingOrgFixture) {
      return await run(async () => {
        authenticateOrg(fixture);
        const response = await run(() => {
          return accept(
            setupApp({ context, routes: billingUsagePackCreditsRoutes })(
              billingUsagePackCreditsContract,
            ).get({ headers: { authorization: "Bearer clerk-session" } }),
            [200],
          );
        });
        return response.body;
      });
    }

    async function readPurchasedCreditGrants(fixture: BillingOrgFixture) {
      return await run(async () => {
        const credits = await readDeferredReplayCredits(fixture);
        return (credits.memberCredits ?? [])
          .flatMap((member) => {
            return member.creditGrants.map((grant) => {
              return {
                ...grant,
                memberId: member.memberId,
              };
            });
          })
          .sort((a, b) => {
            return a.id.localeCompare(b.id);
          });
      });
    }

    async function beginInvitationPurchase(
      actor = createOrgFixture(),
      createManagedSubscription = purchaseManagedUsagePack,
    ): Promise<InvitationPurchaseFixture> {
      return await run(async () => {
        const { fixture, existingMemberUserId, email } =
          await setupInvitationPreviewContext(
            "invitee",
            actor,
            createManagedSubscription,
          );
        const paymentIntentId = `pi_invite_${randomUUID()}`;
        mockUsagePackChangePreviews(1000, 2000);
        const preview = await run(() => {
          return accept(
            setupApp({ context, routes: orgInviteRoutes })(
              orgInviteContract,
            ).previewPurchase({
              headers: { authorization: "Bearer clerk-session" },
              body: { email, role: "member", usagePackUsd: 20 },
            }),
            [200],
          );
        });
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
      });
    }

    async function payInvitationPurchase(
      purchase: InvitationPurchaseFixture,
      invitationId: string,
    ): Promise<void> {
      return await run(async () => {
        if (lifecycle) {
          (() => {
            retainBillingSequence(
              context.mocks.clerk.organizations.createOrganizationInvitation,
              [
                () => {
                  return Promise.resolve({
                    id: invitationId,
                    emailAddress: purchase.email,
                    organizationId: purchase.fixture.orgId,
                    status: "pending",
                    privateMetadata: {
                      usagePackInvitationPurchaseId: purchase.purchaseId,
                    },
                  });
                },
              ],
            );
            lifecycle?.captureExternalState();
          })();
        } else {
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
        }
        lifecycle?.captureExternalState();
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
      lifecycle?.captureExternalState();
      context.mocks.stripe.invoices.create.mockResolvedValue({
        id: invoiceId,
        metadata,
        status: "draft",
        hosted_invoice_url: null,
      });
      lifecycle?.captureExternalState();
      context.mocks.stripe.invoiceItems.create.mockResolvedValue({
        id: `ii_invite_${randomUUID()}`,
      });
      lifecycle?.captureExternalState();
      context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
        id: invoiceId,
        status: "open",
        hosted_invoice_url: `https://invoice.stripe.test/${invoiceId}`,
      });
      lifecycle?.captureExternalState();
      context.mocks.stripe.invoices.pay.mockResolvedValue({
        id: invoiceId,
        status: "paid",
      });
      lifecycle?.captureExternalState();
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
      lifecycle?.captureExternalState();
      return paymentIntentId;
    }

    async function postClerkInvitationAccepted(args: {
      readonly purchase: InvitationPurchaseFixture;
      readonly invitationId: string;
      readonly userId: string;
    }): Promise<void> {
      return await run(async () => {
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
        if (lifecycle) {
          lifecycle.expectClerkEvent(event);
        } else {
          context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
        }
        lifecycle?.captureExternalState();
        await run(() => {
          return accept(
            setupApp({ context, routes: webhooksClerkRoutes })(
              webhookClerkContract,
            ).post({
              body: JSON.stringify(event),
            }),
            [200],
          );
        });
        await run(() => {
          return flushWaitUntilForTest();
        });
      });
    }

    async function purchaseDeferredReplaySubscription(): Promise<ManagedUsagePackFixture> {
      if (!lifecycle) {
        throw new Error("Expected an owned usage-pack purchase");
      }
      return await run(async () => {
        const actor = createOrgFixture();
        authenticateOrg(actor);
        mockClerkOrganization(actor);
        const customerId = `cus_${randomUUID()}`;
        const subscriptionId = `sub_${randomUUID()}`;
        const checkoutSessionId = `cs_${randomUUID()}`;
        context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
          {
            data: [
              {
                role: "org:admin",
                publicUserData: { userId: actor.userId },
                createdAt: now(),
              },
            ],
          },
        );
        lifecycle?.captureExternalState();
        context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
          { data: [] },
        );
        lifecycle?.captureExternalState();
        context.mocks.stripe.customers.create.mockResolvedValue({
          id: customerId,
        });
        lifecycle?.captureExternalState();
        let checkoutMetadata: Record<string, string> | undefined;
        context.mocks.stripe.checkout.sessions.create.mockImplementation(
          (input) => {
            checkoutMetadata = stripeInputMetadata(input);
            return Promise.resolve({
              id: checkoutSessionId,
              url: `https://checkout.stripe.test/${checkoutSessionId}`,
            });
          },
        );
        lifecycle?.captureExternalState();
        const checkoutApp = await setupApp({
          context,
          routes: billingCheckoutRoutes,
        });
        await run(() => {
          return accept(
            checkoutApp(billingUsagePackCheckoutContract).create({
              headers: { authorization: "Bearer clerk-session" },
              body: { ...usagePackCheckoutBody(actor.userId), tier: "team" },
            }),
            [200],
          );
        });
        const metadata = checkoutMetadata;
        if (!metadata) {
          throw new Error("Stripe did not receive checkout metadata");
        }
        const usagePackSubscriptionId = metadata.usagePackSubscriptionId;
        if (!usagePackSubscriptionId) {
          throw new Error(
            "Checkout did not identify its usage pack subscription",
          );
        }
        const fixture: ManagedUsagePackFixture = {
          ...actor,
          customerId,
          subscriptionId,
          usagePackSubscriptionId,
          billingPeriod: {
            start: currentSecond() - 15 * 86_400,
            end: currentSecond() + 15 * 86_400,
          },
          tier: "team",
        };
        // Cleanup only removes this test's uniquely owned resources; setup and
        // assertions use production checkout, webhook, billing and credit routes.
        const quantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          managedUsagePackSubscription(fixture, quantities),
        );
        lifecycle?.captureExternalState();
        await postManagedUsagePackEvent(
          "invoice.paid",
          managedUsagePackInvoice(fixture, {
            invoiceId: `in_${randomUUID()}`,
            quantities,
          }),
        );
        expect(
          (
            await run(() => {
              return readBillingStatus(fixture);
            })
          ).tier,
        ).toBe("team");
        await expect(readDeferredReplayCredits(fixture)).resolves.toMatchObject(
          {
            hasUsagePack: true,
            purchasedCredits: 20_000,
            bonusCredits: 400,
            totalCredits: 20_400,
          },
        );
        return fixture;
      });
    }

    async function prepareDeferredInvoiceReplay(
      at = "2035-01-17T00:00:00.000Z",
      nextPhaseEnd = "2035-03-01T00:00:00.000Z",
    ) {
      return await run(async () => {
        mockNow(new Date(at));
        if (!lifecycle) {
          onTestFinished(() => {
            return clearMockNow();
          });
        }
        const fixture = await purchaseDeferredReplaySubscription();
        const userId = fixture.userId;
        const source = managedUsagePackSubscription(
          fixture,
          new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
        );
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(source);
        lifecycle?.captureExternalState();
        mockUsagePackSubscriptionPackagePreviews({
          immediateAmountCents: 1500,
          nextRecurringAmountCents: 5000,
          sourcePriceId: TEST_PRICE_USAGE_PACK_20,
          targetPriceId: TEST_PRICE_USAGE_PACK_50,
        });
        const client = setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackManagementContract,
        );
        const preview = await run(() => {
          return accept(
            run(() => {
              return client.previewSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: {
                  targetTier: "pro",
                  memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
                },
              });
            }),
            [200],
          );
        });
        const prorationTimestamp = Math.floor(
          new Date(preview.body.prorationDate).getTime() / 1000,
        );
        const invoice = managedUsagePackUpgradeInvoice(fixture, {
          invoiceId: `in_${randomUUID()}`,
          sourcePriceId: TEST_PRICE_USAGE_PACK_20,
          targetPriceId: TEST_PRICE_USAGE_PACK_50,
          prorationTimestamp,
        });
        context.mocks.stripe.subscriptions.update.mockResolvedValue({
          ...source,
          pending_update: { expires_at: prorationTimestamp + 300 },
          latest_invoice: { ...invoice, status: "open" },
        });
        lifecycle?.captureExternalState();
        await run(() => {
          return accept(
            run(() => {
              return client.confirmSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { changeId: preview.body.changeId },
              });
            }),
            [200],
          );
        });
        const subscription = managedUsagePackSubscription(
          fixture,
          new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
          fixture.billingPeriod,
          { latestInvoice: invoice },
        );
        const scheduleId = `sub_sched_${randomUUID()}`;
        const currentPhase = {
          start_date: fixture.billingPeriod.start,
          end_date: fixture.billingPeriod.end,
          currency: "usd",
          metadata: {},
          items: [
            {
              price: TEST_PRICE_USAGE_PACK_PLAN_TEAM,
              quantity: 1,
              metadata: {},
            },
            { price: TEST_PRICE_USAGE_PACK_50, quantity: 1, metadata: {} },
          ],
          proration_behavior: "none",
        };
        const initialSchedule = {
          id: scheduleId,
          end_behavior: "release",
          current_phase: currentPhase,
          phases: [currentPhase],
        };
        const scheduled = {
          ...initialSchedule,
          phases: [
            currentPhase,
            {
              ...currentPhase,
              start_date: fixture.billingPeriod.end,
              end_date: Math.floor(new Date(nextPhaseEnd).getTime() / 1000),
              items: [
                {
                  price: TEST_PRICE_USAGE_PACK_PLAN_PRO,
                  quantity: 1,
                  metadata: {},
                },
                { price: TEST_PRICE_USAGE_PACK_50, quantity: 1, metadata: {} },
              ],
            },
          ],
        };
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          subscription,
        );
        lifecycle?.captureExternalState();
        context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue(
          initialSchedule,
        );
        lifecycle?.captureExternalState();
        context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
          initialSchedule,
        );
        lifecycle?.captureExternalState();
        context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue(
          scheduled,
        );
        lifecycle?.captureExternalState();
        return {
          fixture,
          client,
          preview,
          invoice,
          subscription,
          scheduleId,
          initialSchedule,
          scheduled,
        };
      });
    }

    async function confirmPendingUsagePackUpgrade() {
      return await run(async () => {
        const sourceUserId = `user_${randomUUID()}`;
        const fixture = await purchaseManagedUsagePack([
          { userId: sourceUserId, usagePackUsd: 20 },
        ]);
        const oldSubscription = managedUsagePackSubscription(
          fixture,
          new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
        );
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          oldSubscription,
        );
        lifecycle?.captureExternalState();
        mockUsagePackChangePreviews(1500, 5000);
        const client = setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackManagementContract,
        );
        const preview = await run(() => {
          return accept(
            run(() => {
              return client.previewChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { memberId: sourceUserId, targetUsagePackUsd: 50 },
              });
            }),
            [200],
          );
        });
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
        lifecycle?.captureExternalState();
        const confirmed = await run(() => {
          return accept(
            run(() => {
              return client.confirmChange({
                params: { changeId: preview.body.changeId },
                headers: { authorization: "Bearer clerk-session" },
                body: {},
              });
            }),
            [200],
          );
        });
        expect(confirmed.body.status).toBe("pending_payment");
        const paidInvoice = {
          ...managedUsagePackUpgradeInvoice(fixture, {
            invoiceId: pendingInvoiceId,
            sourcePriceId: TEST_PRICE_USAGE_PACK_20,
            targetPriceId: TEST_PRICE_USAGE_PACK_50,
            prorationTimestamp,
          }),
          total: 1500,
          amount_paid: 1500,
        };
        context.mocks.stripe.creditNotes.list.mockResolvedValue({
          data: [],
          has_more: false,
        });
        lifecycle?.captureExternalState();
        context.mocks.stripe.creditNotes.create.mockResolvedValue({
          id: `cn_${randomUUID()}`,
          status: "issued",
        });
        lifecycle?.captureExternalState();
        return {
          fixture,
          changeId: preview.body.changeId,
          oldSubscription,
          canceledSubscription: { ...oldSubscription, status: "canceled" },
          paidInvoice,
        };
      });
    }

    function expectCanceledUpgradeRefund(changeId: string, invoiceId: string) {
      expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledOnce();
      expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledWith(
        expect.objectContaining({
          invoice: invoiceId,
          amount: 1500,
          refund_amount: 1500,
        }),
        {
          idempotencyKey: `usage-pack-change:${changeId}:${invoiceId}:canceled-refund`,
        },
      );
    }

    return {
      managedUsagePackMetadata,
      managedUsagePackSubscription,
      managedUsagePackInvoice,
      managedConcurrencyInvoiceLine,
      managedUsagePackUpgradeInvoice,
      managedUsagePackAdditionInvoice,
      postManagedUsagePackEvent,
      purchaseManagedUsagePack,
      readManagedUsagePacks,
      previewSubscriptionDetails,
      mockUsagePackChangePreviews,
      mockInvitationChargePreview,
      mockUsagePackSubscriptionChangePreviews,
      mockUsagePackSubscriptionPackagePreviews,
      setupInvitationPreviewContext,
      mockUsagePackSubscriptionAdditionPreviews,
      readPurchasedCreditGrants,
      beginInvitationPurchase,
      payInvitationPurchase,
      mockSavedCardInvitationPayment,
      postClerkInvitationAccepted,
      purchaseDeferredReplaySubscription,
      prepareDeferredInvoiceReplay,
      confirmPendingUsagePackUpgrade,
      expectCanceledUpgradeRefund,
      readDeferredReplayCredits,
    };
  }
  const {
    managedUsagePackMetadata,
    managedUsagePackSubscription,
    managedUsagePackInvoice,
    managedConcurrencyInvoiceLine,
    managedUsagePackUpgradeInvoice,
    managedUsagePackAdditionInvoice,
    postManagedUsagePackEvent,
    purchaseManagedUsagePack,
    readManagedUsagePacks,
    previewSubscriptionDetails,
    mockUsagePackChangePreviews,
    mockInvitationChargePreview,
    mockUsagePackSubscriptionChangePreviews,
    mockUsagePackSubscriptionPackagePreviews,
    setupInvitationPreviewContext,
    mockUsagePackSubscriptionAdditionPreviews,
    readPurchasedCreditGrants,
    confirmPendingUsagePackUpgrade,
    expectCanceledUpgradeRefund,
    beginInvitationPurchase,
    mockSavedCardInvitationPayment,
    postClerkInvitationAccepted,
  } = createManagedUsagePackHelpers();

  function scheduleForManagedSubscription(
    subscription: ReturnType<typeof managedUsagePackSubscription>,
    scheduleId: string,
  ) {
    const item = subscription.items.data[0];
    if (!item) {
      throw new Error("A managed subscription must have a plan item");
    }
    const currentPhase = {
      start_date: item.current_period_start,
      end_date: item.current_period_end,
    };
    return {
      id: scheduleId,
      end_behavior: "release",
      current_phase: currentPhase,
      phases: [
        {
          ...currentPhase,
          items: subscription.items.data.map((item) => {
            return {
              price: item.price.id,
              quantity: item.quantity,
            };
          }),
        },
      ],
    };
  }

  interface ManagedUsagePackFixture extends BillingOrgFixture {
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly usagePackSubscriptionId: string;
    readonly billingPeriod: { readonly start: number; readonly end: number };
    readonly tier: "pro" | "team";
  }

  type PreviewSubscriptionDetails = NonNullable<
    StripeInvoiceCreatePreviewParams["subscription_details"]
  >;

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

  interface InvitationPurchaseFixture {
    readonly fixture: ManagedUsagePackFixture;
    readonly existingMemberUserId: string;
    readonly email: string;
    readonly purchaseId: string;
    readonly paymentIntentId: string;
  }

  it("keeps management allocations isolated across successive organization requests", async () => {
    const lifecycle = createPublicBillingScenario(context);
    const { purchaseManagedUsagePack } =
      createManagedUsagePackHelpers(lifecycle);
    return await lifecycle.run(async () => {
      const actorA = createOrgFixture();
      const actorB = createOrgFixture();
      const fixtureA = await purchaseManagedUsagePack(
        [{ userId: actorA.userId, usagePackUsd: 20 }],
        "pro",
        actorA,
      );
      const fixtureB = await purchaseManagedUsagePack(
        [{ userId: actorB.userId, usagePackUsd: 50 }],
        "team",
        actorB,
      );
      const client = setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackManagementContract,
      );
      for (const fixture of [fixtureA, fixtureB, fixtureA]) {
        authenticateOrg(fixture);
        const response = await accept(
          client.get({ headers: { authorization: "Bearer clerk-session" } }),
          [200],
        );
        expect(response.body.tier).toBe(fixture.tier);
        expect(response.body.allocations).toStrictEqual([
          expect.objectContaining({
            memberId: fixture.userId,
            usagePackUsd: fixture.orgId === actorA.orgId ? 20 : 50,
            pendingChange: null,
          }),
        ]);
      }
    });
  });

  it("records a card collected for a usage pack purchase setup", async () => {
    const actor = createOrgFixture();
    const fixture = await purchaseManagedUsagePack(
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
    const lifecycle = createPublicBillingScenario(context);
    const run = lifecycle.run;
    const {
      purchaseManagedUsagePack,
      readPurchasedCreditGrants,
      managedUsagePackSubscription,
      managedUsagePackMetadata,
      postManagedUsagePackEvent,
      managedConcurrencyInvoiceLine,
    } = createManagedUsagePackHelpers(lifecycle);
    return await withNowScopeForTest(() => {
      return run(async () => {
        const actor = createOrgFixture();
        const fixture = await purchaseManagedUsagePack(
          [{ userId: actor.userId, usagePackUsd: 20 }],
          "team",
          actor,
        );
        const grantsBefore = await readPurchasedCreditGrants(fixture);
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
        lifecycle?.captureExternalState();
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

        const status = await run(() => {
          return readBillingStatus(fixture);
        });
        expect(status.concurrencySubscriptions).toStrictEqual([
          expect.objectContaining({
            id: fixture.subscriptionId,
            quantity,
            currentPeriodEnd: new Date(
              fixture.billingPeriod.end * 1000,
            ).toISOString(),
          }),
        ]);
        // A concurrency-only invoice cannot grant or replace user-visible package credit.
        await expect(readPurchasedCreditGrants(fixture)).resolves.toStrictEqual(
          grantsBefore,
        );
      });
    });
  });

  // Original scenario: B036.
  it("idempotently processes usage pack and concurrency from one renewal invoice", async () => {
    const lifecycle = createPublicBillingScenario(context);
    const run = lifecycle.run;
    const {
      purchaseManagedUsagePack,
      managedUsagePackSubscription,
      managedUsagePackInvoice,
      managedConcurrencyInvoiceLine,
      postManagedUsagePackEvent,
      readPurchasedCreditGrants,
      readManagedUsagePacks,
    } = createManagedUsagePackHelpers(lifecycle);
    return await withNowScopeForTest(() => {
      return run(async () => {
        const actor = createOrgFixture();
        const fixture = await purchaseManagedUsagePack(
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
        if (!lifecycle) {
          onTestFinished(() => {
            clearMockNow();
          });
        }
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
        lifecycle?.captureExternalState();
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

        const firstGrants = await readPurchasedCreditGrants(fixture);
        expect(firstGrants).toHaveLength(2);
        expect(firstGrants).toStrictEqual(
          expect.arrayContaining([
            expect.objectContaining({
              memberId: actor.userId,
              grantType: "purchased",
              amount: 20_000,
              remaining: 20_000,
              expiresAt: new Date(renewalPeriod.end * 1000).toISOString(),
            }),
            expect.objectContaining({
              memberId: actor.userId,
              grantType: "bonus",
              amount: 400,
              remaining: 400,
              expiresAt: new Date(renewalPeriod.end * 1000).toISOString(),
            }),
          ]),
        );
        expect(
          (await readManagedUsagePacks(fixture)).allocations,
        ).toStrictEqual([
          expect.objectContaining({
            memberId: actor.userId,
            usagePackUsd: 20,
            currentPeriodEnd: new Date(renewalPeriod.end * 1000).toISOString(),
            pendingChange: null,
          }),
        ]);
        const firstStatus = await run(() => {
          return readBillingStatus(fixture);
        });
        expect(firstStatus.concurrencySubscriptions).toStrictEqual([
          expect.objectContaining({
            id: fixture.subscriptionId,
            quantity,
            currentPeriodEnd: new Date(renewalPeriod.end * 1000).toISOString(),
          }),
        ]);

        await postManagedUsagePackEvent("invoice.paid", invoice);

        await expect(readPurchasedCreditGrants(fixture)).resolves.toStrictEqual(
          firstGrants,
        );
        const replayedStatus = await run(() => {
          return readBillingStatus(fixture);
        });
        expect(replayedStatus.concurrencySubscriptions).toStrictEqual(
          firstStatus.concurrencySubscriptions,
        );
      });
    });
  });

  it("fulfills usage packs on a shared Custom subscription without replacing the main plan", async () => {
    const actor = createOrgFixture();
    const fixture = await purchaseManagedUsagePack(
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
  });

  it.each([
    [20, 50],
    [50, 20],
  ] as const)(
    "previews a member Usage Pack change from %s to %s with a neutral schedule",
    async (sourceUsd, targetUsd) => {
      const userId = `user_${randomUUID()}`;
      const otherUserId = `user_${randomUUID()}`;
      const fixture = await purchaseManagedUsagePack([
        { userId, usagePackUsd: sourceUsd },
        { userId: otherUserId, usagePackUsd: sourceUsd },
      ]);
      const sourcePriceId =
        sourceUsd === 20 ? TEST_PRICE_USAGE_PACK_20 : TEST_PRICE_USAGE_PACK_50;
      const targetPriceId =
        targetUsd === 20 ? TEST_PRICE_USAGE_PACK_20 : TEST_PRICE_USAGE_PACK_50;
      const scheduleId = `sub_sched_${randomUUID()}`;
      const discountId = `di_${randomUUID()}`;
      const subscription = {
        ...managedUsagePackSubscription(
          fixture,
          new Map([[sourcePriceId, 2]]),
          fixture.billingPeriod,
          { scheduleId },
        ),
        discounts: [{ id: discountId }],
      };
      const items = subscription.items.data.map((item) => {
        return { price: item.price.id, quantity: item.quantity };
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription,
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
            items,
            discounts: [{ discount: discountId }],
          },
          {
            start_date: fixture.billingPeriod.end,
            end_date: fixture.billingPeriod.end + 30 * 86_400,
            items,
            discounts: [{ discount: discountId }],
          },
        ],
      });
      mockUsagePackChangePreviews(1500, 8000, fixture.subscriptionId);
      const preview = await accept(
        setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackManagementContract,
        ).previewChange({
          headers: { authorization: "Bearer clerk-session" },
          body: { memberId: userId, targetUsagePackUsd: targetUsd },
        }),
        [200],
      );
      expect(preview.body).toMatchObject({
        kind: targetUsd > sourceUsd ? "upgrade" : "downgrade",
        sourceUsagePackUsd: sourceUsd,
        targetUsagePackUsd: targetUsd,
        immediateAmountCents: targetUsd > sourceUsd ? 1500 : 0,
        nextRecurringAmountCents: 8000,
        currency: "usd",
      });
      expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
        customer: fixture.customerId,
        preview_mode: "recurring",
        discounts: [{ discount: discountId }],
        subscription_details: {
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
            { price: sourcePriceId, quantity: 1 },
            { price: targetPriceId, quantity: 1 },
          ],
        },
      });
      expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.subscriptionSchedules.release,
      ).not.toHaveBeenCalled();
      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).not.toHaveBeenCalled();
    },
  );

  // Original scenario: B050.
  it("rejects an allocation downgrade when the Plan starts ending after preview", async () => {
    const lifecycle = createPublicBillingScenario(context);
    const run = lifecycle.run;
    const {
      purchaseManagedUsagePack,
      managedUsagePackSubscription,
      mockUsagePackChangePreviews,
      readManagedUsagePacks,
    } = createManagedUsagePackHelpers(lifecycle);
    return await withNowScopeForTest(() => {
      return run(async () => {
        const userId = `user_${randomUUID()}`;
        const fixture = await purchaseManagedUsagePack(
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
        lifecycle?.captureExternalState();
        mockUsagePackChangePreviews(0, 2000);
        const client = setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackManagementContract,
        );
        const preview = await run(() => {
          return accept(
            run(() => {
              return client.previewChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { memberId: userId, targetUsagePackUsd: 20 },
              });
            }),
            [200],
          );
        });
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
          ...activeSubscription,
          cancel_at: fixture.billingPeriod.end,
          cancel_at_period_end: true,
        });
        lifecycle?.captureExternalState();

        const confirmed = await run(() => {
          return accept(
            run(() => {
              return client.confirmChange({
                params: { changeId: preview.body.changeId },
                headers: { authorization: "Bearer clerk-session" },
                body: {},
              });
            }),
            [409],
          );
        });

        expect(confirmed.body.error.message).toBe(
          "Your Plan is scheduled to end before this usage pack change can take effect. Restore your Plan first, then try again.",
        );
        expect(
          (await readManagedUsagePacks(fixture)).allocations,
        ).toStrictEqual([
          expect.objectContaining({
            memberId: userId,
            usagePackUsd: 50,
            pendingChange: null,
          }),
        ]);
      });
    });
  });

  it("continues through a Stripe schedule with no future billing changes", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack([
      { userId, usagePackUsd: 20 },
    ]);
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
    const fixture = await purchaseManagedUsagePack([
      { userId, usagePackUsd: 20 },
    ]);
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
    const lifecycle = createPublicBillingScenario(context);
    const run = lifecycle.run;
    const {
      purchaseManagedUsagePack,
      managedUsagePackSubscription,
      mockUsagePackSubscriptionChangePreviews,
      readPurchasedCreditGrants,
      managedUsagePackUpgradeInvoice,
      postManagedUsagePackEvent,
      readManagedUsagePacks,
    } = createManagedUsagePackHelpers(lifecycle);
    return await withNowScopeForTest(() => {
      return run(async () => {
        const userId = `user_${randomUUID()}`;
        const fixture = await purchaseManagedUsagePack([
          { userId, usagePackUsd: 20 },
        ]);
        const quantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
        const proSubscription = managedUsagePackSubscription(
          fixture,
          quantities,
        );
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          proSubscription,
        );
        lifecycle?.captureExternalState();
        mockUsagePackSubscriptionChangePreviews(8000, 16_000);
        const client = setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackManagementContract,
        );
        const preview = await run(() => {
          return accept(
            run(() => {
              return client.previewSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: {
                  targetTier: "team",
                  memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
                },
              });
            }),
            [200],
          );
        });
        expect(preview.body).toStrictEqual(
          expect.objectContaining({
            sourceTier: "pro",
            targetTier: "team",
            immediateAmountCents: 8000,
            nextRecurringAmountCents: 18_000,
            currency: "usd",
          }),
        );
        expect(
          context.mocks.stripe.invoices.createPreview,
        ).toHaveBeenCalledTimes(2);
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
        const grantsBefore = await readPurchasedCreditGrants(fixture);
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
        if (lifecycle) {
          (() => {
            retainBillingSequence(
              context.mocks.stripe.subscriptions.retrieve,
              [
                () => {
                  return Promise.resolve(proSubscription);
                },
              ],
              () => {
                return Promise.resolve(teamSubscription);
              },
            );
            lifecycle?.captureExternalState();
          })();
        } else {
          context.mocks.stripe.subscriptions.retrieve
            .mockResolvedValueOnce(proSubscription)
            .mockResolvedValue(teamSubscription);
        }
        lifecycle?.captureExternalState();
        context.mocks.stripe.subscriptions.update.mockResolvedValue(
          teamSubscription,
        );
        lifecycle?.captureExternalState();

        const response = await run(() => {
          return accept(
            run(() => {
              return client.confirmSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { changeId: preview.body.changeId },
              });
            }),
            [200],
          );
        });

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
        expect(
          (
            await run(() => {
              return readBillingStatus(fixture);
            })
          ).tier,
        ).toBe("team");
        expect(
          (await readManagedUsagePacks(fixture)).allocations,
        ).toStrictEqual([
          expect.objectContaining({
            memberId: userId,
            usagePackUsd: 20,
            pendingChange: null,
          }),
        ]);
        await expect(readPurchasedCreditGrants(fixture)).resolves.toStrictEqual(
          grantsBefore,
        );
        const management = await run(() => {
          return accept(
            run(() => {
              return client.get({
                headers: { authorization: "Bearer clerk-session" },
              });
            }),
            [200],
          );
        });
        expect(management.body.tier).toBe("team");
      });
    });
  });

  // Original scenario: B058.
  it("activates a pending plan upgrade from the paid invoice webhook", async () => {
    const lifecycle = createPublicBillingScenario(context);
    const run = lifecycle.run;
    const {
      purchaseManagedUsagePack,
      managedUsagePackSubscription,
      mockUsagePackSubscriptionChangePreviews,
      managedUsagePackUpgradeInvoice,
      readPurchasedCreditGrants,
      postManagedUsagePackEvent,
      readManagedUsagePacks,
    } = createManagedUsagePackHelpers(lifecycle);
    return await withNowScopeForTest(() => {
      return run(async () => {
        const userId = `user_${randomUUID()}`;
        const fixture = await purchaseManagedUsagePack([
          { userId, usagePackUsd: 20 },
        ]);
        const quantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
        const proSubscription = managedUsagePackSubscription(
          fixture,
          quantities,
        );
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          proSubscription,
        );
        lifecycle?.captureExternalState();
        mockUsagePackSubscriptionChangePreviews(8000, 16_000);
        const client = setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackManagementContract,
        );
        const preview = await run(() => {
          return accept(
            run(() => {
              return client.previewSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: {
                  targetTier: "team",
                  memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
                },
              });
            }),
            [200],
          );
        });
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
        lifecycle?.captureExternalState();
        const grantsBefore = await readPurchasedCreditGrants(fixture);

        const confirmed = await run(() => {
          return accept(
            run(() => {
              return client.confirmSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { changeId: preview.body.changeId },
              });
            }),
            [200],
          );
        });

        expect(confirmed.body).toStrictEqual({
          status: "pending_payment",
          effectiveAt: preview.body.prorationDate,
          hostedInvoiceUrl: paidInvoice.hosted_invoice_url,
        });
        await postManagedUsagePackEvent(
          "customer.subscription.updated",
          pendingSubscription,
        );
        expect(
          (
            await run(() => {
              return readBillingStatus(fixture);
            })
          ).tier,
        ).toBe("pro");

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
        lifecycle?.captureExternalState();
        await Promise.all([
          postManagedUsagePackEvent("invoice.paid", paidInvoice),
          postManagedUsagePackEvent("invoice.paid", paidInvoice),
        ]);
        await postManagedUsagePackEvent("invoice.paid", paidInvoice);

        expect(
          (
            await run(() => {
              return readBillingStatus(fixture);
            })
          ).tier,
        ).toBe("team");
        expect(
          (await readManagedUsagePacks(fixture)).allocations,
        ).toStrictEqual([
          expect.objectContaining({
            memberId: userId,
            usagePackUsd: 20,
            pendingChange: null,
          }),
        ]);
        await expect(readPurchasedCreditGrants(fixture)).resolves.toStrictEqual(
          grantsBefore,
        );
      });
    });
  });

  it("adds an active member package to the existing subscription", async () => {
    mockNow(new Date("2035-01-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const orgFixture = createOrgFixture();
    const addedUserId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack(
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
    const updatedManagement = await readManagedUsagePacks(fixture);
    expect(updatedManagement.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: orgFixture.userId,
          usagePackUsd: 20,
        }),
        expect.objectContaining({
          memberId: addedUserId,
          usagePackUsd: 50,
        }),
      ]),
    );
    const credits = await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const addedMemberCredits = credits.body.memberCredits?.find((member) => {
      return member.memberId === addedUserId;
    });
    expect(addedMemberCredits?.creditGrants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grantType: "purchased",
          amount: 25_000,
        }),
        expect.objectContaining({
          grantType: "bonus",
          amount: 1300,
        }),
      ]),
    );
  });

  it("restores a scheduled package downgrade with billing-only phase metadata", async () => {
    const lifecycle = createPublicBillingScenario(context);
    const run = lifecycle.run;
    const {
      purchaseManagedUsagePack,
      managedUsagePackSubscription,
      mockUsagePackChangePreviews,
      mockUsagePackSubscriptionPackagePreviews,
      readManagedUsagePacks,
    } = createManagedUsagePackHelpers(lifecycle);
    return await withNowScopeForTest(() => {
      return run(async () => {
        const userId = `user_${randomUUID()}`;
        const fixture = await purchaseManagedUsagePack([
          { userId, usagePackUsd: 50 },
        ]);
        const currentSubscription = managedUsagePackSubscription(
          fixture,
          new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
        );
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          currentSubscription,
        );
        lifecycle?.captureExternalState();
        mockUsagePackChangePreviews(0, 2000);
        const scheduleId = "sub_sched_usage_pack_restore";
        context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
          id: scheduleId,
        });
        lifecycle?.captureExternalState();
        context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
          id: scheduleId,
        });
        lifecycle?.captureExternalState();
        const client = setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackManagementContract,
        );
        const downgradePreview = await run(() => {
          return accept(
            run(() => {
              return client.previewSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: {
                  targetTier: "pro",
                  memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
                },
              });
            }),
            [200],
          );
        });
        const downgrade = await run(() => {
          return accept(
            run(() => {
              return client.confirmSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { changeId: downgradePreview.body.changeId },
              });
            }),
            [200],
          );
        });
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
        lifecycle?.captureExternalState();
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
              metadata: {
                orgId: fixture.orgId,
                impact_click_id: "retired-click",
                gclid: "retired-google-click",
                okou_campaign_id: "24220469665",
                utm_campaign: "retired-campaign",
                ga_client_id: "123.456",
                gdm_status: "sent",
                marketing_privacy_receipt: "retained-on-original-object",
                billingPurchaseId: "purchase-retained",
              },
              start_date: fixture.billingPeriod.start,
              end_date: fixture.billingPeriod.end,
              items: [
                { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
                { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
              ],
            },
            {
              metadata: {
                orgId: fixture.orgId,
                impact_click_id: "retired-click",
                gclid: "retired-google-click",
                okou_campaign_id: "24220469665",
                utm_campaign: "retired-campaign",
                ga_client_id: "123.456",
                gdm_status: "sent",
                marketing_privacy_receipt: "retained-on-original-object",
                billingPurchaseId: "purchase-retained",
              },
              start_date: fixture.billingPeriod.end,
              end_date: nextPeriodEnd,
              items: [
                { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
                { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
              ],
            },
          ],
        });
        lifecycle?.captureExternalState();
        const restorePreview = await run(() => {
          return accept(
            run(() => {
              return client.previewSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: {
                  targetTier: "pro",
                  memberUsagePacks: [{ memberId: userId, usagePackUsd: 50 }],
                },
              });
            }),
            [200],
          );
        });
        expect(restorePreview.body).toStrictEqual(
          expect.objectContaining({
            sourceTier: "pro",
            targetTier: "pro",
            immediateAmountCents: 0,
            nextRecurringAmountCents: 5000,
          }),
        );
        expect(
          context.mocks.stripe.invoices.createPreview,
        ).toHaveBeenCalledWith({
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
        lifecycle?.captureExternalState();
        const restored = await run(() => {
          return accept(
            run(() => {
              return client.confirmSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { changeId: restorePreview.body.changeId },
              });
            }),
            [200],
          );
        });
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
                metadata: {
                  orgId: fixture.orgId,
                  billingPurchaseId: "purchase-retained",
                },
                start_date: fixture.billingPeriod.start,
                end_date: fixture.billingPeriod.end,
                items: [
                  { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
                  { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
                ],
                proration_behavior: "none",
              },
              {
                metadata: {
                  orgId: fixture.orgId,
                  billingPurchaseId: "purchase-retained",
                },
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
        expect(
          (await readManagedUsagePacks(fixture)).allocations,
        ).toStrictEqual([
          expect.objectContaining({
            memberId: userId,
            usagePackUsd: 50,
            pendingChange: null,
          }),
        ]);
        const management = await run(() => {
          return accept(
            run(() => {
              return client.get({
                headers: { authorization: "Bearer clerk-session" },
              });
            }),
            [200],
          );
        });
        expect(management.body.allocations[0]?.pendingChange).toBeNull();

        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          scheduledSubscription,
        );
        lifecycle?.captureExternalState();
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
        lifecycle?.captureExternalState();
        mockUsagePackSubscriptionPackagePreviews({
          immediateAmountCents: 5000,
          nextRecurringAmountCents: 10_000,
          sourcePriceId: TEST_PRICE_USAGE_PACK_50,
          targetPriceId: TEST_PRICE_USAGE_PACK_100,
          rejectScheduledSubscriptionRecurringPreview: true,
        });
        const nextPreview = await run(() => {
          return accept(
            run(() => {
              return client.previewSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: {
                  targetTier: "pro",
                  memberUsagePacks: [{ memberId: userId, usagePackUsd: 100 }],
                },
              });
            }),
            [200],
          );
        });
        expect(nextPreview.body.nextRecurringAmountCents).toBe(10_000);
      });
    });
  });

  it("clears scheduled package changes when restoring a plan downgrade", async () => {
    const lifecycle = createPublicBillingScenario(context);
    const run = lifecycle.run;
    const {
      purchaseManagedUsagePack,
      managedUsagePackSubscription,
      mockUsagePackSubscriptionPackagePreviews,
      readManagedUsagePacks,
    } = createManagedUsagePackHelpers(lifecycle);
    return await withNowScopeForTest(() => {
      return run(async () => {
        const userId = `user_${randomUUID()}`;
        const fixture = await purchaseManagedUsagePack(
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
        lifecycle?.captureExternalState();
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
        lifecycle?.captureExternalState();
        context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
          id: scheduleId,
        });
        lifecycle?.captureExternalState();
        const managementClient = setupApp({
          context,
          routes: billingCheckoutRoutes,
        })(billingUsagePackManagementContract);
        const downgradePreview = await run(() => {
          return accept(
            run(() => {
              return managementClient.previewSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: {
                  targetTier: "pro",
                  memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
                },
              });
            }),
            [200],
          );
        });
        const downgrade = await run(() => {
          return accept(
            run(() => {
              return managementClient.confirmSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { changeId: downgradePreview.body.changeId },
              });
            }),
            [200],
          );
        });
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
        lifecycle?.captureExternalState();
        context.mocks.stripe.subscriptionSchedules.release.mockResolvedValue({
          id: scheduleId,
        });
        lifecycle?.captureExternalState();
        const restore = await run(() => {
          return accept(
            setupApp({ context, routes: billingRestoreRoutes })(
              billingRestoreContract,
            ).create({
              body: {},
              headers: { authorization: "Bearer clerk-session" },
            }),
            [200],
          );
        });
        expect(restore.body).toStrictEqual({ status: "restored" });
        expect(
          context.mocks.stripe.subscriptionSchedules.release,
        ).toHaveBeenCalledWith(scheduleId);
        expect(
          (await readManagedUsagePacks(fixture)).allocations,
        ).toStrictEqual([
          expect.objectContaining({
            memberId: userId,
            usagePackUsd: 100,
            pendingChange: null,
          }),
        ]);

        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          currentSubscription,
        );
        lifecycle?.captureExternalState();
        mockUsagePackSubscriptionPackagePreviews({
          immediateAmountCents: 10_000,
          nextRecurringAmountCents: 20_000,
          sourcePriceId: TEST_PRICE_USAGE_PACK_100,
          targetPriceId: TEST_PRICE_USAGE_PACK_200,
        });
        await run(() => {
          return accept(
            run(() => {
              return managementClient.previewSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: {
                  targetTier: "team",
                  memberUsagePacks: [{ memberId: userId, usagePackUsd: 200 }],
                },
              });
            }),
            [200],
          );
        });
      });
    });
  });

  // Original scenario: B075.
  it.each([["2035-01-17T00:00:00.000Z", "2035-03-01T00:00:00.000Z"]])(
    "completes local deferred schedule state after a lost Stripe response at %s",
    async (at, nextPhaseEnd) => {
      const lifecycle = createPublicBillingScenario(context);
      const run = lifecycle.run;
      const {
        prepareDeferredInvoiceReplay,
        postManagedUsagePackEvent,
        readDeferredReplayCredits,
      } = createManagedUsagePackHelpers(lifecycle);
      return await withNowScopeForTest(() => {
        return run(async () => {
          const replay = await prepareDeferredInvoiceReplay(at, nextPhaseEnd);
          if (lifecycle) {
            (() => {
              retainBillingSequence(
                context.mocks.stripe.subscriptionSchedules.update,
                [
                  () => {
                    // Stripe persists the schedule before its response is lost.
                    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
                      {
                        ...replay.subscription,
                        schedule: replay.scheduleId,
                      },
                    );
                    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
                      replay.scheduled,
                    );
                    lifecycle.captureExternalState();
                    return Promise.reject(
                      new Error(
                        "Stripe response lost after applying the schedule",
                      ),
                    );
                  },
                ],
              );
              lifecycle?.captureExternalState();
            })();
          } else {
            context.mocks.stripe.subscriptionSchedules.update.mockRejectedValueOnce(
              new Error("Stripe response lost after applying the schedule"),
            );
          }
          lifecycle?.captureExternalState();
          await expect(
            postManagedUsagePackEvent("invoice.paid", replay.invoice),
          ).rejects.toThrow(
            "Unknown response status 500 for POST /api/webhooks/stripe",
          );
          const before = await readDeferredReplayCredits(replay.fixture);

          await postManagedUsagePackEvent("invoice.paid", replay.invoice);

          expect(
            context.mocks.stripe.subscriptionSchedules.update,
          ).toHaveBeenCalledOnce();
          expect(
            (await readDeferredReplayCredits(replay.fixture)).creditGrants,
          ).toStrictEqual(before.creditGrants);
          const confirmation = await run(() => {
            return accept(
              replay.client.confirmSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { changeId: replay.preview.body.changeId },
              }),
              [200],
            );
          });
          expect(confirmation.body.status).toBe("scheduled");
        });
      });
    },
  );

  // Original scenario: B084.
  it("does not resurrect a restored deferred schedule when an old invoice is delivered", async () => {
    const lifecycle = createPublicBillingScenario(context);
    const run = lifecycle.run;
    const {
      prepareDeferredInvoiceReplay,
      postManagedUsagePackEvent,
      readPurchasedCreditGrants,
      readManagedUsagePacks,
    } = createManagedUsagePackHelpers(lifecycle);
    return await withNowScopeForTest(() => {
      return run(async () => {
        const replay = await prepareDeferredInvoiceReplay();
        context.mocks.stripe.customers.retrieve.mockResolvedValue({
          id: replay.fixture.customerId,
          invoice_settings: { default_payment_method: `pm_${randomUUID()}` },
        });
        lifecycle?.captureExternalState();
        await postManagedUsagePackEvent("invoice.paid", replay.invoice);
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
          ...replay.subscription,
          schedule: replay.scheduleId,
        });
        lifecycle?.captureExternalState();
        context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
          replay.scheduled,
        );
        lifecycle?.captureExternalState();
        await run(() => {
          return accept(
            setupApp({ context, routes: billingRestoreRoutes })(
              billingRestoreContract,
            ).create({
              headers: { authorization: "Bearer clerk-session" },
              body: {},
            }),
            [200],
          );
        });
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          replay.subscription,
        );
        lifecycle?.captureExternalState();
        const grantsAfterRestore = await readPurchasedCreditGrants(
          replay.fixture,
        );
        const managementAfterRestore = await readManagedUsagePacks(
          replay.fixture,
        );

        await postManagedUsagePackEvent("invoice.paid", replay.invoice);

        await expect(
          readPurchasedCreditGrants(replay.fixture),
        ).resolves.toStrictEqual(grantsAfterRestore);
        await expect(
          readManagedUsagePacks(replay.fixture),
        ).resolves.toStrictEqual(managementAfterRestore);
        expect(
          context.mocks.stripe.subscriptionSchedules.update,
        ).toHaveBeenCalledOnce();
        expect(
          context.mocks.stripe.subscriptionSchedules.create,
        ).toHaveBeenCalledOnce();
        const status = await run(() => {
          return accept(
            setupApp({ context, routes: billingStatusRoutes })(
              billingStatusContract,
            ).get({
              headers: { authorization: "Bearer clerk-session" },
            }),
            [200],
          );
        });
        expect(status.body.scheduledChange).toBeNull();
      });
    });
  });

  it("revises a pending Team to Pro schedule when the package total increases from $20 to $40", async () => {
    const actor = createOrgFixture();
    const addedUserId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack(
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
    expect(downgradePreview.body).toStrictEqual(
      expect.objectContaining({
        sourceTier: "team",
        targetTier: "pro",
        immediateAmountCents: 0,
        nextRecurringAmountCents: 2000,
        effectiveAt: new Date(fixture.billingPeriod.end * 1000).toISOString(),
      }),
    );
    const downgrade = await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: downgradePreview.body.changeId },
      }),
      [200],
    );
    expect(downgrade.body).toStrictEqual({
      status: "scheduled",
      effectiveAt: new Date(fixture.billingPeriod.end * 1000).toISOString(),
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
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
        idempotencyKey: `usage-pack-subscription-change:${downgradePreview.body.changeId}:schedule-update`,
      },
    );
    expect((await readBillingStatus(fixture)).tier).toBe("team");
    expect((await readManagedUsagePacks(fixture)).allocations).toStrictEqual([
      expect.objectContaining({ memberId: actor.userId, usagePackUsd: 20 }),
    ]);

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

  // Original scenario: B096.
  it("settles a paid upgrade and its subscription deletion in exactly one order", async () => {
    mockNow(new Date("2035-01-17T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const { fixture, changeId, canceledSubscription, paidInvoice } =
      await confirmPendingUsagePackUpgrade();
    const grantsBefore = await readPurchasedCreditGrants(fixture);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      canceledSubscription,
    );

    await Promise.all([
      postManagedUsagePackEvent("invoice.paid", paidInvoice),
      postManagedUsagePackEvent(
        "customer.subscription.deleted",
        canceledSubscription,
      ),
    ]);
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);
    await postManagedUsagePackEvent(
      "customer.subscription.deleted",
      canceledSubscription,
    );

    // The canceled subscription can never reflect the upgrade, so whichever
    // delivery wins, the paid invoice is refunded exactly once instead of
    // granting credits or failing the webhook forever.
    const settled = await readPurchasedCreditGrants(fixture);
    expect(settled).toStrictEqual(grantsBefore);
    expectCanceledUpgradeRefund(changeId, paidInvoice.id);
  });

  // Original scenario: B099.
  it("fulfills a paid upgrade once without a refund before its subscription deletion", async () => {
    mockNow(new Date("2035-01-17T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const { fixture, canceledSubscription, paidInvoice } =
      await confirmPendingUsagePackUpgrade();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      ),
    );

    await postManagedUsagePackEvent("invoice.paid", paidInvoice);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      canceledSubscription,
    );
    await postManagedUsagePackEvent(
      "customer.subscription.deleted",
      canceledSubscription,
    );
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);

    const settled = await readPurchasedCreditGrants(fixture);
    expect(
      settled.filter((grant) => {
        return grant.amount === 15_000;
      }),
    ).toHaveLength(1);
    expect(settled).toHaveLength(4);
    expect(settled).toContainEqual(
      expect.objectContaining({
        grantType: "bonus",
        amount: 1100,
        remaining: 1100,
      }),
    );
    expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
  });

  it("completes an immediately paid upgrade during confirmation", async () => {
    const lifecycle = createPublicBillingScenario(context);
    const run = lifecycle.run;
    const {
      purchaseManagedUsagePack,
      managedUsagePackSubscription,
      mockUsagePackChangePreviews,
      managedUsagePackUpgradeInvoice,
      readManagedUsagePacks,
      readPurchasedCreditGrants,
    } = createManagedUsagePackHelpers(lifecycle);
    return await withNowScopeForTest(() => {
      return run(async () => {
        mockNow(new Date("2035-01-20T00:00:00.000Z"));
        if (!lifecycle) {
          onTestFinished(() => {
            clearMockNow();
          });
        }
        const userId = `user_${randomUUID()}`;
        const fixture = await purchaseManagedUsagePack([
          { userId, usagePackUsd: 20 },
        ]);
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
        lifecycle?.captureExternalState();
        mockUsagePackChangePreviews(1500, 5000);
        const client = setupApp({ context, routes: billingCheckoutRoutes })(
          billingUsagePackManagementContract,
        );
        const preview = await run(() => {
          return accept(
            run(() => {
              return client.previewChange({
                headers: { authorization: "Bearer clerk-session" },
                body: {
                  memberId: userId,
                  targetUsagePackUsd: 50,
                  supportsInAppPreview: true,
                  returnUrl: `${APP_ORIGIN}/billing`,
                },
              });
            }),
            [200],
          );
        });
        const paymentMethodPreviewToken =
          preview.body.paymentMethodPreviewToken;
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
        // The pre-confirmation configuration repair reads the unchanged Plan first.
        if (lifecycle) {
          (() => {
            retainBillingSequence(
              context.mocks.stripe.subscriptions.retrieve,
              [
                () => {
                  return Promise.resolve(oldSubscription);
                },
                () => {
                  return Promise.resolve(oldSubscription);
                },
                () => {
                  return Promise.resolve(oldSubscription);
                },
              ],
              () => {
                return Promise.resolve(upgradedSubscription);
              },
            );
            lifecycle?.captureExternalState();
          })();
        } else {
          context.mocks.stripe.subscriptions.retrieve
            .mockResolvedValueOnce(oldSubscription)
            .mockResolvedValueOnce(oldSubscription)
            .mockResolvedValueOnce(oldSubscription)
            .mockResolvedValue(upgradedSubscription);
        }
        lifecycle?.captureExternalState();
        context.mocks.stripe.subscriptions.update.mockResolvedValue(
          upgradedSubscription,
        );
        lifecycle?.captureExternalState();

        const confirmed = await run(() => {
          return accept(
            run(() => {
              return client.confirmChange({
                params: { changeId: preview.body.changeId },
                headers: { authorization: "Bearer clerk-session" },
                body: { paymentMethodPreviewToken },
              });
            }),
            [200],
          );
        });
        expect(confirmed.body.status).toBe("completed");
        expect(
          context.mocks.stripe.subscriptions.update,
        ).toHaveBeenNthCalledWith(1, fixture.subscriptionId, {
          default_payment_method: paymentMethodId,
        });
        expect(
          context.mocks.stripe.subscriptions.update,
        ).toHaveBeenNthCalledWith(
          2,
          fixture.subscriptionId,
          expect.objectContaining({
            payment_behavior: "pending_if_incomplete",
            proration_behavior: "always_invoice",
            proration_date: prorationTimestamp,
          }),
          {
            idempotencyKey: `usage-pack-change:${preview.body.changeId}:apply`,
          },
        );
        expect(
          (await readManagedUsagePacks(fixture)).allocations,
        ).toStrictEqual([
          expect.objectContaining({
            memberId: userId,
            usagePackUsd: 50,
            pendingChange: null,
          }),
        ]);
        await expect(readPurchasedCreditGrants(fixture)).resolves.toHaveLength(
          4,
        );
      });
    });
  });

  it("invites members from a Limited Free workspace without billing", async () => {
    const fixture = await createPublicBillingOrg();
    await fixture.run(async () => {
      authenticateOrg(fixture);
      const billing = await readBillingStatus(fixture);
      expect(billing.status).toBe("active");
      expect(billing.showUsagePack).toBeFalsy();
      context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
        { id: `inv_${randomUUID()}` },
      );
      const invited = await accept(
        setupApp({ context, routes: orgInviteRoutes })(
          orgInviteContract,
        ).invite({
          headers: { authorization: "Bearer clerk-session" },
          body: { email: "limited-free-1@example.test", role: "member" },
        }),
        [200],
      );
      expect(invited.body.message).toContain("limited-free-1@example.test");
      expect(
        context.mocks.stripe.checkout.sessions.create,
      ).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    "keeps a downgrade scheduled until the boundary and renews aggregate quantities (existing schedule: %s)",
    async (existingSchedule) => {
      mockNow(new Date("2035-03-16T00:00:00.000Z"));
      onTestFinished(() => {
        clearMockNow();
      });
      const userId = `user_${randomUUID()}`;
      const secondUserId = `user_${randomUUID()}`;
      const fixture = await purchaseManagedUsagePack([
        { userId, usagePackUsd: 50 },
        { userId: secondUserId, usagePackUsd: 20 },
      ]);
      const currentQuantities = new Map([
        [TEST_PRICE_USAGE_PACK_50, 1],
        [TEST_PRICE_USAGE_PACK_20, 1],
      ]);
      const scheduleId = `sub_sched_downgrade_${randomUUID()}`;
      const phaseStart = fixture.billingPeriod.start + 5 * 86_400;
      const currentSubscription = managedUsagePackSubscription(
        fixture,
        currentQuantities,
        fixture.billingPeriod,
        existingSchedule ? { scheduleId } : undefined,
      );
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        currentSubscription,
      );
      mockUsagePackChangePreviews(0, 4000);
      const sourceSchedule = scheduleForManagedSubscription(
        currentSubscription,
        scheduleId,
      );
      const splitSchedule = {
        ...sourceSchedule,
        current_phase: {
          start_date: phaseStart,
          end_date: fixture.billingPeriod.end,
        },
        phases: [
          ...sourceSchedule.phases.map((phase) => {
            return { ...phase, end_date: phaseStart };
          }),
          ...sourceSchedule.phases.map((phase) => {
            return { ...phase, start_date: phaseStart };
          }),
          ...(existingSchedule
            ? sourceSchedule.phases.map((phase) => {
                return {
                  ...phase,
                  start_date: fixture.billingPeriod.end,
                  end_date: fixture.billingPeriod.end + 31 * 86_400,
                };
              })
            : []),
        ],
      };
      context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue(
        splitSchedule,
      );
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
        splitSchedule,
      );
      context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
        id: scheduleId,
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
        scheduleId,
        expect.objectContaining({
          phases: expect.arrayContaining([
            expect.objectContaining({
              start_date: phaseStart,
              end_date: fixture.billingPeriod.end,
            }),
            expect.objectContaining({
              ...(existingSchedule
                ? { end_date: fixture.billingPeriod.end + 31 * 86_400 }
                : { duration: { interval: "month", interval_count: 1 } }),
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
      const scheduled = await readManagedUsagePacks(fixture);
      expect(scheduled.allocations).toContainEqual(
        expect.objectContaining({
          memberId: userId,
          usagePackUsd: 50,
          pendingChange: expect.objectContaining({
            id: preview.body.changeId,
            status: "scheduled",
          }),
        }),
      );
      const creditsBefore = await readPurchasedCreditGrants(fixture);
      expect(creditsBefore).toHaveLength(4);

      const nextPeriod = {
        start: fixture.billingPeriod.end,
        end: fixture.billingPeriod.end + 30 * 86_400,
      };
      const boundarySubscription = managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
        nextPeriod,
        { scheduleId: scheduleId },
      );
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        boundarySubscription,
      );
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
        id: scheduleId,
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
      const completed = await readManagedUsagePacks(fixture);
      expect(completed.allocations).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            memberId: userId,
            usagePackUsd: 20,
            pendingChange: null,
          }),
          expect.objectContaining({
            memberId: secondUserId,
            usagePackUsd: 20,
            pendingChange: null,
          }),
        ]),
      );
      await expect(readPurchasedCreditGrants(fixture)).resolves.toStrictEqual(
        creditsBefore,
      );
    },
  );

  it("adds concurrency without replacing a scheduled usage pack downgrade", async () => {
    mockNow(new Date("2035-03-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const actor = createOrgFixture();
    const fixture = await purchaseManagedUsagePack(
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
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue(
      scheduleForManagedSubscription(currentSubscription, scheduleId),
    );
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

  it("refunds the invoice when the removed member owns the last package", async () => {
    mockNow(new Date("2035-04-20T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const targetUserId = `user_${randomUUID()}`;
    const targetEmail = `${targetUserId}@example.test`;
    const fixture = await purchaseManagedUsagePack([
      { userId: targetUserId, usagePackUsd: 20 },
    ]);
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
    expect(
      (await readPurchasedCreditGrants(fixture)).filter((grant) => {
        return grant.memberId === targetUserId;
      }),
    ).toStrictEqual([]);
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.stringMatching(/^in_/u),
        lines: [
          {
            type: "invoice_line_item",
            invoice_line_item: expect.stringMatching(/^il_/u),
            amount: 2000,
          },
        ],
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
    expect((await readBillingStatus(fixture)).cancelAtPeriodEnd).toBeTruthy();
  });

  it.each(["pro", "team"] as const)(
    "invites members without purchasing a package on managed %s plans",
    async (tier) => {
      const fixture = await purchaseManagedUsagePack(
        [{ userId: `user_${randomUUID()}`, usagePackUsd: 20 }],
        tier,
      );
      const billing = await readBillingStatus(fixture);
      expect(billing.showUsagePack).toBeTruthy();

      context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
        { id: `inv_${randomUUID()}` },
      );
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

  describe.each([
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
    ({
      lineAmountCents,
      subtotalCents,
      exclusiveTaxCents,
      expectedAmountCents,
    }) => {
      let prepared: Awaited<ReturnType<typeof setupInvitationPreviewContext>>;
      beforeEach(async () => {
        prepared = await setupInvitationPreviewContext(
          "priced-invite",
          createOrgFixture(),
          purchaseManagedUsagePack,
        );
        mockInvitationChargePreview({
          lines: [{ lineAmountCents, subtotalCents, exclusiveTaxCents }],
          periodEnd: prepared.fixture.billingPeriod.end,
        });
      });
      it("previews and persists time-based invitation credits", async () => {
        const { fixture, email } = prepared;
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
        context.mocks.stripe.invoices.createPreview.mockClear();
        const reopened = await accept(
          setupApp({ context, routes: orgInviteRoutes })(
            orgInviteContract,
          ).previewPurchase({
            headers: { authorization: "Bearer clerk-session" },
            body: { email, role: "member", usagePackUsd: 20 },
          }),
          [200],
        );
        expect(reopened.body).toStrictEqual(response.body);
        expect(
          context.mocks.stripe.invoices.createPreview,
        ).not.toHaveBeenCalled();
      });
    },
  );

  it("finds an invitation proration line across every preview page", async () => {
    const { fixture, email } = await setupInvitationPreviewContext(
      "paginated-invite",
      createOrgFixture(),
      purchaseManagedUsagePack,
    );
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
    const fixture = await purchaseManagedUsagePack([
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

  it("includes the invitation purchase timestamp when confirming later", async () => {
    const { fixture, email } = await setupInvitationPreviewContext(
      "taxed-invite",
      createOrgFixture(),
      purchaseManagedUsagePack,
    );
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
    mockClerkUsers(context, [{ id: fixture.userId, privateMetadata: {} }]);
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: fixture.customerId,
      metadata: {},
    });
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
        metadata: {
          ...metadata,
          purchaseCreatedAt: expect.any(String),
        },
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

  // Original scenario: B144.
  it("resumes invitation creation on a later request after a post-payment Clerk rate limit", async () => {
    const lifecycle = createPublicBillingScenario(context);
    const run = lifecycle.run;
    const {
      beginInvitationPurchase,
      purchaseManagedUsagePack,
      mockSavedCardInvitationPayment,
    } = createManagedUsagePackHelpers(lifecycle);
    return await withNowScopeForTest(() => {
      return run(async () => {
        const purchase = await beginInvitationPurchase(
          createOrgFixture(),
          purchaseManagedUsagePack,
        );
        mockSavedCardInvitationPayment(purchase);
        const invitationId = `inv_resumed_${randomUUID()}`;
        const existingMember = {
          publicUserData: {
            userId: purchase.existingMemberUserId,
            identifier: `${purchase.existingMemberUserId}@example.test`,
          },
          createdAt: now(),
        };
        context.mocks.signalTimers.delay.mockResolvedValue(undefined);
        lifecycle?.captureExternalState();
        context.mocks.clerk.organizations.getOrganizationMembershipList.mockClear();
        if (lifecycle) {
          (() => {
            retainBillingSequence(
              context.mocks.clerk.organizations.getOrganizationMembershipList,
              [
                () => {
                  return Promise.resolve({ data: [existingMember] });
                },
              ],
              () => {
                return Promise.reject(new ClerkApiResponseTestError(9));
              },
            );
            lifecycle?.captureExternalState();
          })();
        } else {
          context.mocks.clerk.organizations.getOrganizationMembershipList
            .mockResolvedValueOnce({ data: [existingMember] })
            .mockRejectedValue(new ClerkApiResponseTestError(9));
        }
        lifecycle?.captureExternalState();
        context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
          { data: [] },
        );
        lifecycle?.captureExternalState();
        const client = setupApp({ context, routes: orgInviteRoutes })(
          orgInviteContract,
        );

        const limited = await run(() => {
          return accept(
            run(() => {
              return client.confirmPurchase({
                headers: { authorization: "Bearer clerk-session" },
                params: { purchaseId: purchase.purchaseId },
                body: {},
              });
            }),
            [503],
          );
        });

        expect(limited.headers.get("Retry-After")).toBe("9");
        expect(limited.headers.get("Cache-Control")).toBe("no-store");
        expect(
          context.mocks.clerk.organizations.getOrganizationMembershipList,
        ).toHaveBeenCalledTimes(2);
        expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
        expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(1);
        expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledTimes(1);
        expect(
          context.mocks.clerk.organizations.createOrganizationInvitation,
        ).not.toHaveBeenCalled();

        context.mocks.clerk.organizations.getOrganizationMembershipList.mockClear();
        context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
          { data: [existingMember] },
        );
        lifecycle?.captureExternalState();
        if (lifecycle) {
          (() => {
            retainBillingSequence(
              context.mocks.clerk.organizations.createOrganizationInvitation,
              [
                () => {
                  return Promise.resolve({
                    id: invitationId,
                    emailAddress: purchase.email,
                    organizationId: purchase.fixture.orgId,
                    status: "pending",
                  });
                },
              ],
            );
            lifecycle?.captureExternalState();
          })();
        } else {
          context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
            {
              id: invitationId,
              emailAddress: purchase.email,
              organizationId: purchase.fixture.orgId,
              status: "pending",
            },
          );
        }
        lifecycle?.captureExternalState();
        const resumed = await run(() => {
          return accept(
            run(() => {
              return client.confirmPurchase({
                headers: { authorization: "Bearer clerk-session" },
                params: { purchaseId: purchase.purchaseId },
                body: {},
              });
            }),
            [200],
          );
        });

        expect(resumed.body.message).toBe("Invitation purchased and sent");
        expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(1);
        expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledTimes(1);
        expect(
          context.mocks.clerk.organizations.createOrganizationInvitation,
        ).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("confirms an invitation with the signed payment preview and the same saved card", async () => {
    const { fixture, email } =
      await setupInvitationPreviewContext("signed-invite");
    const { organizations } = context.mocks.clerk;
    const paymentMethodId = `pm_invite_${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      default_payment_method: paymentMethodId,
    });
    mockUsagePackChangePreviews(1000, 2000);
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
          supportsInAppPreview: true,
          returnUrl: APP_ORIGIN,
        },
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
      paymentMethodPreviewToken: expect.stringMatching(/^.+$/),
    });
    const token = preview.body.paymentMethodPreviewToken;
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();
    expect(organizations.createOrganizationInvitation).not.toHaveBeenCalled();
    const invoiceId = `in_invite_${randomUUID()}`;
    const metadata = {
      purpose: "usage_pack_invitation_purchase",
      usagePackInvitationPurchaseId: preview.body.purchaseId,
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
    context.mocks.stripe.invoices.retrieve.mockResolvedValue({
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
              payment_intent: `pi_invite_${randomUUID()}`,
            },
          },
        ],
      },
    });
    organizations.createOrganizationInvitation.mockResolvedValue({
      id: `inv_${randomUUID()}`,
      emailAddress: email,
      status: "pending",
    });
    const response = await accept(
      client.confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: preview.body.purchaseId },
        body: { paymentMethodPreviewToken: token },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({
      message: "Invitation purchased and sent",
    });
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: fixture.customerId,
        default_payment_method: paymentMethodId,
        metadata: expect.objectContaining(metadata),
      }),
      expect.any(Object),
    );
    expect(organizations.createOrganizationInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: fixture.orgId,
        emailAddress: email,
        role: "org:member",
        privateMetadata: expect.objectContaining({
          usagePackInvitationPurchaseId: preview.body.purchaseId,
        }),
      }),
    );
  });

  // Original scenario: B154.
  it("grants invitation credits once across concurrent payment and acceptance deliveries", async () => {
    const lifecycle = createPublicBillingScenario(context);
    const run = lifecycle.run;
    const {
      purchaseDeferredReplaySubscription,
      readDeferredReplayCredits,
      mockUsagePackChangePreviews,
      payInvitationPurchase,
      postClerkInvitationAccepted,
    } = createManagedUsagePackHelpers(lifecycle);
    return await withNowScopeForTest(() => {
      return run(async () => {
        mockNow(new Date("2035-05-15T00:00:00.000Z"));
        if (!lifecycle) {
          onTestFinished(() => {
            clearMockNow();
          });
        }
        const fixture = await purchaseDeferredReplaySubscription();
        const creditsBeforeInvitation =
          await readDeferredReplayCredits(fixture);
        const email = `concurrent-invitation-${randomUUID()}@example.test`;
        const invitationId = `inv_${randomUUID()}`;
        const acceptedUserId = `user_${randomUUID()}`;
        mockUsagePackChangePreviews(1000, 2000);
        const preview = await run(() => {
          return accept(
            setupApp({ context, routes: orgInviteRoutes })(
              orgInviteContract,
            ).previewPurchase({
              headers: { authorization: "Bearer clerk-session" },
              body: { email, role: "member", usagePackUsd: 20 },
            }),
            [200],
          );
        });
        const purchase: InvitationPurchaseFixture = {
          fixture,
          existingMemberUserId: fixture.userId,
          email,
          purchaseId: preview.body.purchaseId,
          paymentIntentId: `pi_${randomUUID()}`,
        };
        await Promise.all([
          payInvitationPurchase(purchase, invitationId),
          payInvitationPurchase(purchase, invitationId),
        ]);
        const pendingCredits = await readDeferredReplayCredits(fixture);
        // A paid but unaccepted invitation must not change any available credits.
        // This public checkout fixture starts with a full-period owner package.
        expect(pendingCredits).toStrictEqual(creditsBeforeInvitation);
        expect(pendingCredits.memberCredits).not.toContainEqual(
          expect.objectContaining({ memberId: acceptedUserId }),
        );
        expect(
          (
            await run(() => {
              return readGetStartedStatus(context, fixture);
            })
          ).quests.find((quest) => {
            return quest.key === "invite";
          }),
        ).toMatchObject({ claimedCount: 0, pendingCount: 1 });
        expect(
          context.mocks.clerk.organizations.createOrganizationInvitation,
        ).toHaveBeenCalledTimes(1);
        expect(
          context.mocks.stripe.subscriptions.update,
        ).not.toHaveBeenCalled();

        context.mocks.stripe.subscriptions.update.mockResolvedValue({});
        lifecycle?.captureExternalState();
        await Promise.all([
          postClerkInvitationAccepted({
            purchase,
            invitationId,
            userId: acceptedUserId,
          }),
          postClerkInvitationAccepted({
            purchase,
            invitationId,
            userId: acceptedUserId,
          }),
        ]);

        const credits = await readDeferredReplayCredits(fixture);
        expect(
          credits.memberCredits?.filter((member) => {
            return member.memberId === acceptedUserId;
          }),
        ).toStrictEqual([
          expect.objectContaining({
            memberId: acceptedUserId,
            purchasedCredits: preview.body.purchasedCredits,
            bonusCredits: preview.body.bonusCredits,
            totalCredits: preview.body.totalCredits,
          }),
        ]);
        expect(credits).toMatchObject({
          hasUsagePack: true,
          purchasedCredits: 20_000,
          // The owner's existing package also receives the one accepted-invite reward.
          bonusCredits: 500,
          totalCredits: 20_500,
        });
        await postClerkInvitationAccepted({
          purchase,
          invitationId,
          userId: acceptedUserId,
        });
        await expect(readDeferredReplayCredits(fixture)).resolves.toStrictEqual(
          credits,
        );
        expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(
          1,
        );
        const getStarted = await run(() => {
          return readGetStartedStatus(context, fixture);
        });
        expect(
          getStarted.quests.find((quest) => {
            return quest.key === "invite";
          }),
        ).toMatchObject({ claimedCount: 1, earnedCredits: 100 });
      });
    });
  });

  // Original scenario: B155.
  it("refunds a paid invitation accepted at period end once across webhook replay", async () => {
    const lifecycle = createPublicBillingScenario(context);
    const run = lifecycle.run;
    const {
      purchaseDeferredReplaySubscription,
      mockUsagePackChangePreviews,
      payInvitationPurchase,
      postClerkInvitationAccepted,
    } = createManagedUsagePackHelpers(lifecycle);
    return await withNowScopeForTest(() => {
      return run(async () => {
        mockNow(new Date("2035-05-15T00:00:00.000Z"));
        if (!lifecycle) {
          onTestFinished(() => {
            clearMockNow();
          });
        }
        const fixture = await purchaseDeferredReplaySubscription();
        const email = `late-invitation-${randomUUID()}@example.test`;
        const invitationId = `inv_${randomUUID()}`;
        const acceptedUserId = `user_${randomUUID()}`;
        mockUsagePackChangePreviews(1000, 2000);
        const client = setupApp({ context, routes: orgInviteRoutes })(
          orgInviteContract,
        );
        const preview = await run(() => {
          return accept(
            run(() => {
              return client.previewPurchase({
                headers: { authorization: "Bearer clerk-session" },
                body: { email, role: "member", usagePackUsd: 20 },
              });
            }),
            [200],
          );
        });
        const purchase: InvitationPurchaseFixture = {
          fixture,
          existingMemberUserId: fixture.userId,
          email,
          purchaseId: preview.body.purchaseId,
          paymentIntentId: `pi_${randomUUID()}`,
        };
        await payInvitationPurchase(purchase, invitationId);
        const refundId = `re_${randomUUID()}`;
        context.mocks.stripe.refunds.create.mockResolvedValue({
          id: refundId,
          status: "succeeded",
        });
        lifecycle?.captureExternalState();
        mockNow(new Date(fixture.billingPeriod.end * 1000));
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

        expect(context.mocks.stripe.refunds.create).toHaveBeenCalledOnce();
        expect(context.mocks.stripe.refunds.create).toHaveBeenCalledWith(
          {
            payment_intent: purchase.paymentIntentId,
            amount: 1000,
            metadata: expect.objectContaining({
              purpose: "usage_pack_invitation_purchase",
              usagePackInvitationPurchaseId: purchase.purchaseId,
            }),
          },
          {
            idempotencyKey: `usage-pack-invitation:${purchase.purchaseId}:refund:1`,
          },
        );
        expect(
          context.mocks.stripe.subscriptions.update,
        ).not.toHaveBeenCalled();
        const inactive = await run(() => {
          return accept(
            run(() => {
              return client.confirmPurchase({
                headers: { authorization: "Bearer clerk-session" },
                params: { purchaseId: purchase.purchaseId },
                body: {},
              });
            }),
            [409],
          );
        });
        expect(inactive.body.error.code).toBe("INVITATION_PURCHASE_INACTIVE");
        authenticateOrg(
          { orgId: fixture.orgId, userId: acceptedUserId },
          "org:member",
        );
        const credits = await run(() => {
          return accept(
            setupApp({ context, routes: billingUsagePackCreditsRoutes })(
              billingUsagePackCreditsContract,
            ).get({ headers: { authorization: "Bearer clerk-session" } }),
            [200],
          );
        });
        expect(credits.body).toStrictEqual({
          totalCredits: 0,
          purchasedCredits: 0,
          bonusCredits: 0,
          hasUsagePack: false,
          creditGrants: [],
        });
      });
    });
  });

  // Original scenario: B157.
  it("refunds a partially consumed invitation package when Clerk removes the member", async () => {
    const preview = await beginInvitationPurchase();
    const purchase = {
      ...preview,
      paymentIntentId: mockSavedCardInvitationPayment(preview),
    };
    const invitationId = `inv_removed_${randomUUID()}`;
    const acceptedUserId = `user_removed_${randomUUID()}`;
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValueOnce(
      {
        id: invitationId,
        emailAddress: purchase.email,
        organizationId: purchase.fixture.orgId,
        status: "pending",
      },
    );
    const confirmed = await accept(
      setupApp({ context, routes: orgInviteRoutes })(
        orgInviteContract,
      ).confirmPurchase({
        headers: { authorization: "Bearer clerk-session" },
        params: { purchaseId: purchase.purchaseId },
        body: {},
      }),
      [200],
    );
    expect(confirmed.body).toMatchObject({
      message: "Invitation purchased and sent",
    });
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          usagePackInvitationPurchaseId: purchase.purchaseId,
        }),
      }),
      expect.any(Object),
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
    await postClerkInvitationAccepted({
      purchase,
      invitationId,
      userId: acceptedUserId,
    });
    context.mocks.stripe.subscriptions.update.mockClear();
    const member = createBddApi(context).user({
      orgId: purchase.fixture.orgId,
      userId: acceptedUserId,
      orgRole: "org:member",
    });
    // Normal usage consumes purchased credits before bonus credits.
    await chargePublicSeoUsage(context, member, 5000);
    authenticateOrg(purchase.fixture);
    expect(
      (await readPurchasedCreditGrants(purchase.fixture))
        .filter((grant) => {
          return grant.memberId === acceptedUserId;
        })
        .sort((left, right) => {
          return left.grantType.localeCompare(right.grantType);
        }),
    ).toStrictEqual([
      expect.objectContaining({
        grantType: "bonus",
        amount: 200,
        remaining: 200,
      }),
      expect.objectContaining({
        grantType: "purchased",
        amount: 10_000,
        remaining: 5000,
      }),
    ]);

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

    expect(
      (await readPurchasedCreditGrants(purchase.fixture)).filter((grant) => {
        return grant.memberId === acceptedUserId;
      }),
    ).toStrictEqual([]);
    expect(
      (await readManagedUsagePacks(purchase.fixture)).allocations,
    ).not.toContainEqual(expect.objectContaining({ memberId: acceptedUserId }));
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

  // Original scenarios: B158, B159.
  it.each(["allocation", "plan"] as const)(
    "finishes a pending %s payment before activating a paid invitation",
    async (kind) => {
      const lifecycle = createPublicBillingScenario(context);
      const run = lifecycle.run;
      const {
        purchaseDeferredReplaySubscription,
        mockUsagePackChangePreviews,
        payInvitationPurchase,
        mockUsagePackSubscriptionPackagePreviews,
        managedUsagePackUpgradeInvoice,
        managedUsagePackSubscription,
        postClerkInvitationAccepted,
        readDeferredReplayCredits,
        postManagedUsagePackEvent,
      } = createManagedUsagePackHelpers(lifecycle);
      return await withNowScopeForTest(() => {
        return run(async () => {
          mockNow(new Date("2035-05-15T00:00:00.000Z"));
          if (!lifecycle) {
            onTestFinished(() => {
              clearMockNow();
            });
          }
          const fixture = await purchaseDeferredReplaySubscription();
          const email = `admission-invite-${randomUUID()}@example.test`;
          const invitationId = `inv_admission_${randomUUID()}`;
          const acceptedUserId = `user_admission_${randomUUID()}`;
          mockUsagePackChangePreviews(1000, 2000);
          const invitationPreview = await run(() => {
            return accept(
              setupApp({ context, routes: orgInviteRoutes })(
                orgInviteContract,
              ).previewPurchase({
                headers: { authorization: "Bearer clerk-session" },
                body: { email, role: "member", usagePackUsd: 20 },
              }),
              [200],
            );
          });
          const purchase: InvitationPurchaseFixture = {
            fixture,
            existingMemberUserId: fixture.userId,
            email,
            purchaseId: invitationPreview.body.purchaseId,
            paymentIntentId: `pi_admission_${randomUUID()}`,
          };
          await payInvitationPurchase(purchase, invitationId);
          mockUsagePackSubscriptionPackagePreviews({
            immediateAmountCents: 1500,
            nextRecurringAmountCents: 5000,
            sourcePriceId: TEST_PRICE_USAGE_PACK_20,
            targetPriceId: TEST_PRICE_USAGE_PACK_50,
          });
          const client = setupApp({ context, routes: billingCheckoutRoutes })(
            billingUsagePackManagementContract,
          );
          const preview =
            kind === "allocation"
              ? await run(() => {
                  return accept(
                    run(() => {
                      return client.previewChange({
                        headers: { authorization: "Bearer clerk-session" },
                        body: {
                          memberId: fixture.userId,
                          targetUsagePackUsd: 50,
                        },
                      });
                    }),
                    [200],
                  );
                })
              : await run(() => {
                  return accept(
                    run(() => {
                      return client.previewSubscriptionChange({
                        headers: { authorization: "Bearer clerk-session" },
                        body: {
                          targetTier: "team",
                          memberUsagePacks: [
                            { memberId: fixture.userId, usagePackUsd: 50 },
                          ],
                        },
                      });
                    }),
                    [200],
                  );
                });
          const prorationTimestamp = Math.floor(
            new Date(preview.body.prorationDate).getTime() / 1000,
          );
          const paidInvoice = managedUsagePackUpgradeInvoice(fixture, {
            invoiceId: `in_admission_${randomUUID()}`,
            sourcePriceId: TEST_PRICE_USAGE_PACK_20,
            targetPriceId: TEST_PRICE_USAGE_PACK_50,
            prorationTimestamp,
          });
          const pendingInvoice = {
            ...paidInvoice,
            status: "open",
            paid: false,
          };
          const pendingSubscription = managedUsagePackSubscription(
            fixture,
            new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
            fixture.billingPeriod,
            {
              pendingUpdateExpiresAt: prorationTimestamp + 300,
              latestInvoice: pendingInvoice,
            },
          );
          context.mocks.stripe.subscriptions.update.mockResolvedValue(
            pendingSubscription,
          );
          lifecycle?.captureExternalState();
          context.mocks.stripe.invoices.pay.mockResolvedValue(pendingInvoice);
          lifecycle?.captureExternalState();
          context.mocks.stripe.invoices.retrieve.mockResolvedValue(
            pendingInvoice,
          );
          lifecycle?.captureExternalState();
          const confirm = async () => {
            return kind === "allocation"
              ? await run(() => {
                  return accept(
                    run(() => {
                      return client.confirmChange({
                        params: { changeId: preview.body.changeId },
                        headers: { authorization: "Bearer clerk-session" },
                        body: {},
                      });
                    }),
                    [200],
                  );
                })
              : await run(() => {
                  return accept(
                    run(() => {
                      return client.confirmSubscriptionChange({
                        headers: { authorization: "Bearer clerk-session" },
                        body: { changeId: preview.body.changeId },
                      });
                    }),
                    [200],
                  );
                });
          };
          expect((await confirm()).body.status).toBe("pending_payment");
          context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
            pendingSubscription,
          );
          lifecycle?.captureExternalState();

          // The pending invoice is the real unfinished billing operation. Accepting
          // an invitation must not replace that pending update or grant early credit.
          await postClerkInvitationAccepted({
            purchase,
            invitationId,
            userId: acceptedUserId,
          });
          expect((await confirm()).body.status).toBe("pending_payment");
          await expect(
            readDeferredReplayCredits(fixture),
          ).resolves.toMatchObject({
            purchasedCredits: 20_000,
            bonusCredits: 500,
          });
          await expect(
            readDeferredReplayCredits({ ...fixture, userId: acceptedUserId }),
          ).resolves.toMatchObject({ purchasedCredits: 0, bonusCredits: 0 });
          authenticateOrg(fixture);

          // Provider payment and ordinary Clerk redelivery finish both operations;
          // no test-only reconciliation route or internal state manipulation is used.
          const upgradedSubscription = managedUsagePackSubscription(
            fixture,
            new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
            fixture.billingPeriod,
            { latestInvoice: paidInvoice },
          );
          context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
            upgradedSubscription,
          );
          lifecycle?.captureExternalState();
          context.mocks.stripe.invoices.retrieve.mockResolvedValue(paidInvoice);
          lifecycle?.captureExternalState();
          await postManagedUsagePackEvent("invoice.paid", paidInvoice);
          expect((await confirm()).body.status).toBe("completed");
          context.mocks.stripe.subscriptions.update.mockResolvedValue(
            managedUsagePackSubscription(
              fixture,
              new Map([
                [TEST_PRICE_USAGE_PACK_50, 1],
                [TEST_PRICE_USAGE_PACK_20, 1],
              ]),
            ),
          );
          lifecycle?.captureExternalState();
          await postClerkInvitationAccepted({
            purchase,
            invitationId,
            userId: acceptedUserId,
          });
          await expect(
            readDeferredReplayCredits({ ...fixture, userId: acceptedUserId }),
          ).resolves.toMatchObject({
            purchasedCredits: 10_000,
            bonusCredits: 200,
            totalCredits: 10_200,
          });
          await expect(
            readDeferredReplayCredits(fixture),
          ).resolves.toMatchObject({
            purchasedCredits: 35_000,
            bonusCredits: 1600,
          });
          const management = await run(() => {
            return accept(
              run(() => {
                return client.get({
                  headers: { authorization: "Bearer clerk-session" },
                });
              }),
              [200],
            );
          });
          expect(management.body.allocations).toContainEqual(
            expect.objectContaining({
              memberId: fixture.userId,
              usagePackUsd: 50,
            }),
          );
          expect(management.body.allocations).toContainEqual(
            expect.objectContaining({
              memberId: acceptedUserId,
              usagePackUsd: 20,
            }),
          );
          context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
            managedUsagePackSubscription(
              fixture,
              new Map([
                [TEST_PRICE_USAGE_PACK_50, 1],
                [TEST_PRICE_USAGE_PACK_20, 1],
              ]),
            ),
          );
          lifecycle?.captureExternalState();
          await postManagedUsagePackEvent("invoice.paid", paidInvoice);
          await postClerkInvitationAccepted({
            purchase,
            invitationId,
            userId: acceptedUserId,
          });
          await expect(
            readDeferredReplayCredits({ ...fixture, userId: acceptedUserId }),
          ).resolves.toMatchObject({
            purchasedCredits: 10_000,
            bonusCredits: 200,
          });
          await expect(
            readDeferredReplayCredits(fixture),
          ).resolves.toMatchObject({
            purchasedCredits: 35_000,
            bonusCredits: 1600,
          });
        });
      });
    },
  );

  // Original scenarios: B161, B162.
  it.each(["pending", "failed"] as const)(
    "completes a paid invitation refund after a %s provider response through public revoke",
    async (status) => {
      const lifecycle = createPublicBillingScenario(context);
      const run = lifecycle.run;
      const {
        beginInvitationPurchase,
        purchaseManagedUsagePack,
        payInvitationPurchase,
        readPurchasedCreditGrants,
        readManagedUsagePacks,
      } = createManagedUsagePackHelpers(lifecycle);
      return await withNowScopeForTest(() => {
        return run(async () => {
          const purchase = await beginInvitationPurchase(
            createOrgFixture(),
            purchaseManagedUsagePack,
          );
          const invitationId = `inv_refund_${randomUUID()}`;
          await payInvitationPurchase(purchase, invitationId);
          context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
            { data: [{ id: invitationId }] },
          );
          context.mocks.clerk.organizations.revokeOrganizationInvitation.mockResolvedValue(
            {},
          );
          const initialRefundId = `re_${randomUUID()}`;
          context.mocks.stripe.refunds.create.mockResolvedValue({
            id: initialRefundId,
            status,
          });
          lifecycle.captureExternalState();
          const creditsBefore = await readPurchasedCreditGrants(
            purchase.fixture,
          );
          const managementBefore = await readManagedUsagePacks(
            purchase.fixture,
          );
          const client = setupApp({ context, routes: orgInviteRoutes })(
            orgInviteContract,
          );
          const revoke = () => {
            return run(() => {
              return accept(
                client.revoke({
                  headers: { authorization: "Bearer clerk-session" },
                  body: { invitationId },
                }),
                [200],
              );
            });
          };
          expect((await revoke()).body.message).toBe(
            "Invitation revoked and refund initiated",
          );
          mockNow(now() + 5 * 60_000 + 1);
          context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
            { data: [] },
          );
          const succeeded = {
            id: status === "pending" ? initialRefundId : `re_${randomUUID()}`,
            status: "succeeded",
          };
          context.mocks.stripe.refunds.retrieve.mockResolvedValue(succeeded);
          context.mocks.stripe.refunds.create.mockResolvedValue(succeeded);
          lifecycle.captureExternalState();
          expect((await revoke()).body.message).toBe(
            "Invitation revoked and refund initiated",
          );
          await revoke();
          await expect(
            readPurchasedCreditGrants(purchase.fixture),
          ).resolves.toStrictEqual(creditsBefore);
          await expect(
            readManagedUsagePacks(purchase.fixture),
          ).resolves.toStrictEqual(managementBefore);
          expect(context.mocks.stripe.refunds.create).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
              payment_intent: purchase.paymentIntentId,
              amount: 1000,
            }),
            {
              idempotencyKey: `usage-pack-invitation:${purchase.purchaseId}:refund:1`,
            },
          );
          if (status === "pending") {
            expect(context.mocks.stripe.refunds.create).toHaveBeenCalledOnce();
            expect(
              context.mocks.stripe.refunds.retrieve,
            ).toHaveBeenCalledExactlyOnceWith(initialRefundId);
          } else {
            expect(
              context.mocks.stripe.refunds.retrieve,
            ).not.toHaveBeenCalled();
            expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(
              2,
            );
            expect(context.mocks.stripe.refunds.create).toHaveBeenNthCalledWith(
              2,
              expect.objectContaining({
                payment_intent: purchase.paymentIntentId,
                amount: 1000,
              }),
              {
                idempotencyKey: `usage-pack-invitation:${purchase.purchaseId}:refund:2`,
              },
            );
          }
        });
      });
    },
  );
});
