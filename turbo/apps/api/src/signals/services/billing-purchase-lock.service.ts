import { sql } from "drizzle-orm";

import type { Db } from "../external/db";

/** Outgoing Plan and usage-pack writers still require this shared boundary. */
export function billingPurchaseCompatibilityLockSql(orgId: string) {
  // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing_purchase:${orgId}`}, 0))`;
}

/**
 * Wait for any outgoing purchase writer that currently holds billing_purchase.
 *
 * Outgoing writers list, create and pay Stripe subscriptions inside that
 * section. Current writers create their subscription first, pass this barrier
 * and only then read Stripe for competing purchases, so an outgoing section
 * that began earlier is visible and one that begins later observes ours. The
 * transaction performs no other statement; remove it once no deployed writer
 * holds the key across provider I/O.
 */
export async function awaitBillingPurchaseCompatibilityBarrier(
  db: Pick<Db, "transaction">,
  orgId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(billingPurchaseCompatibilityLockSql(orgId));
  });
}
