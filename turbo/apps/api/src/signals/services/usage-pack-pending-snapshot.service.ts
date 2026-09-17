import {
  usagePackPendingSnapshotGuards,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { asc, eq, inArray, or } from "drizzle-orm";

import type { ApiDb, Tx } from "../../lib/db-types";
import { lockBillingPurchaseOrg } from "./billing-purchase-lock.service";

function isPending(status: string): boolean {
  return status === "checkout_pending" || status === "purchase_pending";
}

async function lockPendingSnapshotOrgs(
  tx: Tx,
  orgIds: readonly string[],
  referencedSubscriptionIds: readonly string[],
) {
  const orderedOrgIds = [...new Set(orgIds)].sort();
  if (orderedOrgIds.length === 0) {
    throw new Error("Usage pack writes require an organization scope");
  }
  for (const orgId of orderedOrgIds) {
    await lockBillingPurchaseOrg(tx, orgId);
  }
  // Outgoing lifecycle writers lock the subscription before their AFTER
  // trigger locks the guard. Lock all existing roots before any guard, also
  // covering transactions that retire several grandfathered snapshots.
  const roots = await tx
    .select({
      id: usagePackSubscriptions.id,
      orgId: usagePackSubscriptions.orgId,
    })
    .from(usagePackSubscriptions)
    .where(
      or(
        inArray(usagePackSubscriptions.orgId, orderedOrgIds),
        inArray(usagePackSubscriptions.id, referencedSubscriptionIds),
      ),
    )
    .orderBy(asc(usagePackSubscriptions.id))
    .for("update");
  if (
    roots.some((root) => {
      return !orderedOrgIds.includes(root.orgId);
    })
  ) {
    throw new Error("Usage pack subscription moved outside its locked scope");
  }
  const guards: (typeof usagePackPendingSnapshotGuards.$inferSelect)[] = [];
  for (const orgId of orderedOrgIds) {
    await tx
      .insert(usagePackPendingSnapshotGuards)
      .values({ orgId, pendingSnapshotCount: 0 })
      .onConflictDoNothing();
    const [guard] = await tx
      .select()
      .from(usagePackPendingSnapshotGuards)
      .where(eq(usagePackPendingSnapshotGuards.orgId, orgId))
      .for("update");
    if (!guard) {
      throw new Error(
        "Usage pack pending snapshot guard disappeared while locking",
      );
    }
    guards.push(guard);
  }
  return { orderedOrgIds, guards };
}

async function snapshotRows(tx: Tx, orgIds: readonly string[]) {
  return await tx
    .select({
      id: usagePackSubscriptions.id,
      orgId: usagePackSubscriptions.orgId,
      status: usagePackSubscriptions.subscriptionStatus,
    })
    .from(usagePackSubscriptions)
    .where(inArray(usagePackSubscriptions.orgId, orgIds));
}

type SnapshotRow = Awaited<ReturnType<typeof snapshotRows>>[number];

function pendingRows(rows: readonly SnapshotRow[], orgId: string) {
  return rows.filter((row) => {
    return row.orgId === orgId && isPending(row.status);
  });
}

async function persistPendingCounts(
  tx: Tx,
  orgIds: readonly string[],
  rows: readonly SnapshotRow[],
) {
  for (const orgId of orgIds) {
    await tx
      .update(usagePackPendingSnapshotGuards)
      .set({ pendingSnapshotCount: pendingRows(rows, orgId).length })
      .where(eq(usagePackPendingSnapshotGuards.orgId, orgId));
  }
}

/**
 * Own the complete subscription mutation transaction. Scope both organizations
 * for a move, and enter before taking subscription/allocation/metadata locks.
 * Existing usage_pack_billing advisory locks, when needed, precede this call.
 * Every subscription written by the callback must belong to this scope.
 * Supply IDs loaded before the transaction so concurrent organization moves
 * are rejected before taking guards or executing the callback.
 */
export async function writeUsagePackPendingSnapshots<T>(
  db: Pick<ApiDb, "transaction">,
  orgIds: readonly string[],
  write: (tx: Tx) => Promise<T>,
  referencedSubscriptionIds: readonly string[] = [],
): Promise<T> {
  return await db.transaction(async (tx) => {
    const { orderedOrgIds, guards } = await lockPendingSnapshotOrgs(
      tx,
      orgIds,
      referencedSubscriptionIds,
    );
    const before = await snapshotRows(tx, orderedOrgIds);
    for (const guard of guards) {
      if (
        guard.pendingSnapshotCount !== pendingRows(before, guard.orgId).length
      ) {
        throw new Error("Usage pack pending snapshot guard requires repair");
      }
    }

    const result = await write(tx);
    const after = await tx
      .select({
        id: usagePackSubscriptions.id,
        orgId: usagePackSubscriptions.orgId,
        status: usagePackSubscriptions.subscriptionStatus,
      })
      .from(usagePackSubscriptions)
      .where(
        or(
          inArray(usagePackSubscriptions.orgId, orderedOrgIds),
          inArray(
            usagePackSubscriptions.id,
            before.map((row) => {
              return row.id;
            }),
          ),
        ),
      );
    if (
      after.some((row) => {
        return !orderedOrgIds.includes(row.orgId);
      })
    ) {
      throw new Error("Usage pack subscription moved outside its locked scope");
    }
    for (const orgId of orderedOrgIds) {
      const prior = new Set(
        pendingRows(before, orgId).map((row) => {
          return row.id;
        }),
      );
      const pending = pendingRows(after, orgId);
      if (
        pending.length > 1 &&
        pending.some((row) => {
          return !prior.has(row.id);
        })
      ) {
        throw new Error(
          "Another usage-pack purchase is already pending for this organization",
        );
      }
    }
    // The retained trigger may already have changed the count. Assign the
    // verified final state; never repeat its increment/decrement or probe its
    // presence to choose which writer owns the side effect.
    await persistPendingCounts(tx, orderedOrgIds, after);
    return result;
  });
}

/** Explicit repair/backfill entry point; preserves grandfathered pending rows. */
export async function repairUsagePackPendingSnapshotGuards(
  db: Pick<ApiDb, "transaction">,
  orgIds: readonly string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const { orderedOrgIds } = await lockPendingSnapshotOrgs(tx, orgIds, []);
    await persistPendingCounts(
      tx,
      orderedOrgIds,
      await snapshotRows(tx, orgIds),
    );
  });
}
