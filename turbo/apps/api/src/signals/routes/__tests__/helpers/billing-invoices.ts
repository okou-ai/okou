import { command } from "ccstate";

import { now } from "../../../../lib/time";
import {
  createBillingWebhookFixture,
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postBillingDowngradeCheckoutCompleted,
  postSubscriptionInvoicePaid,
  type BillingWebhookFixture,
} from "./stripe-billing-webhook";

export interface InvoicesOrgFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly stripeCustomerId: string | null;
}

interface InvoicesSeedValues {
  readonly stripeCustomerId?: string | null;
  readonly stripeSubscriptionId?: string | null;
  readonly subscriptionStatus?: string | null;
  readonly tier?: string;
  readonly currentPeriodEnd?: Date | null;
  readonly cancelAtPeriodEnd?: boolean;
  readonly pendingSubscriptionScheduleId?: string | null;
  readonly pendingSubscriptionTargetTier?: string | null;
  readonly pendingSubscriptionChangeAt?: Date | null;
}

function fixtureFromWebhook(
  fixture: BillingWebhookFixture,
  stripeCustomerId: string | null,
): InvoicesOrgFixture {
  return { ...fixture, stripeCustomerId };
}

function subscriptionTier(tier: string | undefined): "pro" | "team" | null {
  if (tier === "pro" || tier === "team") {
    return tier;
  }
  return null;
}

function defaultCurrentPeriodEnd(): Date {
  return new Date(now() + 30 * 24 * 60 * 60 * 1000);
}

export const seedInvoicesOrg$ = command(
  async (
    _,
    values: InvoicesSeedValues,
    signal: AbortSignal,
  ): Promise<InvoicesOrgFixture> => {
    const fixture = createBillingWebhookFixture();
    const tier = subscriptionTier(values.tier);
    if (!tier) {
      return fixtureFromWebhook(fixture, values.stripeCustomerId ?? null);
    }

    const stripeCustomerId =
      values.stripeCustomerId ?? generatedStripeCustomerId();
    const stripeSubscriptionId =
      values.stripeSubscriptionId ?? generatedStripeSubscriptionId();
    const currentPeriodEnd =
      values.currentPeriodEnd ?? defaultCurrentPeriodEnd();
    await postSubscriptionInvoicePaid(signal, {
      ...fixture,
      tier,
      customerId: stripeCustomerId,
      subscriptionId: stripeSubscriptionId,
      status: values.subscriptionStatus ?? "active",
      currentPeriodEnd,
      cancelAtPeriodEnd: values.cancelAtPeriodEnd,
      scheduleId:
        values.pendingSubscriptionTargetTier === "pro"
          ? null
          : (values.pendingSubscriptionScheduleId ?? null),
    });

    if (values.pendingSubscriptionTargetTier === "pro" && tier === "team") {
      await postBillingDowngradeCheckoutCompleted(signal, {
        ...fixture,
        tier,
        customerId: stripeCustomerId,
        subscriptionId: stripeSubscriptionId,
        status: values.subscriptionStatus ?? "active",
        currentPeriodEnd:
          values.pendingSubscriptionChangeAt ?? currentPeriodEnd,
        cancelAtPeriodEnd: false,
        targetTier: "pro",
        scheduleId:
          values.pendingSubscriptionScheduleId ??
          generatedStripeSubscriptionId(),
      });
    }

    return fixtureFromWebhook(fixture, stripeCustomerId);
  },
);

export const deleteInvoicesOrg$ = command(
  async (
    _,
    _fixture: InvoicesOrgFixture,
    _signal: AbortSignal,
  ): Promise<void> => {
    await Promise.resolve();
  },
);
