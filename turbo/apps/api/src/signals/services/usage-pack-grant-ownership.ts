import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackSubscriptions } from "@okouai/db/schema/usage-pack-subscription";
import { and, eq } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

/**
 * Plain existence read of the subscription parent. The invoice fulfillment
 * row the transaction inserts references it (FOREIGN KEY, ON DELETE CASCADE),
 * so the implicit key-share lock of that insert keeps the parent for the
 * commit, and its primary key on the Stripe invoice makes publication unique.
 */
export function grantSubscriptionOwnershipQuery(
  orgId: string,
  subscriptionId: string,
) {
  return new QueryBuilder()
    .select({ id: usagePackSubscriptions.id })
    .from(usagePackSubscriptions)
    .where(
      and(
        eq(usagePackSubscriptions.id, subscriptionId),
        eq(usagePackSubscriptions.orgId, orgId),
      ),
    )
    .as("grant_subscription_parent");
}

/**
 * Plain existence read of the wallet. Member-grant publication no longer has
 * to exclude settlement through this row: settlement decrements grants with
 * conditional xmin writes, and a grant published after its unseen-prefix read
 * is ordered after that settlement (settle, then publish).
 */
export function grantWalletOwnershipQuery(orgId: string) {
  return new QueryBuilder()
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .as("grant_wallet_parent");
}

export function requireGrantOwnership(
  subscription: { id: string } | undefined,
  wallet: { orgId: string } | undefined,
) {
  if (!subscription || !wallet) {
    throw new Error("Paid member grant lost its subscription or wallet owner");
  }
}
