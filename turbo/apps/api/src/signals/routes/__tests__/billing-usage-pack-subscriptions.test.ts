import { randomUUID } from "node:crypto";
import { mockClerkUsers } from "./helpers/clerk-users";
import { readGetStartedStatus } from "./helpers/get-started";
import {
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
import { isStaffOrg } from "@okouai/core/staff-org";
import { HttpResponse, http } from "msw";
import StripeSDK from "stripe";
import { onTestFinished } from "vitest";
import { accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  mockStripeClient,
  type StripeInvoiceCreatePreviewParams,
} from "../../external/stripe-client";
import { createDeferredPromise } from "../../utils";
import { billingCheckoutRoutes } from "../billing-checkout";
import { billingConcurrencyCheckoutRoutes } from "../billing-concurrency-checkout";
import { billingRestoreRoutes } from "../billing-restore";
import { billingStatusRoutes } from "../billing-status";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { orgInviteRoutes } from "../org-invite";
import { orgMembersRoutes } from "../org-members";
import { orgReadRoutes } from "../org-read";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";

import {
  createBillingCheckoutFixture,
  type BillingOrgFixture,
  type SubscriptionFixture,
} from "./helpers/billing-checkout-fixture";

const {
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

  it("rejects migration pricing prepared before the source Plan starts ending", async () => {
    const period = {
      start: currentSecond() - 15 * 86_400,
      end: currentSecond() + 15 * 86_400,
    };
    const fixture = await createSubscriptionOrg({
      tier: "pro",
      periodEndUnix: period.end,
    });
    onTestFinished(() => {
      return clearMigrationFixture(fixture.orgId);
    });
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
    const source = {
      id: fixture.subscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      pending_update: null,
      metadata: { orgId: fixture.orgId },
      items: {
        data: [
          {
            id: `si_legacy_${randomUUID()}`,
            price: {
              id: TEST_PRICE_PRO,
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 1,
            current_period_start: period.start,
            current_period_end: period.end,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(source);
    const before = await readBillingStatus(fixture);
    const quote = { amount_due: 2000, currency: "usd" };
    const started = createDeferredPromise<void>(context.signal);
    const response = createDeferredPromise<typeof quote>(context.signal);
    context.mocks.stripe.invoices.createPreview
      .mockResolvedValue(quote)
      .mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
    const request = migrationClient().preview({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        targetTier: "pro",
        memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
      },
    });
    onTestFinished(async () => {
      if (!started.settled()) {
        started.resolve();
      }
      if (!response.settled()) {
        response.resolve(quote);
      }
      await Promise.allSettled([request]);
    });
    await started.promise;
    const ending = {
      ...source,
      cancel_at: period.end,
      cancel_at_period_end: true,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(ending);
    await postMigrationSubscription(ending);
    response.resolve(quote);
    const rejected = await accept(request, [409]);
    expect(rejected.body.error.message).toBe(
      "Another subscription update is in progress",
    );
    await accept(
      migrationClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      tier: "pro",
      cancelAtPeriodEnd: true,
      credits: before.credits,
    });

    // Restoring the actual source Plan permits a fresh quote; a rejected old
    // provider response cannot leave a new migration intent or mutate credits.
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(source);
    await postMigrationSubscription(source);
    const retried = await accept(
      migrationClient().preview({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    expect(retried.body).toMatchObject({
      purchasedCredits: 20_000,
      bonusCredits: 400,
      totalCredits: 20_400,
    });
    await expect(readBillingStatus(fixture)).resolves.toMatchObject({
      tier: "pro",
      cancelAtPeriodEnd: false,
      credits: before.credits,
    });
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
      const scheduled = await accept(
        migrationClient().get({
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

  async function mockScheduleFromCurrentSubscription(): Promise<void> {
    const subscription = (await context.mocks.stripe.subscriptions.retrieve(
      "current",
    )) as {
      readonly items: {
        readonly data: readonly {
          readonly price: { readonly id: string };
          readonly quantity?: number;
        }[];
      };
    };
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: `sub_sched_current_${randomUUID()}`,
      phases: [
        {
          start_date: 0,
          end_date: 4_102_444_800,
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
      undefined,
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

  it.each([0, 20_000])(
    "publishes a migration payment of %s once across concurrent delivery and replay",
    async (amountPaidCents) => {
      const fixture = await seedLegacyMigrationFixture({
        tier: "team",
        invitation: true,
      });
      if (!fixture.invitation) {
        throw new Error("Expected migration invitation");
      }
      const stripe = mockMigrationStripe({
        fixture,
        packageQuantity: 2,
        currentRecurringAmountCents: 20_000,
        amountDueCents: amountPaidCents,
        amountPaidCents,
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
      stripe.startScheduledPhase();
      await Promise.all([
        postMigrationInvoice(stripe.invoice()),
        postMigrationInvoice(stripe.invoice()),
      ]);
      const committed = await readUsagePackState(
        fixture.orgId,
        preview.migrationId,
      );
      expect(committed.allocations).toHaveLength(2);
      expect(committed.invitationPurchases).toHaveLength(1);
      expect(committed.invitationPurchases[0]).toMatchObject({
        status: "invitation_pending",
        amountPaidCents: amountPaidCents === 0 ? 0 : 2000,
      });
      expect(committed.fulfillmentInvoiceIds).toHaveLength(1);
      expect(committed.grants).toHaveLength(2);
      await postMigrationInvoice(stripe.invoice());
      const replayed = await readUsagePackState(
        fixture.orgId,
        preview.migrationId,
      );
      expect(replayed).toStrictEqual(committed);
    },
  );

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
      undefined,
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

  async function purchaseManagedUsagePack(
    allocations: readonly {
      readonly userId: string;
      readonly usagePackUsd: 20 | 50 | 100 | 200;
    }[],
    tier: ManagedUsagePackFixture["tier"] = "pro",
    actor?: BillingOrgFixture,
  ): Promise<ManagedUsagePackFixture> {
    const firstMember = allocations[0];
    if (!firstMember) {
      throw new Error("A managed usage pack purchase requires a paid member");
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
            publicUserData: { userId, identifier: `${userId}@example.test` },
            createdAt: now(),
          };
        }),
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    const customerId = `cus_${randomUUID()}`;
    const subscriptionId = `sub_${randomUUID()}`;
    const checkoutSessionId = `cs_${randomUUID()}`;
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
      id: checkoutSessionId,
      url: `https://checkout.stripe.test/${checkoutSessionId}`,
    });
    const appOrigin = new URL(env("APP_URL")).origin;
    const checkout = await accept(
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
    expect(checkout.body).toStrictEqual({
      url: `https://checkout.stripe.test/${checkoutSessionId}`,
    });
    const metadata = stripeInputMetadata(
      context.mocks.stripe.checkout.sessions.create.mock.calls.at(-1)?.[0],
    );
    const usagePackSubscriptionId = metadata.usagePackSubscriptionId;
    if (!usagePackSubscriptionId) {
      throw new Error("Checkout did not identify its usage pack subscription");
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
    // Cleanup only removes this test's unique resources. The purchase and
    // activation above and below enter through production routes.
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: fixture.orgId,
        usagePackSubscriptionId,
        deleteGrants: true,
        deleteOrgMetadata: true,
      });
    });
    const quantities = new Map<string, number>();
    for (const allocation of allocations) {
      const priceId = priceIdForManagedUsagePack(allocation.usagePackUsd);
      quantities.set(priceId, (quantities.get(priceId) ?? 0) + 1);
    }
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: customerId,
        metadata: managedUsagePackMetadata(managedFixture),
        subscription_data: {
          metadata: managedUsagePackMetadata(managedFixture),
        },
        line_items: [
          { price: managedUsagePackPlanPriceId(tier), quantity: 1 },
          ...[...quantities].map(([price, quantity]) => {
            return { price, quantity };
          }),
        ],
      }),
      { idempotencyKey: `usage-pack-checkout:${usagePackSubscriptionId}` },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(managedFixture, quantities),
    );
    await postManagedUsagePackEvent(
      "invoice.paid",
      managedUsagePackInvoice(managedFixture, {
        invoiceId: `in_${randomUUID()}`,
        quantities,
      }),
    );
    expect((await readBillingStatus(fixture)).tier).toBe(tier);
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
    return managedFixture;
  }

  async function readManagedUsagePacks(fixture: BillingOrgFixture) {
    authenticateOrg(fixture);
    const response = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackManagementContract,
      ).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    return response.body;
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
    // The shared staff organization may still hold another test's live
    // subscription binding, which would make this first purchase a duplicate.
    await usagePackStateAction({
      action: "cleanup",
      orgId: fixture.orgId,
      usagePackSubscriptionId: randomUUID(),
      deleteGrants: false,
      deleteOrgMetadata: true,
    });
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
    context.mocks.stripe.invoices.createPreview.mockImplementation((input) => {
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
    createManagedSubscription = seedManagedUsagePack,
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
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    return { fixture, existingMemberUserId, email };
  }

  async function beginInvitationPurchase(
    actor = createOrgFixture(TEST_STAFF_ORG_ID),
    createManagedSubscription = seedManagedUsagePack,
  ): Promise<InvitationPurchaseFixture> {
    const { fixture, existingMemberUserId, email } =
      await setupInvitationPreviewContext(
        "invitee",
        actor,
        createManagedSubscription,
      );
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
    const actor = createOrgFixture();
    const fixture = await purchaseManagedUsagePack(
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
    // Only the exact fulfillment invoice exclusion remains a key21 ledger exception.
    // Approved scope: https://github.com/okou-ai/okou/issues/37440#issuecomment-5979740695
    const usagePackState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(usagePackState.fulfillmentInvoiceIds).not.toContain(invoiceId);
  });

  it("idempotently processes usage pack and concurrency from one renewal invoice", async () => {
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

    // Only the exact renewal ledger, allocation period and replayed grants remain key21 exceptions.
    // Approved scope: https://github.com/okou-ai/okou/issues/37440#issuecomment-5979740695
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

  it("deactivates usage packs when a shared subscription becomes Custom-only", async () => {
    const actor = createOrgFixture();
    const fixture = await purchaseManagedUsagePack(
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

    // Only the canceled subscription and retained inactive allocations remain key21 history exceptions.
    // Approved scope: https://github.com/okou-ai/okou/issues/37440#issuecomment-5979740695
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
    const fixture = await purchaseManagedUsagePack([
      { userId, usagePackUsd: 20 },
    ]);
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

  it("previews an immediate usage pack upgrade while the Plan is ending", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack(
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
    const fixture = await purchaseManagedUsagePack(
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
    expect((await readBillingStatus(fixture)).cancelAtPeriodEnd).toBeTruthy();
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.allocations).toStrictEqual([
      expect.objectContaining({ memberId: userId, usagePackUsd: 20 }),
    ]);
  });

  it("rejects a deferred usage pack change when the Plan cancellation webhook arrives during preview", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack(
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
    const fixture = await purchaseManagedUsagePack(
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
    // The invitation endpoint reads this subscription's cancellation flag
    // before contacting Stripe or creating any invitation.
    const retrievals =
      context.mocks.stripe.subscriptions.retrieve.mock.calls.length;
    const previews =
      context.mocks.stripe.invoices.createPreview.mock.calls.length;
    const updates = context.mocks.stripe.subscriptions.update.mock.calls.length;
    const invitations =
      context.mocks.clerk.organizations.createOrganizationInvitation.mock.calls
        .length;
    const invitation = await accept(
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
    expect(invitation.body.error).toStrictEqual({
      code: "INVITATION_PURCHASE_SUBSCRIPTION_CANCELING",
      message: "Restore your subscription before purchasing a member package.",
    });
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledTimes(
      retrievals,
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledTimes(
      previews,
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(
      updates,
    );
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledTimes(invitations);
  });

  it("asks to restore the Plan before scheduling a usage pack downgrade", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack(
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
    const fixture = await purchaseManagedUsagePack(
      [{ userId, usagePackUsd: 50 }],
      "team",
    );
    const activeSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockClear();
    context.mocks.stripe.invoices.createPreview.mockClear();
    const endingSubscription = {
      ...activeSubscription,
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
    // Restore only the external Stripe response. A persisted local
    // cancellation would still reject before reaching the quote provider.
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      activeSubscription,
    );
    mockUsagePackChangePreviews(0, 2000);
    const activePreview = await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: userId, targetUsagePackUsd: 20 },
      }),
      [200],
    );
    expect(activePreview.body).toMatchObject({
      kind: "downgrade",
      sourceUsagePackUsd: 50,
      targetUsagePackUsd: 20,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 2000,
      currency: "usd",
      effectiveAt: new Date(fixture.billingPeriod.end * 1000).toISOString(),
    });
  });

  it("rejects an allocation downgrade when the Plan starts ending after preview", async () => {
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
    // Only the exact failed downgrade row remains a key21 history exception.
    // Approved scope: https://github.com/okou-ai/okou/issues/37440#issuecomment-5979740695
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
    // Only the exact failed grouped downgrade row remains a key21 history exception.
    // Approved scope: https://github.com/okou-ai/okou/issues/37440#issuecomment-5979740695
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
    const fixture = await purchaseManagedUsagePack([
      { userId, usagePackUsd: 20 },
    ]);
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
    const userId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack([
      { userId, usagePackUsd: 20 },
    ]);
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
    const fixture = await purchaseManagedUsagePack([
      { userId, usagePackUsd: 20 },
    ]);
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
    await Promise.all([
      postManagedUsagePackEvent("invoice.paid", paidInvoice),
      postManagedUsagePackEvent("invoice.paid", paidInvoice),
    ]);
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);

    const completedState = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(completedState.org?.tier).toBe("team");
    expect(completedState.allocations).toHaveLength(1);
    expect(completedState.grants).toStrictEqual(grantsBefore);
    expect(
      completedState.fulfillmentInvoiceIds.filter((id) => {
        return id === paidInvoice.id;
      }),
    ).toHaveLength(1);
  });

  it("retries a grouped subscription change after a Stripe failure", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack([
      { userId, usagePackUsd: 20 },
    ]);
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
    expect((await readManagedUsagePacks(fixture)).allocations).toStrictEqual([
      expect.objectContaining({
        memberId: userId,
        usagePackUsd: 20,
        pendingChange: expect.objectContaining({
          kind: "upgrade",
          status: "applying",
          targetUsagePackUsd: 50,
        }),
      }),
    ]);

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

  it("rejects adding a user who is not an active organization member", async () => {
    const orgFixture = createOrgFixture();
    const unknownUserId = `user_${randomUUID()}`;
    await purchaseManagedUsagePack(
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

  it("restores a scheduled package downgrade with billing-only phase metadata", async () => {
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
    const fixture = await purchaseManagedUsagePack([
      { userId, usagePackUsd: 50 },
    ]);
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

  async function checkoutTwoMemberScheduleFixture(
    otherUserId: string,
    otherUsagePackUsd: 20 | 50,
  ): Promise<ManagedUsagePackFixture> {
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
          {
            role: "org:member",
            publicUserData: { userId: otherUserId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: checkoutSessionId,
      url: `https://checkout.stripe.test/${checkoutSessionId}`,
    });
    await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          ...usagePackCheckoutBody(actor.userId),
          memberUsagePacks: [
            { memberId: actor.userId, usagePackUsd: 50 },
            { memberId: otherUserId, usagePackUsd: otherUsagePackUsd },
          ],
        },
      }),
      [200],
    );
    const usagePackSubscriptionId = stripeInputMetadata(
      context.mocks.stripe.checkout.sessions.create.mock.calls.at(-1)?.[0],
    ).usagePackSubscriptionId;
    if (!usagePackSubscriptionId) {
      throw new Error("Checkout did not identify its usage pack subscription");
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
      tier: "pro",
    };
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: actor.orgId,
        usagePackSubscriptionId,
        deleteGrants: true,
        deleteOrgMetadata: true,
      });
    });
    const quantities = new Map<string, number>([[TEST_PRICE_USAGE_PACK_50, 1]]);
    const otherPriceId = priceIdForManagedUsagePack(otherUsagePackUsd);
    quantities.set(otherPriceId, (quantities.get(otherPriceId) ?? 0) + 1);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(fixture, quantities),
    );
    await postManagedUsagePackEvent(
      "invoice.paid",
      managedUsagePackInvoice(fixture, {
        invoiceId: `in_${randomUUID()}`,
        quantities,
      }),
    );
    const management = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackManagementContract,
      ).get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: actor.userId,
          usagePackUsd: 50,
          pendingChange: null,
        }),
        expect.objectContaining({
          memberId: otherUserId,
          usagePackUsd: otherUsagePackUsd,
          pendingChange: null,
        }),
      ]),
    );
    return fixture;
  }

  async function scheduleTestMemberCredits() {
    const credits = await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    if (!credits.body.memberCredits) {
      throw new Error("Admin credit response has no member balances");
    }
    return credits.body.memberCredits;
  }

  it("keeps a package downgrade scheduled while another member upgrades", async () => {
    const upgradedUserId = `user_${randomUUID()}`;
    const fixture = await checkoutTwoMemberScheduleFixture(upgradedUserId, 20);
    const downgradedUserId = fixture.userId;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const sourceSubscription = managedUsagePackSubscription(
      fixture,
      new Map([
        [TEST_PRICE_USAGE_PACK_50, 1],
        [TEST_PRICE_USAGE_PACK_20, 1],
      ]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      sourceSubscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 4000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_20,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const downgradePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: downgradedUserId, usagePackUsd: 20 },
            { memberId: upgradedUserId, usagePackUsd: 20 },
          ],
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

    const scheduledSubscription = {
      ...sourceSubscription,
      schedule: scheduleId,
    };
    const futureEnd = fixture.billingPeriod.end + 30 * 86_400;
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
            { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
          ],
        },
        {
          start_date: fixture.billingPeriod.end,
          end_date: futureEnd,
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_20, quantity: 2 },
          ],
        },
      ],
    });
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 7000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
    });
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: downgradedUserId, usagePackUsd: 20 },
            { memberId: upgradedUserId, usagePackUsd: 50 },
          ],
        },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual(
      expect.objectContaining({
        immediateAmountCents: 1500,
        nextRecurringAmountCents: 7000,
      }),
    );
    const beforeCredits = await scheduleTestMemberCredits();
    const upgradedCreditsBefore = beforeCredits.find((member) => {
      return member.memberId === upgradedUserId;
    })?.totalCredits;
    if (upgradedCreditsBefore === undefined) {
      throw new Error("Upgrading member has no initial credits");
    }
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const paidInvoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
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
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );
    expect(confirmed.body.status).toBe("pending_payment");
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    const beforePayment = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(beforePayment.body.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: downgradedUserId,
          usagePackUsd: 50,
          pendingChange: expect.objectContaining({
            status: "scheduled",
            targetUsagePackUsd: 20,
          }),
        }),
      ]),
    );

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_50, 2]]),
        fixture.billingPeriod,
        { scheduleId },
      ),
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
              { price: TEST_PRICE_USAGE_PACK_50, quantity: 2 },
            ]),
          }),
          expect.objectContaining({
            start_date: fixture.billingPeriod.end,
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
            ]),
          }),
        ],
      }),
      expect.objectContaining({
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:schedule-update`,
      }),
    );
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: downgradedUserId,
          usagePackUsd: 50,
          pendingChange: expect.objectContaining({
            status: "scheduled",
            targetUsagePackUsd: 20,
          }),
        }),
        expect.objectContaining({
          memberId: upgradedUserId,
          usagePackUsd: 50,
          pendingChange: null,
        }),
      ]),
    );
    const upgradedCreditsAfter = (await scheduleTestMemberCredits()).find(
      (member) => {
        return member.memberId === upgradedUserId;
      },
    )?.totalCredits;
    expect(upgradedCreditsAfter).toBeGreaterThan(upgradedCreditsBefore);
  });

  it("cancels an old package downgrade when that member upgrades immediately", async () => {
    const otherUserId = `user_${randomUUID()}`;
    const fixture = await checkoutTwoMemberScheduleFixture(otherUserId, 50);
    const userId = fixture.userId;
    const scheduleId = `sub_sched_${randomUUID()}`;
    const sourceSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 2]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      sourceSubscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 0,
      nextRecurringAmountCents: 7000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_20,
    });
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const downgradePreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: userId, usagePackUsd: 20 },
            { memberId: otherUserId, usagePackUsd: 50 },
          ],
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
    const scheduledManagement = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(scheduledManagement.body.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: userId,
          usagePackUsd: 50,
          pendingChange: expect.objectContaining({
            status: "scheduled",
            targetUsagePackUsd: 20,
          }),
        }),
      ]),
    );
    const scheduledSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_50, 2]]),
      fixture.billingPeriod,
      { scheduleId },
    );
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
            { price: TEST_PRICE_USAGE_PACK_50, quantity: 2 },
          ],
        },
        {
          start_date: fixture.billingPeriod.end,
          end_date: fixture.billingPeriod.end + 30 * 86_400,
          items: [
            { price: TEST_PRICE_USAGE_PACK_PLAN_PRO, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
            { price: TEST_PRICE_USAGE_PACK_20, quantity: 1 },
          ],
        },
      ],
    });
    mockUsagePackSubscriptionPackagePreviews({
      immediateAmountCents: 4998,
      nextRecurringAmountCents: 15_000,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_100,
    });
    const preview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: userId, usagePackUsd: 100 },
            { memberId: otherUserId, usagePackUsd: 50 },
          ],
        },
      }),
      [200],
    );
    expect(preview.body.immediateAmountCents).toBe(4998);
    const beforeCredits = await scheduleTestMemberCredits();
    const ownerCreditsBefore = beforeCredits.find((member) => {
      return member.memberId === userId;
    })?.totalCredits;
    const otherCreditsBefore = beforeCredits.find((member) => {
      return member.memberId === otherUserId;
    })?.totalCredits;
    if (ownerCreditsBefore === undefined || otherCreditsBefore === undefined) {
      throw new Error("Checkout members have no initial credits");
    }
    const prorationTimestamp = Math.floor(
      new Date(preview.body.prorationDate).getTime() / 1000,
    );
    const upgradeInvoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: `in_${randomUUID()}`,
      sourcePriceId: TEST_PRICE_USAGE_PACK_50,
      targetPriceId: TEST_PRICE_USAGE_PACK_100,
      prorationTimestamp,
    });
    const [oldPriceLine, newPriceLine] = upgradeInvoice.lines.data;
    if (!oldPriceLine || !newPriceLine) {
      throw new Error("Expected upgrade proration lines");
    }
    // Stripe reprices the full old quantity, including the member who keeps
    // the $50 pack: +$99.98 for $100, +$49.99 for $50, -$99.99 for 2 × $50.
    const paidInvoice = {
      ...upgradeInvoice,
      amount_paid: 4998,
      lines: {
        has_more: false,
        data: [
          { ...newPriceLine, amount: 9998, subtotal: 9998 },
          {
            ...oldPriceLine,
            id: `il_${randomUUID()}`,
            amount: 4999,
            subtotal: 4999,
          },
          { ...oldPriceLine, amount: -9999, subtotal: -9999, quantity: 2 },
        ],
      },
    };
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...scheduledSubscription,
      pending_update: { expires_at: prorationTimestamp + 300 },
      latest_invoice: { ...paidInvoice, status: "open" },
    });
    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([
          [TEST_PRICE_USAGE_PACK_100, 1],
          [TEST_PRICE_USAGE_PACK_50, 1],
        ]),
        fixture.billingPeriod,
        { scheduleId },
      ),
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
              { price: TEST_PRICE_USAGE_PACK_100, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
            ]),
          }),
          expect.objectContaining({
            start_date: fixture.billingPeriod.end,
            items: expect.arrayContaining([
              { price: TEST_PRICE_USAGE_PACK_100, quantity: 1 },
              { price: TEST_PRICE_USAGE_PACK_50, quantity: 1 },
            ]),
          }),
        ],
      }),
      expect.objectContaining({
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:schedule-update`,
      }),
    );
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.allocations).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: userId,
          usagePackUsd: 100,
          pendingChange: null,
        }),
        expect.objectContaining({
          memberId: otherUserId,
          usagePackUsd: 50,
          pendingChange: null,
        }),
      ]),
    );
    const afterCredits = await scheduleTestMemberCredits();
    expect(
      afterCredits.find((member) => {
        return member.memberId === userId;
      })?.totalCredits,
    ).toBeGreaterThan(ownerCreditsBefore);
    expect(
      afterCredits.find((member) => {
        return member.memberId === otherUserId;
      })?.totalCredits,
    ).toBe(otherCreditsBefore);
  });

  it("replaces a scheduled package downgrade on the existing schedule", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack([
      { userId, usagePackUsd: 200 },
    ]);
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

  async function readDeferredReplayCredits(fixture: BillingOrgFixture) {
    authenticateOrg(fixture);
    const response = await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    return response.body;
  }

  async function purchaseDeferredReplaySubscription(): Promise<ManagedUsagePackFixture> {
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
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: checkoutSessionId,
      url: `https://checkout.stripe.test/${checkoutSessionId}`,
    });
    await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        headers: { authorization: "Bearer clerk-session" },
        body: { ...usagePackCheckoutBody(actor.userId), tier: "team" },
      }),
      [200],
    );
    const metadata = stripeInputMetadata(
      context.mocks.stripe.checkout.sessions.create.mock.calls.at(-1)?.[0],
    );
    const usagePackSubscriptionId = metadata.usagePackSubscriptionId;
    if (!usagePackSubscriptionId) {
      throw new Error("Checkout did not identify its usage pack subscription");
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
    onTestFinished(async () => {
      await usagePackStateAction({
        action: "cleanup",
        orgId: actor.orgId,
        usagePackSubscriptionId,
        deleteGrants: true,
        deleteOrgMetadata: true,
      });
    });
    const quantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(fixture, quantities),
    );
    await postManagedUsagePackEvent(
      "invoice.paid",
      managedUsagePackInvoice(fixture, {
        invoiceId: `in_${randomUUID()}`,
        quantities,
      }),
    );
    expect((await readBillingStatus(fixture)).tier).toBe("team");
    await expect(readDeferredReplayCredits(fixture)).resolves.toMatchObject({
      hasUsagePack: true,
      purchasedCredits: 20_000,
      bonusCredits: 400,
      totalCredits: 20_400,
    });
    return fixture;
  }

  async function prepareDeferredInvoiceReplay(
    at = "2035-01-17T00:00:00.000Z",
    nextPhaseEnd = "2035-03-01T00:00:00.000Z",
  ) {
    mockNow(new Date(at));
    onTestFinished(() => {
      return clearMockNow();
    });
    const fixture = await purchaseDeferredReplaySubscription();
    const userId = fixture.userId;
    const source = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(source);
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
    await accept(
      client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );
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
        { price: TEST_PRICE_USAGE_PACK_PLAN_TEAM, quantity: 1, metadata: {} },
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
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue(
      initialSchedule,
    );
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      initialSchedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue(
      scheduled,
    );
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
  }

  it("does not update a completed deferred schedule when the invoice replays", async () => {
    const replay = await prepareDeferredInvoiceReplay();
    await postManagedUsagePackEvent("invoice.paid", replay.invoice);
    const before = await readDeferredReplayCredits(replay.fixture);
    const current = { ...replay.subscription, schedule: replay.scheduleId };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(current);
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [current],
      has_more: false,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      replay.scheduled,
    );

    await postManagedUsagePackEvent("invoice.paid", replay.invoice);

    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledOnce();
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledOnce();
    expect(
      (await readDeferredReplayCredits(replay.fixture)).creditGrants,
    ).toStrictEqual(before.creditGrants);
    const confirmation = await accept(
      replay.client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: replay.preview.body.changeId },
      }),
      [200],
    );
    expect(confirmation.body.status).toBe("scheduled");
  });

  it.each([
    ["2035-01-17T00:00:00.000Z", "2035-03-01T00:00:00.000Z"],
    ["2035-01-16T00:00:00.000Z", "2035-02-28T00:00:00.000Z"],
  ])(
    "completes local deferred schedule state after a lost Stripe response at %s",
    async (at, nextPhaseEnd) => {
      const replay = await prepareDeferredInvoiceReplay(at, nextPhaseEnd);
      context.mocks.stripe.subscriptionSchedules.update.mockRejectedValueOnce(
        new Error("Stripe response lost after applying the schedule"),
      );
      await expect(
        postManagedUsagePackEvent("invoice.paid", replay.invoice),
      ).rejects.toThrow(
        "Unknown response status 500 for POST /api/webhooks/stripe",
      );
      const before = await readDeferredReplayCredits(replay.fixture);
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        ...replay.subscription,
        schedule: replay.scheduleId,
      });
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
        replay.scheduled,
      );

      await postManagedUsagePackEvent("invoice.paid", replay.invoice);

      expect(
        context.mocks.stripe.subscriptionSchedules.update,
      ).toHaveBeenCalledOnce();
      expect(
        (await readDeferredReplayCredits(replay.fixture)).creditGrants,
      ).toStrictEqual(before.creditGrants);
      const confirmation = await accept(
        replay.client.confirmSubscriptionChange({
          headers: { authorization: "Bearer clerk-session" },
          body: { changeId: replay.preview.body.changeId },
        }),
        [200],
      );
      expect(confirmation.body.status).toBe("scheduled");
    },
  );

  it("reuses the original deferred schedule parameters after a failed first update", async () => {
    const replay = await prepareDeferredInvoiceReplay();
    context.mocks.stripe.subscriptionSchedules.update.mockRejectedValueOnce(
      new Error("Stripe update unavailable"),
    );
    await expect(
      postManagedUsagePackEvent("invoice.paid", replay.invoice),
    ).rejects.toThrow(
      "Unknown response status 500 for POST /api/webhooks/stripe",
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...replay.subscription,
      schedule: replay.scheduleId,
    });
    // Stripe's read model adds currency/metadata and absolute end dates. A retry
    // must retain the original duration-based write, including the array order.
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      replay.initialSchedule,
    );

    await postManagedUsagePackEvent("invoice.paid", replay.invoice);

    const requests =
      context.mocks.stripe.subscriptionSchedules.update.mock.calls;
    expect(requests).toHaveLength(2);
    expect(requests[1]).toStrictEqual(requests[0]);
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledOnce();
    const confirmation = await accept(
      replay.client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: replay.preview.body.changeId },
      }),
      [200],
    );
    expect(confirmation.body.status).toBe("scheduled");
  });

  it("shares a deferred schedule request across concurrent invoice deliveries", async () => {
    const replay = await prepareDeferredInvoiceReplay();
    const firstUpdateStarted = createDeferredPromise<void>(context.signal);
    const bothUpdatesStarted = createDeferredPromise<void>(context.signal);
    let updates = 0;
    context.mocks.stripe.subscriptionSchedules.update.mockImplementation(
      async () => {
        updates += 1;
        if (updates === 1) {
          context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
            ...replay.subscription,
            schedule: replay.scheduleId,
          });
          firstUpdateStarted.resolve();
        } else {
          bothUpdatesStarted.resolve();
        }
        await bothUpdatesStarted.promise;
        return replay.scheduled;
      },
    );
    const first = postManagedUsagePackEvent("invoice.paid", replay.invoice);
    await firstUpdateStarted.promise;
    const second = postManagedUsagePackEvent("invoice.paid", replay.invoice);
    await Promise.all([first, second]);

    const requests =
      context.mocks.stripe.subscriptionSchedules.update.mock.calls;
    expect(requests).toHaveLength(2);
    expect(requests[1]).toStrictEqual(requests[0]);
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledOnce();
    const credits = await readDeferredReplayCredits(replay.fixture);
    expect(credits).toMatchObject({
      hasUsagePack: true,
      purchasedCredits: 35_000,
      bonusCredits: 1500,
      totalCredits: 36_500,
    });
    expect(credits.creditGrants).toHaveLength(4);
    const confirmation = await accept(
      replay.client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: replay.preview.body.changeId },
      }),
      [200],
    );
    expect(confirmation.body.status).toBe("scheduled");
  });

  it("does not treat an unfulfilled invoice as a deferred schedule replay", async () => {
    const replay = await prepareDeferredInvoiceReplay();
    context.mocks.stripe.subscriptionSchedules.update.mockRejectedValueOnce(
      new Error("Stripe response lost after applying the schedule"),
    );
    await expect(
      postManagedUsagePackEvent("invoice.paid", replay.invoice),
    ).rejects.toThrow(
      "Unknown response status 500 for POST /api/webhooks/stripe",
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...replay.subscription,
      schedule: replay.scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      replay.scheduled,
    );
    context.mocks.stripe.invoices.retrieve.mockResolvedValue(replay.invoice);
    const unrelatedInvoice = { ...replay.invoice, id: `in_${randomUUID()}` };
    const creditsBeforeUnrelatedInvoice = await readDeferredReplayCredits(
      replay.fixture,
    );

    await expect(
      postManagedUsagePackEvent("invoice.paid", unrelatedInvoice),
    ).rejects.toThrow(
      "Unknown response status 500 for POST /api/webhooks/stripe",
    );

    const confirmation = await accept(
      replay.client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: replay.preview.body.changeId },
      }),
      [200],
    );
    expect(confirmation.body.status).toBe("processing");
    await expect(
      readDeferredReplayCredits(replay.fixture),
    ).resolves.toStrictEqual(creditsBeforeUnrelatedInvoice);
    await postManagedUsagePackEvent("invoice.paid", replay.invoice);
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledOnce();
  });

  it("does not move an unapplied deferred schedule into a later billing period", async () => {
    const replay = await prepareDeferredInvoiceReplay();
    context.mocks.stripe.subscriptionSchedules.update.mockRejectedValueOnce(
      new Error("Stripe update unavailable"),
    );
    await expect(
      postManagedUsagePackEvent("invoice.paid", replay.invoice),
    ).rejects.toThrow(
      "Unknown response status 500 for POST /api/webhooks/stripe",
    );
    mockNow(new Date("2035-02-02T00:00:00.000Z"));
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...replay.subscription,
      schedule: replay.scheduleId,
    });

    await expect(
      postManagedUsagePackEvent("invoice.paid", replay.invoice),
    ).rejects.toThrow(
      "Unknown response status 500 for POST /api/webhooks/stripe",
    );

    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledOnce();
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledOnce();
  });

  it("recovers an applied deferred schedule after its next phase has started", async () => {
    const replay = await prepareDeferredInvoiceReplay();
    context.mocks.stripe.subscriptionSchedules.update.mockRejectedValueOnce(
      new Error("Stripe response lost after applying the schedule"),
    );
    await expect(
      postManagedUsagePackEvent("invoice.paid", replay.invoice),
    ).rejects.toThrow(
      "Unknown response status 500 for POST /api/webhooks/stripe",
    );
    mockNow(new Date("2035-02-02T00:00:00.000Z"));
    const before = await readDeferredReplayCredits(replay.fixture);
    const renewed = managedUsagePackSubscription(
      { ...replay.fixture, tier: "pro" },
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      {
        start: replay.fixture.billingPeriod.end,
        end: Math.floor(new Date("2035-03-01T00:00:00.000Z").getTime() / 1000),
      },
      { latestInvoice: replay.invoice, scheduleId: replay.scheduleId },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(renewed);
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      ...replay.scheduled,
      current_phase: replay.scheduled.phases[1],
    });

    await postManagedUsagePackEvent("invoice.paid", replay.invoice);

    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledOnce();
    expect((await readBillingStatus(replay.fixture)).tier).toBe("pro");
    await expect(
      readDeferredReplayCredits(replay.fixture),
    ).resolves.toStrictEqual(before);
    const confirmation = await accept(
      replay.client.confirmSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { changeId: replay.preview.body.changeId },
      }),
      [200],
    );
    expect(confirmation.body).toMatchObject({
      status: "scheduled",
      effectiveAt: new Date(
        replay.fixture.billingPeriod.end * 1000,
      ).toISOString(),
    });
  });

  it("preserves the renewed plan when a completed deferred schedule invoice replays", async () => {
    const replay = await prepareDeferredInvoiceReplay();
    await postManagedUsagePackEvent("invoice.paid", replay.invoice);
    mockNow(new Date("2035-02-02T00:00:00.000Z"));
    const before = await readDeferredReplayCredits(replay.fixture);
    const renewed = managedUsagePackSubscription(
      { ...replay.fixture, tier: "pro" },
      new Map([[TEST_PRICE_USAGE_PACK_50, 1]]),
      {
        start: replay.fixture.billingPeriod.end,
        end: Math.floor(new Date("2035-03-01T00:00:00.000Z").getTime() / 1000),
      },
      { latestInvoice: replay.invoice, scheduleId: replay.scheduleId },
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(renewed);

    await postManagedUsagePackEvent("invoice.paid", replay.invoice);

    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledOnce();
    expect((await readBillingStatus(replay.fixture)).tier).toBe("pro");
    await expect(
      readDeferredReplayCredits(replay.fixture),
    ).resolves.toStrictEqual(before);
  });

  it("does not resurrect a restored deferred schedule when an old invoice is delivered", async () => {
    const replay = await prepareDeferredInvoiceReplay();
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: replay.fixture.customerId,
      invoice_settings: { default_payment_method: `pm_${randomUUID()}` },
    });
    await postManagedUsagePackEvent("invoice.paid", replay.invoice);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...replay.subscription,
      schedule: replay.scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      replay.scheduled,
    );
    await accept(
      setupApp({ context, routes: billingRestoreRoutes })(
        billingRestoreContract,
      ).create({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      replay.subscription,
    );

    await postManagedUsagePackEvent("invoice.paid", replay.invoice);

    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledOnce();
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledOnce();
    const status = await accept(
      setupApp({ context, routes: billingStatusRoutes })(
        billingStatusContract,
      ).get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.scheduledChange).toBeNull();
  });

  it("schedules a Team to Pro subscription change at the billing boundary", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack(
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
    expect((await readBillingStatus(fixture)).tier).toBe("team");
    expect((await readManagedUsagePacks(fixture)).allocations).toStrictEqual([
      expect.objectContaining({ memberId: userId, usagePackUsd: 20 }),
    ]);
  });

  it("merges a Team to Pro change into a scheduled concurrency reduction", async () => {
    const userId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack(
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

  it("rejects prepared package and Plan prices after cancellation changes during Stripe reads", async () => {
    const fixture = await purchaseDeferredReplaySubscription();
    const subscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    const canceled = { ...subscription, cancel_at_period_end: true };
    const packageStarted = createDeferredPromise<void>(context.signal);
    const planStarted = createDeferredPromise<void>(context.signal);
    const providerResponse = createDeferredPromise<typeof subscription>(
      context.signal,
    );
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValue(canceled)
      .mockImplementationOnce(() => {
        packageStarted.resolve();
        return providerResponse.promise;
      })
      .mockImplementationOnce(() => {
        planStarted.resolve();
        return providerResponse.promise;
      });
    mockUsagePackChangePreviews(1500, 5000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const packagePreview = client.previewChange({
      headers: { authorization: "Bearer clerk-session" },
      body: { memberId: fixture.userId, targetUsagePackUsd: 50 },
    });
    const planPreview = client.previewSubscriptionChange({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        targetTier: "team",
        memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 50 }],
      },
    });
    onTestFinished(async () => {
      if (!providerResponse.settled()) {
        providerResponse.resolve(subscription);
      }
      if (!packageStarted.settled()) {
        packageStarted.resolve();
      }
      if (!planStarted.settled()) {
        planStarted.resolve();
      }
      await Promise.allSettled([packagePreview, planPreview]);
    });
    await Promise.all([packageStarted.promise, planStarted.promise]);
    await postManagedUsagePackEvent("customer.subscription.updated", canceled);
    expect((await readBillingStatus(fixture)).cancelAtPeriodEnd).toBeTruthy();
    providerResponse.resolve(subscription);
    await Promise.all([
      accept(packagePreview, [409]),
      accept(planPreview, [409]),
    ]);
    const management = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(management.body.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: fixture.userId,
        usagePackUsd: 20,
        pendingChange: null,
      }),
    ]);
    await expect(readDeferredReplayCredits(fixture)).resolves.toMatchObject({
      purchasedCredits: 20_000,
      bonusCredits: 400,
      totalCredits: 20_400,
    });
    const refreshed = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "team",
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 50 }],
        },
      }),
      [200],
    );
    expect(refreshed.body).toMatchObject({
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 0,
    });
  });

  it("rejects a package preview when a Plan preview wins during Stripe preparation", async () => {
    const fixture = await purchaseDeferredReplaySubscription();
    const subscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
    );
    const packageStarted = createDeferredPromise<void>(context.signal);
    const packageResponse = createDeferredPromise<typeof subscription>(
      context.signal,
    );
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValue(subscription)
      .mockImplementationOnce(() => {
        packageStarted.resolve();
        return packageResponse.promise;
      });
    mockUsagePackChangePreviews(1500, 4000);
    const client = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const packagePreview = client.previewChange({
      headers: { authorization: "Bearer clerk-session" },
      body: { memberId: fixture.userId, targetUsagePackUsd: 50 },
    });
    onTestFinished(async () => {
      if (!packageResponse.settled()) {
        packageResponse.resolve(subscription);
      }
      if (!packageStarted.settled()) {
        packageStarted.resolve();
      }
      await Promise.allSettled([packagePreview]);
    });
    await packageStarted.promise;
    const planPreview = await accept(
      client.previewSubscriptionChange({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          targetTier: "pro",
          memberUsagePacks: [{ memberId: fixture.userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    expect(planPreview.body).toMatchObject({
      sourceTier: "team",
      targetTier: "pro",
    });
    packageResponse.resolve(subscription);
    await accept(packagePreview, [409]);
    // The winning real Plan intent still blocks a later standalone package change.
    await accept(
      client.previewChange({
        headers: { authorization: "Bearer clerk-session" },
        body: { memberId: fixture.userId, targetUsagePackUsd: 50 },
      }),
      [409],
    );
    const management = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(management.body).toMatchObject({
      tier: "team",
      allocations: [
        expect.objectContaining({
          memberId: fixture.userId,
          usagePackUsd: 20,
          pendingChange: null,
        }),
      ],
    });
    await expect(readDeferredReplayCredits(fixture)).resolves.toMatchObject({
      purchasedCredits: 20_000,
      bonusCredits: 400,
      totalCredits: 20_400,
    });
  });

  it("serializes concurrent package previews across an organization", async () => {
    const firstUserId = `user_${randomUUID()}`;
    const secondUserId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack([
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
    // Only the exact previewed change cardinality remains a key21 ledger exception.
    // Approved scope: https://github.com/okou-ai/okou/issues/37440#issuecomment-5979740695
    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(state.changes).toHaveLength(1);
    expect(state.changes[0]?.status).toBe("previewed");
  });

  it("repairs a stale Stripe package quantity before quoting a member change", async () => {
    mockNow(new Date("2035-01-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const sourceUserId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack([
      { userId: sourceUserId, usagePackUsd: 20 },
    ]);
    // A late writer left Stripe at two packages; local records declare one.
    let repaired = false;
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(() => {
      const quantity = repaired ? 1 : 2;
      return Promise.resolve(
        managedUsagePackSubscription(
          fixture,
          new Map([[TEST_PRICE_USAGE_PACK_20, quantity]]),
        ),
      );
    });
    context.mocks.stripe.subscriptions.update.mockImplementation(() => {
      repaired = true;
      return Promise.resolve({});
    });
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

    expect(preview.body.changeId).toStrictEqual(expect.any(String));
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.subscriptionId,
      {
        items: [{ id: `si_${TEST_PRICE_USAGE_PACK_20}`, quantity: 1 }],
        proration_behavior: "none",
      },
      undefined,
    );
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.pay).not.toHaveBeenCalled();
  });

  it("repairs stale Stripe quantities before confirming a paid upgrade", async () => {
    mockNow(new Date("2035-01-16T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
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

    // A late writer leaves Stripe at two packages after the quote.
    let repaired = false;
    const staleSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 2]]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(() => {
      const current = repaired ? oldSubscription : staleSubscription;
      return Promise.resolve(current);
    });
    const pendingInvoiceId = `in_${randomUUID()}`;
    context.mocks.stripe.subscriptions.update.mockImplementation(
      (_id: unknown, params: unknown) => {
        if (
          typeof params === "object" &&
          params !== null &&
          "proration_behavior" in params &&
          params.proration_behavior === "none"
        ) {
          repaired = true;
          return Promise.resolve(oldSubscription);
        }
        return Promise.resolve({
          ...oldSubscription,
          pending_update: { expires_at: prorationTimestamp + 300 },
          latest_invoice: {
            id: pendingInvoiceId,
            status: "open",
            hosted_invoice_url: `https://invoice.stripe.test/${pendingInvoiceId}`,
          },
        });
      },
    );

    const confirmed = await accept(
      client.confirmChange({
        params: { changeId: preview.body.changeId },
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    expect(confirmed.body.status).toBe("pending_payment");
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      1,
      fixture.subscriptionId,
      {
        items: [{ id: `si_${TEST_PRICE_USAGE_PACK_20}`, quantity: 1 }],
        proration_behavior: "none",
      },
      undefined,
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
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(2);
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
    const deliveries = await Promise.allSettled([
      postManagedUsagePackEvent("invoice.paid", paidInvoice),
      postManagedUsagePackEvent("invoice.paid", paidInvoice),
    ]);
    expect(deliveries).toStrictEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
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

  it("applies a paid upgrade once with the preview proration date across eight concurrent deliveries", async () => {
    const concurrentDeliveries = 8;
    mockNow(new Date("2035-01-16T00:00:00.000Z"));
    const actor = createOrgFixture();
    const sourceUserId = actor.userId;
    authenticateOrg(actor);
    mockClerkOrganization(actor);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: sourceUserId },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [] },
    );
    const customerId = `cus_${randomUUID()}`;
    const subscriptionId = `sub_${randomUUID()}`;
    const checkoutSessionId = `cs_${randomUUID()}`;
    context.mocks.stripe.customers.create.mockResolvedValueOnce({
      id: customerId,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValueOnce({
      id: checkoutSessionId,
      url: `https://checkout.stripe.test/${checkoutSessionId}`,
    });
    await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        headers: { authorization: "Bearer clerk-session" },
        body: { ...usagePackCheckoutBody(sourceUserId), tier: "pro" },
      }),
      [200],
    );
    const metadata = stripeInputMetadata(
      context.mocks.stripe.checkout.sessions.create.mock.calls.at(-1)?.[0],
    );
    if (!metadata.usagePackSubscriptionId) {
      throw new Error("Checkout did not identify its usage pack subscription");
    }
    const fixture: ManagedUsagePackFixture = {
      ...actor,
      customerId,
      subscriptionId,
      usagePackSubscriptionId: metadata.usagePackSubscriptionId,
      tier: "pro",
      billingPeriod: {
        start: currentSecond() - 15 * 86_400,
        end: currentSecond() + 15 * 86_400,
      },
    };
    const oldQuantities = new Map([[TEST_PRICE_USAGE_PACK_20, 1]]);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(fixture, oldQuantities),
    );
    await postManagedUsagePackEvent(
      "invoice.paid",
      managedUsagePackInvoice(fixture, {
        invoiceId: `in_${randomUUID()}`,
        quantities: oldQuantities,
      }),
    );
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
    const beforePayment = await readManagedUsagePacks(fixture);
    expect(beforePayment.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: sourceUserId,
        usagePackUsd: 20,
        pendingChange: expect.objectContaining({
          id: preview.body.changeId,
          status: "pending_payment",
        }),
      }),
    ]);
    const creditsBeforePayment = await readDeferredReplayCredits(fixture);
    expect(creditsBeforePayment).toMatchObject({
      purchasedCredits: 20_000,
      bonusCredits: 400,
      totalCredits: 20_400,
    });
    expect(creditsBeforePayment.creditGrants).toHaveLength(2);

    const paidInvoice = managedUsagePackUpgradeInvoice(fixture, {
      invoiceId: pendingInvoiceId,
      sourcePriceId: TEST_PRICE_USAGE_PACK_20,
      targetPriceId: TEST_PRICE_USAGE_PACK_50,
      prorationTimestamp,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(fixture, newQuantities),
    );
    // Drain every delivery before asserting, even if one returns an error.
    const deliveries = await Promise.allSettled(
      Array.from({ length: concurrentDeliveries }, () => {
        return postManagedUsagePackEvent("invoice.paid", paidInvoice);
      }),
    );
    expect(deliveries).toStrictEqual(
      Array.from({ length: concurrentDeliveries }, () => {
        return { status: "fulfilled", value: undefined };
      }),
    );
    const upgraded = await readManagedUsagePacks(fixture);
    expect(upgraded.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: sourceUserId,
        usagePackUsd: 50,
        pendingChange: null,
      }),
    ]);
    const credits = await readDeferredReplayCredits(fixture);
    expect(credits).toMatchObject({
      purchasedCredits: 35_000,
      bonusCredits: 1500,
      totalCredits: 36_500,
    });
    expect(credits.creditGrants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ grantType: "purchased", amount: 15_000 }),
        expect.objectContaining({ grantType: "bonus", amount: 1100 }),
      ]),
    );
    expect(credits.creditGrants).toHaveLength(4);

    await postManagedUsagePackEvent("invoice.paid", paidInvoice);
    await expect(readManagedUsagePacks(fixture)).resolves.toStrictEqual(
      upgraded,
    );
    await expect(readDeferredReplayCredits(fixture)).resolves.toStrictEqual(
      credits,
    );
  });

  async function confirmPendingUsagePackUpgrade() {
    const fixture = await seedManagedUsagePack([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
    ]);
    const sourceUserId =
      (await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId))
        .allocations[0]?.userId ?? "";
    const oldSubscription = managedUsagePackSubscription(
      fixture,
      new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
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
    context.mocks.stripe.creditNotes.create.mockResolvedValue({
      id: `cn_${randomUUID()}`,
      status: "issued",
    });
    return {
      fixture,
      changeId: preview.body.changeId,
      oldSubscription,
      canceledSubscription: { ...oldSubscription, status: "canceled" },
      paidInvoice,
    };
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

  it("settles a paid upgrade and its subscription deletion in exactly one order", async () => {
    mockNow(new Date("2035-01-17T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const { fixture, changeId, canceledSubscription, paidInvoice } =
      await confirmPendingUsagePackUpgrade();
    const grantsBefore = (
      await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId)
    ).grants;
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
    const settled = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(
      settled.changes.find((candidate) => {
        return candidate.id === changeId;
      })?.status,
    ).toBe("failed");
    expect(settled.grants).toStrictEqual(grantsBefore);
    expect(settled.fulfillmentInvoiceIds).not.toContain(paidInvoice.id);
    expectCanceledUpgradeRefund(changeId, paidInvoice.id);
  });

  it("refunds a paid upgrade invoice delivered after its subscription deletion", async () => {
    mockNow(new Date("2035-01-17T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const { fixture, changeId, canceledSubscription, paidInvoice } =
      await confirmPendingUsagePackUpgrade();
    const grantsBefore = (
      await readUsagePackState(fixture.orgId, fixture.usagePackSubscriptionId)
    ).grants;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      canceledSubscription,
    );

    await postManagedUsagePackEvent(
      "customer.subscription.deleted",
      canceledSubscription,
    );
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);

    const refunded = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(
      refunded.changes.find((candidate) => {
        return candidate.id === changeId;
      })?.status,
    ).toBe("failed");
    expect(refunded.grants).toStrictEqual(grantsBefore);
    expect(refunded.fulfillmentInvoiceIds).not.toContain(paidInvoice.id);
    expectCanceledUpgradeRefund(changeId, paidInvoice.id);
  });

  it("does not refund a redelivered paid invoice of a canceled upgrade twice", async () => {
    mockNow(new Date("2035-01-17T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const { fixture, changeId, canceledSubscription, paidInvoice } =
      await confirmPendingUsagePackUpgrade();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      canceledSubscription,
    );
    await postManagedUsagePackEvent(
      "customer.subscription.deleted",
      canceledSubscription,
    );
    await postManagedUsagePackEvent("invoice.paid", paidInvoice);
    const refunded = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );

    await postManagedUsagePackEvent("invoice.paid", paidInvoice);

    const redelivered = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(redelivered.grants).toStrictEqual(refunded.grants);
    expect(redelivered.changes).toStrictEqual(refunded.changes);
    expect(context.mocks.stripe.creditNotes.list).toHaveBeenCalledOnce();
    expectCanceledUpgradeRefund(changeId, paidInvoice.id);
  });

  it("fulfills a paid upgrade once without a refund before its subscription deletion", async () => {
    mockNow(new Date("2035-01-17T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const { fixture, changeId, canceledSubscription, paidInvoice } =
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

    const settled = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    expect(
      settled.changes.find((candidate) => {
        return candidate.id === changeId;
      })?.status,
    ).toBe("completed");
    expect(
      settled.grants.filter((grant) => {
        return grant.originalAmount === 15_000;
      }),
    ).toHaveLength(1);
    expect(
      settled.fulfillmentInvoiceIds.filter((id) => {
        return id === paidInvoice.id;
      }),
    ).toHaveLength(1);
    expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
  });

  it("completes an immediately paid upgrade during confirmation", async () => {
    mockNow(new Date("2035-01-20T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
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
    // The pre-confirmation configuration repair reads the unchanged Plan first.
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(oldSubscription)
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
    // The pre-confirmation configuration repair reads the unchanged Plan first.
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

  it.each([
    { sourceTier: "pro", targetTier: "pro" },
    { sourceTier: "pro", targetTier: "team" },
    { sourceTier: "team", targetTier: "pro" },
    { sourceTier: "team", targetTier: "team" },
  ] as const)(
    "rejects a $sourceTier-to-$targetTier subscription change without a paid usage pack",
    async ({ sourceTier, targetTier }) => {
      const actor = createOrgFixture();
      await purchaseManagedUsagePack(
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

  it.each([20, 0] as const)(
    "finalizes deferred target $%s once across concurrent subscription cancellation deliveries",
    async (targetUsagePackUsd) => {
      const userId = `user_${randomUUID()}`;
      const secondUserId = `user_${randomUUID()}`;
      const fixture = await seedManagedUsagePack([
        { userId, usagePackUsd: 50 },
        ...(targetUsagePackUsd === 0
          ? [{ userId: secondUserId, usagePackUsd: 20 as const }]
          : []),
      ]);
      const current = managedUsagePackSubscription(
        fixture,
        new Map([
          [TEST_PRICE_USAGE_PACK_50, 1],
          ...(targetUsagePackUsd === 0
            ? [[TEST_PRICE_USAGE_PACK_20, 1] as const]
            : []),
        ]),
      );
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(current);
      mockUsagePackChangePreviews(0, 2000);
      mockUsagePackSubscriptionChangePreviews(0, 1000);
      context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
        id: "sub_sched_cancel_deferred",
      });
      context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
        id: "sub_sched_cancel_deferred",
      });
      const client = setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackManagementContract,
      );
      const preview =
        targetUsagePackUsd === 0
          ? await accept(
              client.previewSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: {
                  targetTier: "pro",
                  memberUsagePacks: [
                    { memberId: userId, usagePackUsd: 0 },
                    { memberId: secondUserId, usagePackUsd: 20 },
                  ],
                },
              }),
              [200],
            )
          : await accept(
              client.previewChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { memberId: userId, targetUsagePackUsd },
              }),
              [200],
            );
      const confirmed =
        targetUsagePackUsd === 0
          ? await accept(
              client.confirmSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { changeId: preview.body.changeId },
              }),
              [200],
            )
          : await accept(
              client.confirmChange({
                params: { changeId: preview.body.changeId },
                headers: { authorization: "Bearer clerk-session" },
                body: {},
              }),
              [200],
            );
      expect(confirmed.body.status).toBe("scheduled");
      const before = await readUsagePackState(
        fixture.orgId,
        fixture.usagePackSubscriptionId,
      );
      const terminal = { ...current, status: "canceled" as const };
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(terminal);
      await Promise.all([
        postManagedUsagePackEvent("customer.subscription.updated", terminal),
        postManagedUsagePackEvent("customer.subscription.updated", terminal),
      ]);
      await postManagedUsagePackEvent(
        "customer.subscription.updated",
        terminal,
      );
      const after = await readUsagePackState(
        fixture.orgId,
        fixture.usagePackSubscriptionId,
      );
      expect(after.changes).toStrictEqual([
        expect.objectContaining({
          ...(targetUsagePackUsd === 20 ? { id: preview.body.changeId } : {}),
          kind: targetUsagePackUsd === 0 ? "removal" : "downgrade",
          status: targetUsagePackUsd === 0 ? "completed" : "failed",
          sourceUsagePackUsd: 50,
          targetUsagePackUsd: targetUsagePackUsd === 0 ? null : 20,
        }),
      ]);
      if (targetUsagePackUsd === 0) {
        expect(after.allocations).toContainEqual(
          expect.objectContaining({ userId, status: "inactive" }),
        );
      }
      expect(after.grants).toStrictEqual(before.grants);
      expect(after.refunds).toStrictEqual(before.refunds);
      expect(after.fulfillmentInvoiceIds).toStrictEqual(
        before.fulfillmentInvoiceIds,
      );
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

  it("exposes a pending deferred change when the Stripe schedule update fails", async () => {
    const initialNow = new Date("2035-04-01T00:00:00.000Z");
    mockNow(initialNow);
    onTestFinished(() => {
      clearMockNow();
    });
    const userId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack([
      { userId, usagePackUsd: 50 },
    ]);
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
    const applying = await readManagedUsagePacks(fixture);
    expect(applying.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: userId,
        usagePackUsd: 50,
        pendingChange: expect.objectContaining({
          id: preview.body.changeId,
          kind: "downgrade",
          status: "applying",
          targetUsagePackUsd: 20,
        }),
      }),
    ]);
  });

  it("keeps one open removal per member across concurrent removals of different members", async () => {
    mockNow(new Date("2035-04-17T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const adminUserId = `user_${randomUUID()}`;
    const firstUserId = `user_${randomUUID()}`;
    const secondUserId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack([
      { userId: adminUserId, usagePackUsd: 20 },
      { userId: firstUserId, usagePackUsd: 20 },
      { userId: secondUserId, usagePackUsd: 50 },
    ]);
    for (const userId of [firstUserId, secondUserId]) {
      for (const grantType of ["purchased", "bonus"] as const) {
        await usagePackStateAction({
          action: "set-grant-remaining",
          orgId: fixture.orgId,
          userId,
          grantType,
          remainingAmount: 0,
        });
      }
    }
    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");
    context.mocks.clerk.users.getUserList.mockImplementation((params) => {
      const requested = JSON.stringify(params);
      return Promise.resolve({
        data: [firstUserId, secondUserId]
          .filter((userId) => {
            return requested.includes(`${userId}@example.test`);
          })
          .map((id) => {
            return { id };
          }),
      });
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [adminUserId, firstUserId, secondUserId].map((userId) => {
          return { publicUserData: { userId } };
        }),
      },
    );
    context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValue(
      {},
    );
    const currentSubscription = managedUsagePackSubscription(
      fixture,
      new Map([
        [TEST_PRICE_USAGE_PACK_20, 2],
        [TEST_PRICE_USAGE_PACK_50, 1],
      ]),
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      currentSubscription,
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue(
      currentSubscription,
    );
    const client = setupApp({ context, routes: orgMembersRoutes })(
      orgMembersContract,
    );
    const remove = async (userId: string) => {
      return await accept(
        client.removeMember({
          headers: { authorization: "Bearer clerk-session" },
          body: { email: `${userId}@example.test` },
        }),
        [200],
      );
    };

    const results = await Promise.allSettled([
      remove(firstUserId),
      remove(secondUserId),
    ]);
    expect(
      results.some((result) => {
        return result.status === "fulfilled";
      }),
    ).toBeTruthy();
    // A member whose removal lost the organization's single open change
    // fails before any billing effect and succeeds once the winner settles.
    for (const [index, userId] of [firstUserId, secondUserId].entries()) {
      if (results[index]?.status === "rejected") {
        await remove(userId);
      }
    }

    const state = await readUsagePackState(
      fixture.orgId,
      fixture.usagePackSubscriptionId,
    );
    for (const userId of [firstUserId, secondUserId]) {
      expect(
        state.changes.filter((change) => {
          return (
            change.userId === userId &&
            change.kind === "removal" &&
            change.status !== "failed"
          );
        }),
      ).toHaveLength(1);
      expect(
        state.refunds.filter((refund) => {
          return refund.userId === userId && refund.status !== "available";
        }),
      ).toStrictEqual([]);
    }
    expect(
      state.allocations.filter((allocation) => {
        return allocation.userId === adminUserId;
      }),
    ).toStrictEqual([expect.objectContaining({ status: "active" })]);
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

  it("keeps suspended plans from inviting members", async () => {
    const fixture = await purchaseManagedUsagePack([
      { userId: `user_${randomUUID()}`, usagePackUsd: 20 },
    ]);
    const client = setupApp({ context, routes: orgInviteRoutes })(
      orgInviteContract,
    );

    for (const tier of ["pro"] as const) {
      await seedOrgMetadata({ orgId: fixture.orgId, tier, credits: 0 });
      await upsertOrgPlanEntitlementFixture({
        orgId: fixture.orgId,
        status: "suspended",
      });
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
    const fixture = await createPublicBillingOrg("pro");
    await fixture.run(async () => {
      expect(isStaffOrg(fixture.orgId)).toBeFalsy();
      authenticateOrg(fixture);

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
  });

  it("explains when an invitation purchase targets an existing member", async () => {
    const existingMemberUserId = `user_${randomUUID()}`;
    const existingMemberEmail = `existing-${randomUUID()}@example.test`;
    await purchaseManagedUsagePack([
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
    // A stale late write left Stripe at three packages; removal still converges
    // to the one package declared by the remaining local allocation.
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      managedUsagePackSubscription(
        fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 3]]),
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
    const fixture = await purchaseManagedUsagePack([
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

  it("uses one hosted invoice payment when an invitation buyer has no saved card", async () => {
    const existingMemberUserId = `user_${randomUUID()}`;
    const fixture = await purchaseManagedUsagePack([
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
        metadata: { ...metadata, purchaseCreatedAt: expect.any(String) },
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
    const fixture = await purchaseManagedUsagePack([
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
        metadata: { ...metadata, purchaseCreatedAt: expect.any(String) },
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
      ...paidInvoice,
      lines: {
        has_more: false,
        data: [
          {
            id: `il_invite_${randomUUID()}`,
            amount: 1000,
            subtotal: 1000,
            quantity: 1,
            price: null,
            period: {
              start: Math.floor(now() / 1000),
              end: fixture.billingPeriod.end,
            },
            parent: { type: "invoice_item_details" },
          },
        ],
      },
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
          getStartedClaimId: expect.any(String),
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
    const purchase = await beginInvitationPurchase(
      createOrgFixture(),
      purchaseManagedUsagePack,
    );
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
    const purchase = await beginInvitationPurchase(
      createOrgFixture(),
      purchaseManagedUsagePack,
    );
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
    await beginInvitationPurchase(createOrgFixture(), purchaseManagedUsagePack);
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
    const purchase = await beginInvitationPurchase(
      createOrgFixture(),
      purchaseManagedUsagePack,
    );
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
    const purchase = await beginInvitationPurchase(
      createOrgFixture(),
      purchaseManagedUsagePack,
    );
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
    const purchase = await beginInvitationPurchase(
      createOrgFixture(),
      purchaseManagedUsagePack,
    );

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

  async function createPendingCorrelatedInvitationInvoice(
    purchase: InvitationPurchaseFixture,
  ) {
    const paymentMethodId = `pm_invite_${randomUUID()}`;
    const invoice = {
      id: `in_invite_archive_${randomUUID()}`,
      customer: purchase.fixture.customerId,
      metadata: {
        purpose: "usage_pack_invitation_purchase",
        usagePackInvitationPurchaseId: purchase.purchaseId,
      },
      status: "open",
      paid: false,
      amount_due: 1000,
      currency: "usd",
      hosted_invoice_url:
        "https://invoice.stripe.test/pending-archive-invitation",
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...managedUsagePackSubscription(
        purchase.fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      ),
      default_payment_method: paymentMethodId,
    });
    context.mocks.stripe.invoices.create.mockResolvedValue({
      ...invoice,
      status: "draft",
    });
    context.mocks.stripe.invoiceItems.create.mockResolvedValue({
      id: `ii_invite_${randomUUID()}`,
    });
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue(invoice);
    context.mocks.stripe.invoices.pay.mockResolvedValue(invoice);
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
      hostedInvoiceUrl: invoice.hosted_invoice_url,
    });
    return invoice;
  }

  it.each(["invoice source", "parent purpose"])(
    "keeps a real pending invitation unpaid when replaying an archive-root concurrency invoice identified by %s",
    async (identity) => {
      const purchase = await beginInvitationPurchase(
        createOrgFixture(),
        purchaseManagedUsagePack,
      );
      const pendingInvoice =
        await createPendingCorrelatedInvitationInvoice(purchase);
      const before = await readBillingStatus(purchase.fixture);
      const packagesBefore = await readManagedUsagePacks(purchase.fixture);
      const ordinarySubscription = managedUsagePackSubscription(
        purchase.fixture,
        new Map([[TEST_PRICE_USAGE_PACK_20, 1]]),
      );
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        ...ordinarySubscription,
        items: {
          data: [
            ...ordinarySubscription.items.data,
            {
              id: `si_independent_concurrency_${randomUUID()}`,
              price: { id: TEST_PRICE_CONCURRENCY },
              quantity: 3,
              current_period_start: purchase.fixture.billingPeriod.start,
              current_period_end: purchase.fixture.billingPeriod.end,
            },
          ],
        },
      });
      const paidInvoice = {
        ...pendingInvoice,
        status: "paid",
        paid: true,
        amount_paid: 1000,
        status_transitions: { paid_at: Math.floor(now() / 1000) },
        metadata: {
          ...pendingInvoice.metadata,
          ...(identity === "invoice source"
            ? { source: "atom_usage_allowance" }
            : {}),
        },
        parent: {
          subscription_details: {
            subscription: purchase.fixture.subscriptionId,
            metadata:
              identity === "parent purpose"
                ? { purpose: "usage_allowance" }
                : {},
          },
        },
        payments: {
          data: [
            {
              status: "paid",
              amount_paid: 1000,
              payment: {
                type: "payment_intent",
                payment_intent: purchase.paymentIntentId,
              },
            },
          ],
        },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_archive_${randomUUID()}`,
              amount: 1000,
              price: { id: "price_retired_allowance" },
              period: purchase.fixture.billingPeriod,
              parent: { type: "subscription_item_details" },
            },
            {
              ...managedConcurrencyInvoiceLine({
                quantity: 3,
                billingPeriod: purchase.fixture.billingPeriod,
                proration: false,
              }),
              amount: 0,
              subtotal: 0,
            },
          ],
        },
      };
      context.mocks.stripe.invoices.retrieve.mockResolvedValue(paidInvoice);
      context.mocks.stripe.invoices.retrieve.mockClear();
      context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
        {
          id: `inv_correlated_${randomUUID()}`,
          emailAddress: purchase.email,
          organizationId: purchase.fixture.orgId,
          status: "pending",
        },
      );
      for (let replay = 0; replay < 2; replay++) {
        await postManagedUsagePackEvent("invoice.paid", paidInvoice);
      }
      expect(context.mocks.stripe.invoices.retrieve).not.toHaveBeenCalled();
      expect(
        context.mocks.clerk.organizations.createOrganizationInvitation,
      ).not.toHaveBeenCalled();
      const after = await readBillingStatus(purchase.fixture);
      expect(after.tier).toBe(before.tier);
      expect(after.credits).toBe(before.credits);
      expect(after.subscriptionStatus).toBe(before.subscriptionStatus);
      expect(after.concurrencySubscriptions).toStrictEqual([
        expect.objectContaining({
          id: purchase.fixture.subscriptionId,
          quantity: 3,
          currentPeriodEnd: new Date(
            purchase.fixture.billingPeriod.end * 1000,
          ).toISOString(),
        }),
      ]);
      await expect(
        readManagedUsagePacks(purchase.fixture),
      ).resolves.toStrictEqual(packagesBefore);

      // The original, ordinary payment still fulfills the same publicly created purchase.
      const ordinaryPaidInvoice = {
        ...paidInvoice,
        metadata: pendingInvoice.metadata,
        parent: null,
        lines: {
          has_more: false,
          data: [
            {
              id: `il_invitation_${randomUUID()}`,
              amount: 1000,
              period: purchase.fixture.billingPeriod,
              parent: { type: "invoice_item_details" },
            },
          ],
        },
      };
      context.mocks.stripe.invoices.retrieve.mockResolvedValue(
        ordinaryPaidInvoice,
      );
      await postManagedUsagePackEvent("invoice.paid", ordinaryPaidInvoice);
      expect(
        context.mocks.clerk.organizations.createOrganizationInvitation,
      ).toHaveBeenCalledOnce();
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
      expect(confirmed.body.message).toBe("Invitation purchased and sent");
    },
  );

  it("returns a hosted invoice for a pending invitation payment to an older client", async () => {
    const purchase = await beginInvitationPurchase(
      createOrgFixture(),
      purchaseManagedUsagePack,
    );
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
    const purchase = await beginInvitationPurchase(
      createOrgFixture(),
      purchaseManagedUsagePack,
    );
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

  it("keeps one payable invitation preview across concurrent requests for an email", async () => {
    mockNow(new Date("2035-05-15T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    await purchaseDeferredReplaySubscription();
    mockUsagePackChangePreviews(1000, 2000);
    const client = setupApp({ context, routes: orgInviteRoutes })(
      orgInviteContract,
    );
    const request = {
      headers: { authorization: "Bearer clerk-session" },
      body: {
        email: `concurrent-preview-${randomUUID()}@example.test`,
        role: "member" as const,
        usagePackUsd: 20 as const,
      },
    };
    const previews = await Promise.all([
      accept(client.previewPurchase(request), [200, 409]),
      accept(client.previewPurchase(request), [200, 409]),
    ]);
    expect(
      previews.some((preview) => {
        return preview.status === 200;
      }),
    ).toBeTruthy();
    const current = await accept(client.previewPurchase(request), [200]);
    expect(current.body).toMatchObject({
      immediateAmountCents: 1000,
      purchasedCredits: 10_000,
      bonusCredits: 200,
    });
    for (const preview of previews) {
      if (
        preview.status === 200 &&
        preview.body.purchaseId !== current.body.purchaseId
      ) {
        const superseded = await accept(
          client.confirmPurchase({
            headers: request.headers,
            params: { purchaseId: preview.body.purchaseId },
            body: {},
          }),
          [409],
        );
        expect(superseded.body.error.code).toBe("INVITATION_PURCHASE_INACTIVE");
      }
    }
  });

  it("grants invitation credits once across concurrent payment and acceptance deliveries", async () => {
    mockNow(new Date("2035-05-15T00:00:00.000Z"));
    onTestFinished(() => {
      clearMockNow();
    });
    const fixture = await purchaseDeferredReplaySubscription();
    const creditsBeforeInvitation = await readDeferredReplayCredits(fixture);
    const email = `concurrent-invitation-${randomUUID()}@example.test`;
    const invitationId = `inv_${randomUUID()}`;
    const acceptedUserId = `user_${randomUUID()}`;
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
      (await readGetStartedStatus(context, fixture)).quests.find((quest) => {
        return quest.key === "invite";
      }),
    ).toMatchObject({ claimedCount: 0, pendingCount: 1 });
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    context.mocks.stripe.subscriptions.update.mockResolvedValue({});
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
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    const getStarted = await readGetStartedStatus(context, fixture);
    expect(
      getStarted.quests.find((quest) => {
        return quest.key === "invite";
      }),
    ).toMatchObject({ claimedCount: 1, earnedCredits: 100 });
  });

  it("activates one paid invitation exactly once after Clerk creates the membership", async () => {
    const purchase = await beginInvitationPurchase(
      createOrgFixture(),
      purchaseManagedUsagePack,
    );
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

  it.each(["allocation", "plan"] as const)(
    "finishes a pending %s payment before activating a paid invitation",
    async (kind) => {
      mockNow(new Date("2035-05-15T00:00:00.000Z"));
      onTestFinished(() => {
        clearMockNow();
      });
      const fixture = await purchaseDeferredReplaySubscription();
      const email = `admission-invite-${randomUUID()}@example.test`;
      const invitationId = `inv_admission_${randomUUID()}`;
      const acceptedUserId = `user_admission_${randomUUID()}`;
      mockUsagePackChangePreviews(1000, 2000);
      const invitationPreview = await accept(
        setupApp({ context, routes: orgInviteRoutes })(
          orgInviteContract,
        ).previewPurchase({
          headers: { authorization: "Bearer clerk-session" },
          body: { email, role: "member", usagePackUsd: 20 },
        }),
        [200],
      );
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
          ? await accept(
              client.previewChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { memberId: fixture.userId, targetUsagePackUsd: 50 },
              }),
              [200],
            )
          : await accept(
              client.previewSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: {
                  targetTier: "team",
                  memberUsagePacks: [
                    { memberId: fixture.userId, usagePackUsd: 50 },
                  ],
                },
              }),
              [200],
            );
      const prorationTimestamp = Math.floor(
        new Date(preview.body.prorationDate).getTime() / 1000,
      );
      const paidInvoice = managedUsagePackUpgradeInvoice(fixture, {
        invoiceId: `in_admission_${randomUUID()}`,
        sourcePriceId: TEST_PRICE_USAGE_PACK_20,
        targetPriceId: TEST_PRICE_USAGE_PACK_50,
        prorationTimestamp,
      });
      const pendingInvoice = { ...paidInvoice, status: "open", paid: false };
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
      context.mocks.stripe.invoices.pay.mockResolvedValue(pendingInvoice);
      context.mocks.stripe.invoices.retrieve.mockResolvedValue(pendingInvoice);
      const confirm = async () => {
        return kind === "allocation"
          ? await accept(
              client.confirmChange({
                params: { changeId: preview.body.changeId },
                headers: { authorization: "Bearer clerk-session" },
                body: {},
              }),
              [200],
            )
          : await accept(
              client.confirmSubscriptionChange({
                headers: { authorization: "Bearer clerk-session" },
                body: { changeId: preview.body.changeId },
              }),
              [200],
            );
      };
      expect((await confirm()).body.status).toBe("pending_payment");
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        pendingSubscription,
      );

      // The pending invoice is the real unfinished billing operation. Accepting
      // an invitation must not replace that pending update or grant early credit.
      await postClerkInvitationAccepted({
        purchase,
        invitationId,
        userId: acceptedUserId,
      });
      expect((await confirm()).body.status).toBe("pending_payment");
      await expect(readDeferredReplayCredits(fixture)).resolves.toMatchObject({
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
      context.mocks.stripe.invoices.retrieve.mockResolvedValue(paidInvoice);
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
      await expect(readDeferredReplayCredits(fixture)).resolves.toMatchObject({
        purchasedCredits: 35_000,
        bonusCredits: 1600,
      });
      const management = await accept(
        client.get({ headers: { authorization: "Bearer clerk-session" } }),
        [200],
      );
      expect(management.body.allocations).toContainEqual(
        expect.objectContaining({ memberId: fixture.userId, usagePackUsd: 50 }),
      );
      expect(management.body.allocations).toContainEqual(
        expect.objectContaining({ memberId: acceptedUserId, usagePackUsd: 20 }),
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
      await postManagedUsagePackEvent("invoice.paid", paidInvoice);
      await postClerkInvitationAccepted({
        purchase,
        invitationId,
        userId: acceptedUserId,
      });
      await expect(
        readDeferredReplayCredits({ ...fixture, userId: acceptedUserId }),
      ).resolves.toMatchObject({ purchasedCredits: 10_000, bonusCredits: 200 });
      await expect(readDeferredReplayCredits(fixture)).resolves.toMatchObject({
        purchasedCredits: 35_000,
        bonusCredits: 1600,
      });
    },
  );

  it("revokes and refunds a paid pending invitation exactly once", async () => {
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
});
