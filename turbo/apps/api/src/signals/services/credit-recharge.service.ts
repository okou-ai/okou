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
import { settle, tapError } from "../utils";
import { logger } from "../../lib/log";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { readOrgImpactMetadata } from "./impact-attribution.service";

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

/**
 * Trigger a Stripe auto-recharge invoice if the org's balance has
 * crossed the recharge threshold. Mirrors web's `triggerAutoRecharge`.
 *
 * Atomically claims the recharge slot via UPDATE … RETURNING with a
 * WHERE clause that filters on:
 *  - autoRechargeEnabled = true
 *  - plan entitlement allows auto-recharge
 *  - stripeCustomerId / threshold / amount NOT NULL
 *  - credits <= threshold
 *  - pendingAt IS NULL OR pendingAt < now() - 10 minutes
 *
 * The conditional UPDATE uses the database clock so concurrent workers
 * cannot double-claim. The 10-minute stale threshold lets a hung Stripe
 * call release the slot eventually.
 *
 * On Stripe error: clearPendingFlag so retry can fire on the next
 * legitimate processOrgUsageEvents call.
 *
 * Note: credits are GRANTED via the Stripe webhook
 * `handleAutoRechargeInvoicePaid` (separate route surface, out of
 * scope here). This Command only triggers the invoice; never grant
 * credits here.
 */
export const triggerAutoRecharge$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    const capabilities = await loadOrgPlanCapabilities(writeDb, orgId);
    signal.throwIfAborted();
    if (capabilities?.autoRechargeAllowed !== true) {
      return;
    }

    const planEligibility = exists(
      writeDb
        .select({ orgId: orgPlanEntitlements.orgId })
        .from(orgPlanEntitlements)
        .where(
          and(
            eq(orgPlanEntitlements.orgId, orgId),
            eq(orgPlanEntitlements.autoRechargeAllowed, true),
          ),
        ),
    );

    const clearPendingFlag = async (): Promise<void> => {
      await writeDb
        .update(orgMetadata)
        .set({ autoRechargePendingAt: null, updatedAt: nowDate() })
        .where(eq(orgMetadata.orgId, orgId));
    };

    const claimed = await writeDb
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

    const org = claimed[0] as ClaimedRechargeState | undefined;
    if (!org) {
      L.debug("Auto-recharge already pending or conditions unmet", { orgId });
      return;
    }

    const creditsAmount = org.autoRechargeAmount;
    const amountCents = Math.ceil(creditsAmount / CREDITS_PER_DOLLAR) * 100;

    const stripe = getStripeClient();

    await tapError(
      (async (): Promise<void> => {
        const paymentMethodId = await resolvePaymentMethod(stripe, org);
        signal.throwIfAborted();
        if (!paymentMethodId) {
          await clearPendingFlag();
          return;
        }

        const invoice = await stripe.invoices.create({
          customer: org.stripeCustomerId,
          auto_advance: false,
          default_payment_method: paymentMethodId,
          metadata: {
            type: "auto_recharge",
            orgId,
            creditsAmount: String(creditsAmount),
            ...(await readOrgImpactMetadata(writeDb, orgId, signal)),
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
      })(),
      async (error) => {
        L.warn("Auto-recharge Stripe call failed, clearing pending flag", {
          orgId,
          error: error instanceof Error ? error.message : String(error),
        });
        await clearPendingFlag();
      },
    );
    signal.throwIfAborted();
  },
);
