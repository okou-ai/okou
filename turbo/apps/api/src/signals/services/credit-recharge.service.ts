import { command } from "ccstate";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import {
  and,
  eq,
  exists,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { writeDb$ } from "../external/db";
import {
  getStripeClient,
  stripeErrorInfo,
  type StripeClient,
  type StripeRef,
} from "../external/stripe-client";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import { logger } from "../../lib/log";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";

const L = logger("CreditRecharge");

const CREDITS_PER_DOLLAR = 1000;
const STALE_THRESHOLD_MINUTES = 10;

interface ClaimedRechargeState {
  readonly credits: number;
  readonly tier: string;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string | null;
  readonly autoRechargeEnabled: boolean;
  readonly autoRechargeThreshold: number;
  readonly autoRechargeAmount: number;
  readonly autoRechargePendingAt: Date | null;
}

function resolvePaymentMethodId(pm: StripeRef | undefined): string | null {
  if (typeof pm === "string") {
    return pm;
  }
  return pm?.id ?? null;
}

async function resolvePaymentMethod(
  stripe: StripeClient,
  org: ClaimedRechargeState,
): Promise<string | null> {
  const customer = await stripe.customers.retrieve(org.stripeCustomerId);
  if ("deleted" in customer && customer.deleted) {
    L.warn("Stripe customer is deleted, skipping auto-recharge", {
      stripeCustomerId: org.stripeCustomerId,
    });
    return null;
  }
  const customerPm = resolvePaymentMethodId(
    customer.invoice_settings?.default_payment_method,
  );
  if (customerPm) {
    return customerPm;
  }

  if (org.stripeSubscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(
      org.stripeSubscriptionId,
    );
    const subPm = resolvePaymentMethodId(subscription.default_payment_method);
    if (subPm) {
      return subPm;
    }
  }

  const paymentMethods = await stripe.paymentMethods.list({
    customer: org.stripeCustomerId,
    type: "card",
    limit: 1,
  });
  const attachedPm = paymentMethods.data[0]?.id;
  if (attachedPm) {
    return attachedPm;
  }

  L.warn(
    "No payment method found on customer, subscription, or attached cards",
    {
      stripeCustomerId: org.stripeCustomerId,
    },
  );
  return null;
}

async function payAutoRechargeInvoice(
  stripe: StripeClient,
  invoiceId: string,
  signal: AbortSignal,
): Promise<void> {
  const invoice = await stripe.invoices.finalizeInvoice(invoiceId);
  signal.throwIfAborted();
  if (invoice.status === "paid") {
    return;
  }
  if (invoice.status !== "open") {
    throw new Error(
      `Auto-recharge invoice ${invoiceId} cannot be paid from status ${invoice.status}`,
    );
  }

  const payment = await settle(stripe.invoices.pay(invoiceId), signal);
  if (payment.ok) {
    if (payment.value.status !== "paid") {
      throw new Error(`Auto-recharge invoice ${invoiceId} was not paid`);
    }
    return;
  }
  if (stripeErrorInfo(payment.error)?.type !== "StripeInvalidRequestError") {
    throw payment.error;
  }

  // Stripe request errors can omit a code; only a confirmed paid invoice
  // turns a rejected payment request into success.
  const paidInvoice = await stripe.invoices.retrieve(invoiceId);
  signal.throwIfAborted();
  if (paidInvoice.status !== "paid") {
    throw payment.error;
  }
}

/** The existing pending timestamp admits one recharge; SQL owns no provider work. */
const claimAutoRecharge$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<ClaimedRechargeState | null> => {
    const capabilities = await set(loadOrgPlanCapabilities$, orgId, signal);
    if (capabilities?.autoRechargeAllowed !== true) {
      return null;
    }
    const db = set(writeDb$);
    const planEligibility = exists(
      db
        .select({ orgId: orgPlanEntitlements.orgId })
        .from(orgPlanEntitlements)
        .where(
          and(
            eq(orgPlanEntitlements.orgId, orgId),
            eq(orgPlanEntitlements.autoRechargeAllowed, true),
          ),
        ),
    );
    const [claimed] = await db
      .update(orgMetadata)
      .set({ autoRechargePendingAt: nowDate(), updatedAt: nowDate() })
      .where(
        and(
          eq(orgMetadata.orgId, orgId),
          eq(orgMetadata.autoRechargeEnabled, true),
          planEligibility,
          isNotNull(orgMetadata.stripeCustomerId),
          isNotNull(orgMetadata.autoRechargeThreshold),
          isNotNull(orgMetadata.autoRechargeAmount),
          lte(orgMetadata.credits, orgMetadata.autoRechargeThreshold),
          or(
            isNull(orgMetadata.autoRechargePendingAt),
            lt(
              orgMetadata.autoRechargePendingAt,
              sql`now() - make_interval(mins => ${STALE_THRESHOLD_MINUTES})`,
            ),
          ),
        ),
      )
      .returning({
        credits: orgMetadata.credits,
        tier: orgMetadata.tier,
        stripeCustomerId: orgMetadata.stripeCustomerId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
        autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
        autoRechargeAmount: orgMetadata.autoRechargeAmount,
        autoRechargePendingAt: orgMetadata.autoRechargePendingAt,
      });
    signal.throwIfAborted();
    if (!claimed) {
      return null;
    }
    if (
      !claimed.stripeCustomerId ||
      claimed.autoRechargeThreshold === null ||
      claimed.autoRechargeAmount === null
    ) {
      throw new Error(
        "Claimed auto-recharge is missing its billing configuration",
      );
    }
    return {
      ...claimed,
      stripeCustomerId: claimed.stripeCustomerId,
      autoRechargeThreshold: claimed.autoRechargeThreshold,
      autoRechargeAmount: claimed.autoRechargeAmount,
    };
  },
);

