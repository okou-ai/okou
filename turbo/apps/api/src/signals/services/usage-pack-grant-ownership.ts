import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackSubscriptions } from "@okouai/db/schema/usage-pack-subscription";
import { and, eq } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

/** Keep the subscription parent before the wallet and any grant/claim rows. */
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
    .for("update")
    .as("grant_subscription_parent");
}

export function grantWalletOwnershipQuery(orgId: string) {
  return new QueryBuilder()
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .for("update")
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
