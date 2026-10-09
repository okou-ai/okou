import { command } from "ccstate";

import {
  createBillingWebhookFixture,
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postAutoRechargeInvoicePaid,
  postBillingDowngradeCheckoutCompleted,
  postConcurrencyEntitlementsInvoicePaid,
  postCreditPurchaseInvoicePaid,
  postOneTimePurchaseCompleted,
  postSubscriptionInvoicePaid,
  subscriptionCredits,
  TEST_PRICE_CONCURRENCY,
  type BillingWebhookFixture,
} from "./stripe-billing-webhook";

export interface BillingStatusFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly expiresRecordIds: readonly string[];
}

interface SubscriptionSeed {
  readonly tier: string;
  readonly status: string;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd?: boolean;
  readonly stripeCustomerId?: string;
  readonly stripeSubscriptionId?: string;
  readonly pendingSubscriptionScheduleId?: string;
  readonly pendingSubscriptionTargetTier?: string;
  readonly pendingSubscriptionChangeAt?: Date;
}

interface ExpiresRecordSeed {
  readonly source: string;
  readonly amount: number;
  readonly remaining?: number;
  readonly expiresAt: Date;
  readonly stripeInvoiceId?: string;
}

interface ConcurrencyEntitlementSeed {
  readonly slots: number;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly subscriptionStatus?: string;
  readonly cancelAtPeriodEnd?: boolean;
  readonly stripeSubscriptionId?: string;
  readonly stripeInvoiceId?: string;
  readonly stripeInvoiceLineId?: string;
  readonly stripePriceId?: string;
}

interface BillingStatusSeedValues {
  readonly credits?: number;
  readonly onboardingPaymentPending?: boolean;
  readonly subscription?: SubscriptionSeed;
  readonly expiresRecords?: readonly ExpiresRecordSeed[];
  readonly concurrencyEntitlements?: readonly ConcurrencyEntitlementSeed[];
  readonly extraGrantedCredits?: number;
}

function fixtureFromWebhook(
  fixture: BillingWebhookFixture,
): BillingStatusFixture {
  return { ...fixture, expiresRecordIds: [] };
}

function subscriptionTier(tier: string): "pro" | "team" | null {
  if (tier === "pro" || tier === "team") {
    return tier;
  }
  return null;
}

function unsupportedSyntheticState(values: BillingStatusSeedValues): string[] {
  const reasons: string[] = [];
  if (values.credits !== undefined && values.credits < 0) {
    reasons.push("negative credits");
  }
  if (values.onboardingPaymentPending) {
    reasons.push("onboarding payment pending metadata");
  }
  for (const record of values.expiresRecords ?? []) {
    if (record.remaining !== undefined && record.remaining !== record.amount) {
      reasons.push(`${record.source} partial remaining credits`);
    }
    if (record.source === "starter_grant" || record.source === "onboarding") {
      reasons.push(`${record.source} grant source`);
    }
  }
  return reasons;
}

async function applySubscriptionSeed(
  signal: AbortSignal,
  fixture: BillingWebhookFixture,
  seed: SubscriptionSeed | undefined,
  customerId: string,
): Promise<number> {
  if (!seed) {
    return 0;
  }

  const tier = subscriptionTier(seed.tier);
  if (!tier) {
    return 0;
  }

  const subscriptionId =
    seed.stripeSubscriptionId ?? generatedStripeSubscriptionId();
  await postSubscriptionInvoicePaid(signal, {
    ...fixture,
    tier,
    customerId,
    subscriptionId,
    status: seed.status,
    currentPeriodEnd: seed.currentPeriodEnd,
    cancelAtPeriodEnd: seed.cancelAtPeriodEnd,
    scheduleId:
      seed.pendingSubscriptionTargetTier === "pro"
        ? null
        : (seed.pendingSubscriptionScheduleId ?? null),
  });

  if (seed.pendingSubscriptionTargetTier === "pro" && tier === "team") {
    await postBillingDowngradeCheckoutCompleted(signal, {
      ...fixture,
      tier,
      customerId,
      subscriptionId,
      status: seed.status,
      currentPeriodEnd:
        seed.pendingSubscriptionChangeAt ?? seed.currentPeriodEnd,
      cancelAtPeriodEnd: false,
      targetTier: "pro",
      scheduleId:
        seed.pendingSubscriptionScheduleId ?? generatedStripeSubscriptionId(),
    });
  }
  return subscriptionCredits(tier);
}

