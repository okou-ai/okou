import { randomUUID } from "node:crypto";

import type StripeSDK from "stripe";

import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { getApiTestMocks } from "../../../../__tests__/mocks";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { mockStripeClient } from "../../../external/stripe-client";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { webhooksStripeRoutes } from "../../webhooks-stripe";

const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";
const TEST_PRICE_CUSTOM = "price_test_custom";
export const TEST_PRICE_CONCURRENCY = "price_test_concurrency";
const TEST_PRICE_ATOM_GRANT = "price_test_atom_grant";

const STRIPE_WEBHOOK_SECRET = "whsec_billing_state_test";
const DEFAULT_CREDIT_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000;

export interface BillingWebhookFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface SubscriptionWebhookInput extends BillingWebhookFixture {
  readonly tier: "pro" | "team" | "custom";
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly status?: string;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd?: boolean;
  readonly scheduleId?: string | null;
}

interface ConcurrencyWebhookLine {
  readonly slots: number;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly invoiceLineId?: string;
  readonly priceId?: string;
}

export function createBillingWebhookFixture(): BillingWebhookFixture {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

export function generatedStripeCustomerId(): string {
  return `cus_${randomUUID().slice(0, 8)}`;
}

export function generatedStripeSubscriptionId(): string {
  return `sub_${randomUUID().slice(0, 8)}`;
}

export function subscriptionCredits(tier: "pro" | "team"): number {
  return tier === "team" ? 120_000 : 20_000;
}

function configureBillingWebhookEnv(): void {
  mockStripeClient(getApiTestMocks().stripe as unknown as StripeSDK);
  mockEnv("OKOU_PRICE_PRO", TEST_PRICE_PRO);
  mockEnv("OKOU_PRICE_TEAM", TEST_PRICE_TEAM);
  mockEnv("OKOU_PRICE_CUSTOM", TEST_PRICE_CUSTOM);
  mockEnv("OKOU_PRICE_CONCURRENCY", TEST_PRICE_CONCURRENCY);
  mockEnv("ATOM_GRANT_PRICE", TEST_PRICE_ATOM_GRANT);
  mockEnv(
    "OKOU_ONE_TIME_CAMPAIGN",
    JSON.stringify({
      ZERO100: {
        priceId: "price_test_zero100",
        couponId: "coupon_test_zero100",
      },
    }),
  );
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
}

function mockClerkOrganization(fixture: BillingWebhookFixture): void {
  getApiTestMocks().clerk.organizations.getOrganization.mockResolvedValue({
    id: fixture.orgId,
    slug: `billing-${fixture.orgId.slice(-8)}`,
    name: "Billing Test Org",
    createdBy: fixture.userId,
  });
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function defaultCreditExpiresAt(): Date {
  return new Date(now() + DEFAULT_CREDIT_EXPIRES_MS);
}

function subscriptionPriceId(tier: "pro" | "team" | "custom"): string {
  return tier === "custom"
    ? TEST_PRICE_CUSTOM
    : tier === "team"
      ? TEST_PRICE_TEAM
      : TEST_PRICE_PRO;
}

function subscriptionPrice(tier: SubscriptionWebhookInput["tier"]) {
  return {
    id: subscriptionPriceId(tier),
  };
}

async function postStripeEvent(
  signal: AbortSignal,
  event: Readonly<Record<string, unknown>>,
): Promise<void> {
  const app = createAppWithRoutes({ signal, routes: webhooksStripeRoutes });
  const stripeEvent = {
    created: Math.floor(now() / 1000),
    ...event,
  };
  getApiTestMocks().stripe.webhooks.constructEvent.mockReturnValueOnce(
    stripeEvent,
  );
  const response = await app.request("/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=billing-state-test" },
    body: JSON.stringify(stripeEvent),
  });
  signal.throwIfAborted();
  if (response.ok) {
    return;
  }
  const body = await response.text();
  throw new Error(
    `Stripe webhook seed failed with ${response.status}: ${body}`,
  );
}

function stripeCustomer(customerId: string, orgId: string) {
  return {
    id: customerId,
    metadata: { orgId },
  };
}

function stripeSubscription(args: SubscriptionWebhookInput) {
  const periodEnd = seconds(args.currentPeriodEnd);
  const periodStart = periodEnd - 30 * 86_400;
  return {
    id: args.subscriptionId,
    status: args.status ?? "active",
    customer: args.customerId,
    cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
    cancel_at: args.cancelAtPeriodEnd ? periodEnd : null,
    schedule: args.scheduleId ?? null,
    trial_end: args.status === "trialing" ? periodEnd : null,
    metadata: {},
    items: {
      data: [
        {
          price: subscriptionPrice(args.tier),
          current_period_start: periodStart,
          current_period_end: periodEnd,
        },
      ],
    },
  };
}

