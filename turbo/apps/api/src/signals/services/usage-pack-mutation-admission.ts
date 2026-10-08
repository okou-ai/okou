import {
  usagePackAllocationChanges,
  usagePackInvitationPurchases,
  usagePackSubscriptionChanges,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { sql } from "drizzle-orm";

/**
 * Existing business operations retain admission until their provider result is
 * reconciled. This is an observed financial eligibility predicate, not a
 * cross-table mutex. Accepted transitions also qualify their real owned state;
 * paid publication uses receipt identity and conditional source/grant writes.
 * A completed or scheduled result is not an in-flight mutation claim.
 */
export function conflictingUsagePackMutationSql(input: {
  readonly subscriptionId: string;
  readonly planChangeId?: string;
  readonly allocationChangeId?: string;
  readonly invitationPurchaseId?: string;
}) {
  return sql`SELECT 1 FROM (
    (SELECT ${usagePackSubscriptionChanges.id} FROM ${usagePackSubscriptionChanges}
      WHERE ${usagePackSubscriptionChanges.usagePackSubscriptionId} = ${input.subscriptionId}
        AND ${usagePackSubscriptionChanges.status} IN ('applying', 'pending_payment')
        AND ${usagePackSubscriptionChanges.id} IS DISTINCT FROM ${input.planChangeId ?? null}::uuid
      LIMIT 1)
    UNION ALL
    (SELECT ${usagePackAllocationChanges.id} FROM ${usagePackAllocationChanges}
      WHERE ${usagePackAllocationChanges.usagePackSubscriptionId} = ${input.subscriptionId}
        AND ${usagePackAllocationChanges.subscriptionChangeId} IS NULL
        AND ${usagePackAllocationChanges.status} IN ('applying', 'pending_payment')
        AND ${usagePackAllocationChanges.id} IS DISTINCT FROM ${input.allocationChangeId ?? null}::uuid
      LIMIT 1)
    UNION ALL
    (SELECT ${usagePackInvitationPurchases.id} FROM ${usagePackInvitationPurchases}
      WHERE ${usagePackInvitationPurchases.usagePackSubscriptionId} = ${input.subscriptionId}
        AND ${usagePackInvitationPurchases.status} IN ('activating', 'refunding')
        AND ${usagePackInvitationPurchases.id} IS DISTINCT FROM ${input.invitationPurchaseId ?? null}::uuid
      LIMIT 1)
  ) AS active_mutations LIMIT 1`;
}

/**
 * A plain owned-parent expression for an invitation's conditional status write.
 * It validates subscription/organization reference integrity without a row lock
 * or a global admission key.
 */
export function invitationMutationSubscriptionSql(purchaseId: string) {
  return sql`SELECT ${usagePackSubscriptions.id} FROM ${usagePackSubscriptions}
    JOIN ${usagePackInvitationPurchases}
      ON ${usagePackInvitationPurchases.usagePackSubscriptionId} = ${usagePackSubscriptions.id}
      AND ${usagePackInvitationPurchases.orgId} = ${usagePackSubscriptions.orgId}
    WHERE ${usagePackInvitationPurchases.id} = ${purchaseId}`;
}
