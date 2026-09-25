import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { and, eq, inArray } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

/** The owner scope a cleanup transaction revokes delivery ownership for. */
type MorningBriefDeliveryRevocationScope =
  | {
      readonly kind: "membership";
      readonly orgId: string;
      readonly userId: string;
    }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  /** One destination thread, removed before its own cascade runs. */
  | { readonly kind: "thread"; readonly chatThreadId: string }
  /** One Agent, removed before its own cascade runs. */
  | { readonly kind: "agent"; readonly agentId: string };

function revocationWhere(scope: MorningBriefDeliveryRevocationScope) {
  if (scope.kind === "membership") {
    return and(
      eq(morningBriefDeliveries.orgId, scope.orgId),
      eq(morningBriefDeliveries.userId, scope.userId),
    );
  }
  if (scope.kind === "user") {
    return eq(morningBriefDeliveries.userId, scope.userId);
  }
  if (scope.kind === "thread") {
    return eq(morningBriefDeliveries.chatThreadId, scope.chatThreadId);
  }
  return scope.kind === "agent"
    ? eq(morningBriefDeliveries.agentId, scope.agentId)
    : eq(morningBriefDeliveries.orgId, scope.orgId);
}

/**
 * Drop this scope's delivery ownership inside a cleanup transaction.
 *
 * Called from the earliest local revocation each cleanup path already commits,
 * alongside collection ownership, and from the Agent and thread deletions
 * themselves. Those two cascade the delivery row away, which would otherwise
 * drop the only association to its still-unsent mail; running this first inside
 * the same deleting transaction is what keeps that content from being
 * orphaned. An unsent native intent still carries the
 * recipient address and the rendered brief, so owner deletion removes the mail
 * itself rather than relying on the drain to refuse an orphan. The delete
 * returns the outbox identities it just detached, so the association and the
 * mail it names are removed in one atomic step: a failure rolls both back and a
 * retry sees the association again. It therefore requires a transaction rather
 * than a bare connection. Rows belonging to other producers and other owners
 * are never touched, and an intent the provider already accepted cannot be
 * retracted — only its local record is removed.
 */
export async function revokeMorningBriefDeliveryOwnership(
  tx: Tx,
  scope: MorningBriefDeliveryRevocationScope,
): Promise<void> {
  const revoked = await tx
    .delete(morningBriefDeliveries)
    .where(revocationWhere(scope))
    .returning({ emailOutboxId: morningBriefDeliveries.emailOutboxId });
  const outboxIds = revoked.flatMap((row) => {
    return row.emailOutboxId === null ? [] : [row.emailOutboxId];
  });
  if (outboxIds.length > 0) {
    await tx.delete(emailOutbox).where(inArray(emailOutbox.id, outboxIds));
  }
}