/**
 * A failed or skipped recharge always clears its pending flag: settlement
 * debits rewrite the organization row in between, and a lingering flag would
 * block recharge for the whole stale window while the balance keeps falling.
 */
const clearClaimedAutoRecharge$ = command(
  async ({ set }, orgId: string): Promise<void> => {
    await set(writeDb$)
      .update(orgMetadata)
      .set({ autoRechargePendingAt: null, updatedAt: nowDate() })
      .where(eq(orgMetadata.orgId, orgId));
  },
);

async function createAutoRechargeInvoice(
  orgId: string,
  org: ClaimedRechargeState,
  signal: AbortSignal,
): Promise<boolean> {
  const creditsAmount = org.autoRechargeAmount;
  const amountCents = Math.ceil(creditsAmount / CREDITS_PER_DOLLAR) * 100;
  const stripe = getStripeClient();
  const paymentMethodId = await resolvePaymentMethod(stripe, org);
  signal.throwIfAborted();
  if (!paymentMethodId) {
    return false;
  }
  const invoice = await stripe.invoices.create({
    customer: org.stripeCustomerId,
    auto_advance: false,
    default_payment_method: paymentMethodId,
    metadata: {
      type: "auto_recharge",
      orgId,
      creditsAmount: String(creditsAmount),
      ...stripePreviewMetadata(),
    },
  });
  signal.throwIfAborted();
  await stripe.invoiceItems.create({
    invoice: invoice.id,
    customer: org.stripeCustomerId,
    amount: amountCents,
    currency: "usd",
    description: `Credit top-up: ${creditsAmount.toLocaleString()} credits`,
  });
  signal.throwIfAborted();
  await payAutoRechargeInvoice(stripe, invoice.id, signal);
  L.debug("Auto-recharge invoice created and paid", {
    orgId,
    creditsAmount,
    amountCents,
    invoiceId: invoice.id,
  });
  return true;
}

/** Credits remain granted only by the idempotent paid-invoice webhook. */
export const triggerAutoRecharge$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const org = await set(claimAutoRecharge$, orgId, signal);
    if (!org) {
      L.debug("Auto-recharge already pending or conditions unmet", { orgId });
      return;
    }
    const result = await settle(
      createAutoRechargeInvoice(orgId, org, signal),
      signal,
    );
    if (!result.ok) {
      L.warn("Auto-recharge Stripe call failed, clearing its pending claim", {
        orgId,
        error:
          result.error instanceof Error
            ? result.error.message
            : String(result.error),
      });
    }
    if (!result.ok || !result.value) {
      await set(clearClaimedAutoRecharge$, orgId);
    }
    signal.throwIfAborted();
  },
);
