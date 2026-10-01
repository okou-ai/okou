import {
  getStripeClient,
  isStripeResourceMissingError,
  type StripeClient,
} from "../external/stripe-client";
import { settle } from "../utils";

const DUPLICATE_SUBSCRIPTION_REFUND_PURPOSE = "duplicate_subscription_refund";

/**
 * Initial Plan and usage-pack purchases are not serialized, so Stripe may end
 * up with a second paid subscription for an organization whose entitlement is
 * already bound to another live subscription. That entitlement is granted
 * once; this refunds the losing subscription's paid invoice and cancels it,
 * outside SQL. Stripe idempotency keys and the credit note metadata, keyed by
 * the Stripe invoice and subscription IDs, keep both single across webhook
 * redelivery and the hourly reconciliation replay of paid invoices.
 */
export async function refundDuplicateSubscriptionInvoice(
  invoice: { readonly id: string; readonly amount_paid?: number | null },
  subscriptionId: string,
): Promise<void> {
  const stripe = getStripeClient();
  const amountPaid =
    invoice.amount_paid ??
    (await stripe.invoices.retrieve(invoice.id)).amount_paid;
  if (
    amountPaid === undefined ||
    !Number.isSafeInteger(amountPaid) ||
    amountPaid < 0
  ) {
    throw new Error(`Invoice ${invoice.id} has an invalid paid amount`);
  }
  if (amountPaid > 0) {
    const page = await stripe.creditNotes.list({
      invoice: invoice.id,
      limit: 100,
    });
    const refunded = page.data.some((creditNote) => {
      return (
        creditNote.metadata?.purpose === DUPLICATE_SUBSCRIPTION_REFUND_PURPOSE
      );
    });
    if (!refunded && page.has_more) {
      throw new Error(`Stripe invoice ${invoice.id} has too many credit notes`);
    }
    if (!refunded) {
      await stripe.creditNotes.create(
        {
          invoice: invoice.id,
          amount: amountPaid,
          refund_amount: amountPaid,
          reason: "duplicate",
          metadata: {
            purpose: DUPLICATE_SUBSCRIPTION_REFUND_PURPOSE,
            invoiceId: invoice.id,
          },
        },
        { idempotencyKey: `duplicate-subscription:${invoice.id}:refund` },
      );
    }
  }
  const current = await stripe.subscriptions.retrieve(subscriptionId);
  if (
    current?.status === "canceled" ||
    current?.status === "incomplete_expired"
  ) {
    return;
  }
  const canceled = await settle(
    stripe.subscriptions.cancel(
      subscriptionId,
      { invoice_now: false, prorate: false },
      { idempotencyKey: `duplicate-subscription:${subscriptionId}:cancel` },
    ),
  );
  if (!canceled.ok && !isStripeResourceMissingError(canceled.error)) {
    throw canceled.error;
  }
}

/**
 * When the subscription became effective: the paid time of its only paid
 * invoice, `null` while unpaid, `undefined` once it is past its first period.
 */
async function firstPaidAt(
  stripe: StripeClient,
  subscriptionId: string,
): Promise<number | null | undefined> {
  const paid = await stripe.invoices.list({
    subscription: subscriptionId,
    status: "paid",
    limit: 2,
  });
  if (paid.data.length > 1) {
    return undefined;
  }
  const [invoice] = paid.data;
  return invoice ? (invoice.status_transitions?.paid_at ?? null) : null;
}

/**
 * Two subscriptions are duplicate initial purchases when each was created
 * before the other became effective: neither existed as the organization's
 * paid entitlement when the other was bought. A normal upgrade is created
 * after the subscription it replaces was paid, so it never matches. Reads
 * existing Stripe facts only, outside SQL.
 */
export async function areDuplicateInitialPurchases(
  subscriptionId: string,
  otherSubscriptionId: string,
): Promise<boolean> {
  if (subscriptionId === otherSubscriptionId) {
    return false;
  }
  const stripe = getStripeClient();
  const [subscription, other] = await Promise.all([
    stripe.subscriptions.retrieve(subscriptionId),
    stripe.subscriptions.retrieve(otherSubscriptionId),
  ]);
  if (subscription?.created === undefined || other?.created === undefined) {
    return false;
  }
  const [paidAt, otherPaidAt] = await Promise.all([
    firstPaidAt(stripe, subscriptionId),
    firstPaidAt(stripe, otherSubscriptionId),
  ]);
  if (paidAt === undefined || otherPaidAt === undefined) {
    return false;
  }
  return (
    (otherPaidAt === null || subscription.created < otherPaidAt) &&
    (paidAt === null || other.created < paidAt)
  );
}