export async function postSubscriptionInvoicePaid(
  signal: AbortSignal,
  args: SubscriptionWebhookInput,
): Promise<void> {
  configureBillingWebhookEnv();
  mockClerkOrganization(args);

  const periodEnd = seconds(args.currentPeriodEnd);
  const periodStart = periodEnd - 30 * 86_400;
  const mocks = getApiTestMocks();
  mocks.stripe.customers.retrieve.mockResolvedValueOnce(
    stripeCustomer(args.customerId, args.orgId),
  );
  mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
    stripeSubscription(args),
  );
  if (args.scheduleId) {
    mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: args.scheduleId,
      end_behavior: "cancel",
      current_phase: {
        start_date: periodStart,
        end_date: periodEnd,
      },
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
        },
      ],
    });
  }

  await postStripeEvent(signal, {
    type: "invoice.paid",
    data: {
      object: {
        id: `in_${randomUUID().slice(0, 8)}`,
        customer: args.customerId,
        metadata: {},
        subtotal: 0,
        parent: {
          subscription_details: {
            subscription: args.subscriptionId,
            metadata: {},
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_${randomUUID().slice(0, 8)}`,
              price: { id: subscriptionPriceId(args.tier) },
              quantity: 1,
              parent: { type: "subscription_item_details" },
              period: {
                start: periodStart,
                end: periodEnd,
              },
            },
          ],
        },
      },
    },
  });
}

export async function postCreditPurchaseInvoicePaid(
  signal: AbortSignal,
  args: {
    readonly orgId: string;
    readonly credits: number;
    readonly expiresAt?: Date;
    readonly invoiceId?: string;
  },
): Promise<void> {
  if (args.credits <= 0) {
    return;
  }

  configureBillingWebhookEnv();
  await postStripeEvent(signal, {
    type: "invoice.paid",
    data: {
      object: {
        id: args.invoiceId ?? `in_credit_${randomUUID().slice(0, 8)}`,
        customer: null,
        subtotal: Math.ceil(args.credits / 10),
        metadata: {
          type: "credit_purchase",
          orgId: args.orgId,
          creditsExpiresAt: (
            args.expiresAt ?? defaultCreditExpiresAt()
          ).toISOString(),
        },
        parent: null,
        lines: {
          has_more: false,
          data: [],
        },
      },
    },
  });
}

export async function postAutoRechargeInvoicePaid(
  signal: AbortSignal,
  args: {
    readonly orgId: string;
    readonly credits: number;
    readonly invoiceId?: string;
  },
): Promise<void> {
  if (args.credits <= 0) {
    return;
  }

  configureBillingWebhookEnv();
  await postStripeEvent(signal, {
    type: "invoice.paid",
    data: {
      object: {
        id: args.invoiceId ?? `in_auto_${randomUUID().slice(0, 8)}`,
        customer: null,
        subtotal: 0,
        metadata: {
          type: "auto_recharge",
          orgId: args.orgId,
          creditsAmount: String(args.credits),
        },
        parent: null,
        lines: {
          has_more: false,
          data: [],
        },
      },
    },
  });
}

export async function postOneTimePurchaseCompleted(
  signal: AbortSignal,
  args: {
    readonly orgId: string;
    readonly credits: number;
    readonly sessionId?: string;
  },
): Promise<boolean> {
  if (args.credits !== 100_000) {
    return false;
  }

  configureBillingWebhookEnv();
  await postStripeEvent(signal, {
    type: "checkout.session.completed",
    data: {
      object: {
        id: args.sessionId ?? `cs_zero100_${randomUUID().slice(0, 8)}`,
        invoice: null,
        subscription: null,
        customer: null,
        mode: "payment",
        payment_status: "paid",
        amount_subtotal: 0,
        amount_total: 0,
        metadata: {
          purpose: "one_time_purchase",
          orgId: args.orgId,
          campaignKey: "ZERO100",
        },
      },
    },
  });
  return true;
}

/** Reevaluate queued inputs through the production entitlement-change entry. */
export async function refreshConcurrencyEntitlement(
  actor: { readonly orgId: string | null; readonly userId: string },
  customerId: string,
  signal: AbortSignal,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  await postConcurrencyEntitlementsInvoicePaid(signal, {
    orgId: actor.orgId,
    userId: actor.userId,
    customerId,
    subscriptionId: `sub_${randomUUID()}`,
    lines: [
      {
        slots: 1,
        startsAt: new Date(now()),
        expiresAt: new Date(now() + 86_400_000),
      },
    ],
  });
  await flushWaitUntilForTest();
}

export async function postConcurrencyEntitlementsInvoicePaid(
  signal: AbortSignal,
  args: BillingWebhookFixture & {
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly invoiceId?: string;
    readonly lines: readonly ConcurrencyWebhookLine[];
    readonly subscriptionStatus?: string;
    readonly cancelAtPeriodEnd?: boolean;
  },
): Promise<void> {
  if (args.lines.length === 0) {
    return;
  }

  configureBillingWebhookEnv();
  mockClerkOrganization(args);
  getApiTestMocks().stripe.customers.retrieve.mockResolvedValueOnce(
    stripeCustomer(args.customerId, args.orgId),
  );

  const activeLines = args.lines.filter((line) => {
    return line.expiresAt.getTime() > now();
  });
  const subscriptionLines = activeLines.length > 0 ? activeLines : args.lines;
  const currentPeriodEnd = Math.max(
    ...subscriptionLines.map((line) => {
      return seconds(line.expiresAt);
    }),
  );
  const subscription = {
    id: args.subscriptionId,
    customer: args.customerId,
    status: args.subscriptionStatus ?? "active",
    metadata: { purpose: "concurrency_subscription" },
    cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
    cancel_at: args.cancelAtPeriodEnd ? currentPeriodEnd : null,
    schedule: null,
    trial_end: null,
    items: {
      data: [
        {
          price: {
            id: subscriptionLines[0]?.priceId ?? TEST_PRICE_CONCURRENCY,
          },
          quantity: subscriptionLines.reduce((sum, line) => {
            return sum + line.slots;
          }, 0),
          current_period_end: currentPeriodEnd,
        },
      ],
    },
  };
  getApiTestMocks().stripe.subscriptions.retrieve.mockResolvedValue(
    subscription,
  );

  await postStripeEvent(signal, {
    type: "invoice.paid",
    data: {
      object: {
        id: args.invoiceId ?? `in_conc_${randomUUID().slice(0, 8)}`,
        customer: args.customerId,
        metadata: { purpose: "concurrency_subscription" },
        subtotal: 0,
        parent: {
          subscription_details: {
            subscription: args.subscriptionId,
            metadata: { purpose: "concurrency_subscription" },
          },
        },
        lines: {
          has_more: false,
          data: args.lines.map((line) => {
            return {
              id: line.invoiceLineId ?? `il_conc_${randomUUID().slice(0, 8)}`,
              price: { id: line.priceId ?? TEST_PRICE_CONCURRENCY },
              quantity: line.slots,
              parent: { type: "subscription_item_details" },
              period: {
                start: seconds(line.startsAt),
                end: seconds(line.expiresAt),
              },
            };
          }),
        },
      },
    },
  });

  if (
    args.subscriptionStatus === undefined &&
    args.cancelAtPeriodEnd === undefined
  ) {
    return;
  }

  await postStripeEvent(signal, {
    type: "customer.subscription.updated",
    data: {
      object: subscription,
    },
  });
}

export async function postBillingDowngradeCheckoutCompleted(
  signal: AbortSignal,
  args: SubscriptionWebhookInput & {
    readonly targetTier: "pro";
    readonly scheduleId: string;
  },
): Promise<void> {
  configureBillingWebhookEnv();

  const periodEnd = seconds(args.currentPeriodEnd);
  const periodStart = periodEnd - 30 * 86_400;
  const mocks = getApiTestMocks();
  mocks.stripe.customers.update.mockResolvedValueOnce({ id: args.customerId });
  mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
    id: args.subscriptionId,
    status: args.status ?? "active",
    customer: args.customerId,
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    metadata: {},
    items: {
      data: [
        {
          id: `si_${randomUUID().slice(0, 8)}`,
          price: {
            id: subscriptionPriceId(args.tier),
            recurring: { interval: "month", interval_count: 1 },
          },
          quantity: 1,
          current_period_start: periodStart,
          current_period_end: periodEnd,
        },
      ],
    },
  });
  mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
    id: args.scheduleId,
    current_phase: {
      start_date: periodStart,
      end_date: periodEnd,
    },
    phases: [],
  });
  mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
    id: args.scheduleId,
  });

  await postStripeEvent(signal, {
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_downgrade_${randomUUID().slice(0, 8)}`,
        invoice: null,
        subscription: null,
        customer: args.customerId,
        mode: "setup",
        setup_intent: {
          id: `seti_${randomUUID().slice(0, 8)}`,
          payment_method: `pm_${randomUUID().slice(0, 8)}`,
        },
        payment_status: null,
        metadata: {
          purpose: "billing_downgrade",
          orgId: args.orgId,
          subscriptionId: args.subscriptionId,
          targetTier: args.targetTier,
        },
      },
    },
  });
}
