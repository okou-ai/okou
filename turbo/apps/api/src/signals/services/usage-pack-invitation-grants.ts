import type { usagePackInvitationPurchases } from "@okouai/db/schema/usage-pack-subscription";
import { invoiceUsagePackCreditGrantSql } from "./usage-pack-credit-grant-sql";

/** Only the owning activation command executes the finite grant statements. */
export function invitationActivationGrantSql(
  purchase: typeof usagePackInvitationPurchases.$inferSelect,
  userId: string,
) {
  if (
    purchase.purchasedCredits > 0 &&
    (purchase.amountPaidCents === null ||
      (purchase.amountPaidCents > 0 && !purchase.stripePaymentIntentId))
  ) {
    throw new Error("Invitation acceptance has no refundable payment");
  }
  const identity = {
    orgId: purchase.orgId,
    userId,
    expiresAt: purchase.currentPeriodEnd,
  };
  return [
    ...(purchase.purchasedCredits > 0
      ? [
          invoiceUsagePackCreditGrantSql({
            ...identity,
            grantType: "purchased",
            idempotencyKey: `usage-pack-invitation:${purchase.id}:purchased`,
            amount: purchase.purchasedCredits,
            ...(purchase.amountPaidCents !== null &&
            purchase.amountPaidCents > 0 &&
            purchase.stripePaymentIntentId
              ? {
                  refund: {
                    paymentIntentId: purchase.stripePaymentIntentId,
                    amountCents: purchase.amountPaidCents,
                  },
                }
              : {}),
          }),
        ]
      : []),
    ...(purchase.bonusCredits > 0
      ? [
          invoiceUsagePackCreditGrantSql({
            ...identity,
            grantType: "bonus",
            idempotencyKey: `usage-pack-invitation:${purchase.id}:bonus`,
            amount: purchase.bonusCredits,
          }),
        ]
      : []),
  ];
}
