import {
  getStripeClient,
  isStripeResourceMissingError,
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