async function applyExpiresRecordSeed(
  signal: AbortSignal,
  fixture: BillingWebhookFixture,
  record: ExpiresRecordSeed,
): Promise<number> {
  switch (record.source) {
    case "credit_purchase": {
      await postCreditPurchaseInvoicePaid(signal, {
        orgId: fixture.orgId,
        credits: record.amount,
        expiresAt: record.expiresAt,
        invoiceId: record.stripeInvoiceId,
      });
      return record.amount;
    }
    case "auto_recharge": {
      await postAutoRechargeInvoicePaid(signal, {
        orgId: fixture.orgId,
        credits: record.amount,
        invoiceId: record.stripeInvoiceId,
      });
      return record.amount;
    }
    case "one_time_purchase": {
      if (
        await postOneTimePurchaseCompleted(signal, {
          orgId: fixture.orgId,
          credits: record.amount,
          sessionId: record.stripeInvoiceId,
        })
      ) {
        return record.amount;
      }
      return 0;
    }
    case "subscription_renewal":
    case "starter_grant":
    case "onboarding":
    default: {
      return 0;
    }
  }
}

async function applyConcurrencySeeds(
  signal: AbortSignal,
  fixture: BillingWebhookFixture,
  customerId: string,
  values: readonly ConcurrencyEntitlementSeed[] | undefined,
): Promise<void> {
  const bySubscription = new Map<string, ConcurrencyEntitlementSeed[]>();
  for (const entitlement of values ?? []) {
    const subscriptionId =
      entitlement.stripeSubscriptionId ?? generatedStripeSubscriptionId();
    bySubscription.set(subscriptionId, [
      ...(bySubscription.get(subscriptionId) ?? []),
      { ...entitlement, stripeSubscriptionId: subscriptionId },
    ]);
  }

  for (const [subscriptionId, entitlements] of bySubscription) {
    const first = entitlements[0];
    if (!first) {
      continue;
    }
    await postConcurrencyEntitlementsInvoicePaid(signal, {
      ...fixture,
      customerId,
      subscriptionId,
      invoiceId: first.stripeInvoiceId,
      lines: entitlements.map((entitlement) => {
        return {
          slots: entitlement.slots,
          startsAt: entitlement.startsAt,
          expiresAt: entitlement.expiresAt,
          invoiceLineId: entitlement.stripeInvoiceLineId,
          priceId: entitlement.stripePriceId ?? TEST_PRICE_CONCURRENCY,
        };
      }),
      subscriptionStatus:
        entitlements.find((entitlement) => {
          return entitlement.subscriptionStatus;
        })?.subscriptionStatus ?? "active",
      cancelAtPeriodEnd: entitlements.some((entitlement) => {
        return entitlement.cancelAtPeriodEnd === true;
      }),
    });
  }
}

export const seedBillingStatusOrg$ = command(
  async (
    _,
    values: BillingStatusSeedValues,
    signal: AbortSignal,
  ): Promise<BillingStatusFixture> => {
    const unsupported = unsupportedSyntheticState(values);
    if (unsupported.length > 0) {
      throw new Error(
        `seedBillingStatusOrg$ cannot create synthetic billing state through Stripe webhooks: ${unsupported.join(", ")}`,
      );
    }

    const fixture = createBillingWebhookFixture();
    const customerId =
      values.subscription?.stripeCustomerId ?? generatedStripeCustomerId();
    let grantedCredits = await applySubscriptionSeed(
      signal,
      fixture,
      values.subscription,
      customerId,
    );

    for (const record of values.expiresRecords ?? []) {
      grantedCredits += await applyExpiresRecordSeed(signal, fixture, record);
    }

    await applyConcurrencySeeds(
      signal,
      fixture,
      customerId,
      values.concurrencyEntitlements,
    );

    if (values.extraGrantedCredits && values.extraGrantedCredits > 0) {
      await postCreditPurchaseInvoicePaid(signal, {
        orgId: fixture.orgId,
        credits: values.extraGrantedCredits,
      });
      grantedCredits += values.extraGrantedCredits;
    }

    const requestedCredits = values.credits ?? 0;
    const topUpCredits = requestedCredits - grantedCredits;
    if (topUpCredits > 0) {
      await postCreditPurchaseInvoicePaid(signal, {
        orgId: fixture.orgId,
        credits: topUpCredits,
      });
    }

    return fixtureFromWebhook(fixture);
  },
);

export const deleteBillingStatusOrg$ = command(
  async (
    _,
    _fixture: BillingStatusFixture,
    _signal: AbortSignal,
  ): Promise<void> => {
    await Promise.resolve();
  },
);
