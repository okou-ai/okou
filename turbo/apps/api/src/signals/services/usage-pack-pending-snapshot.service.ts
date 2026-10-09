import {
  usagePackPendingSnapshotGuards,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { and, eq, inArray, or } from "drizzle-orm";

import type { ApiDb, Tx } from "../../lib/db-types";

/** A concurrent pending-snapshot transition committed first; nothing was written. */
export class UsagePackPendingSnapshotConflict extends Error {}

function isPending(status: string): boolean {
  return status === "checkout_pending" || status === "purchase_pending";
}

async function preparePendingSnapshotScope(
  tx: Tx,
  orgIds: readonly string[],
  referencedSubscriptionIds: readonly string[],
) {
  const orderedOrgIds = [...new Set(orgIds)].sort();
  if (orderedOrgIds.length === 0) {
    throw new Error("Usage pack writes require an organization scope");
  }
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
    );
  if (
    roots.some((root) => {
      return !orderedOrgIds.includes(root.orgId);
    })
  ) {
    throw new Error("Usage pack subscription moved outside its locked scope");
  }
  for (const orgId of orderedOrgIds) {
    await tx
      .insert(usagePackPendingSnapshotGuards)
      .values({ orgId, pendingSnapshotCount: 0 })
      .onConflictDoNothing();
  }
  // READ COMMITTED gives each statement a new snapshot. Read the guard and
  // business rows together so a committed transition cannot look like damage.
  const scope = await tx
    .select({
      guard: usagePackPendingSnapshotGuards,
      snapshot: {
        id: usagePackSubscriptions.id,
        orgId: usagePackSubscriptions.orgId,
        status: usagePackSubscriptions.subscriptionStatus,
      },
    })
    .from(usagePackPendingSnapshotGuards)
    .leftJoin(
      usagePackSubscriptions,
      eq(usagePackSubscriptions.orgId, usagePackPendingSnapshotGuards.orgId),
    )
    .where(inArray(usagePackPendingSnapshotGuards.orgId, orderedOrgIds));
  const guards = orderedOrgIds.map((orgId) => {
    const row = scope.find(({ guard }) => {
      return guard.orgId === orgId;
    });
    if (!row) {
      throw new Error("Usage pack pending snapshot count disappeared");
    }
    return row.guard;
  });
  const snapshots = scope.flatMap(({ snapshot }) => {
    return snapshot ? [snapshot] : [];
  });
  return { orderedOrgIds, guards, snapshots };
}

type SnapshotRow = Awaited<
  ReturnType<typeof preparePendingSnapshotScope>
>["snapshots"][number];

function pendingRows(rows: readonly SnapshotRow[], orgId: string) {
  return rows.filter((row) => {
    return row.orgId === orgId && isPending(row.status);
  });
}

/**
 * Publish an actual business-count change, never a lock-only write. A competing
 * transition that changed the observed count rejects this transaction once;
 * its subscription/allocation writes roll back with the rejected publication.
 */
export async function publishUsagePackPendingSnapshotCount(
  tx: Pick<Tx, "update">,
  orgId: string,
  before: number,
  after: number,
): Promise<void> {
  if (before === after) {
    return;
  }
  const [published] = await tx
    .update(usagePackPendingSnapshotGuards)
    .set({ pendingSnapshotCount: after })
    .where(
      and(
        eq(usagePackPendingSnapshotGuards.orgId, orgId),
        eq(usagePackPendingSnapshotGuards.pendingSnapshotCount, before),
      ),
    )
    .returning({ orgId: usagePackPendingSnapshotGuards.orgId });
  if (!published) {
    throw new UsagePackPendingSnapshotConflict(
      "Usage pack pending snapshot count changed during publication",
    );
  }
}

/**
 * Own the complete subscription mutation transaction. Scope both organizations
 * for a move. Every subscription written by the callback must belong to this
 * scope; callbacks must condition transitions on the business state they read.
 * Subscription roots and count rows are not prelocked. A changed count is
 * published conditionally in the same transaction as the business rows.
 */
export async function writeUsagePackPendingSnapshots<T>(
  db: Pick<ApiDb, "transaction">,
  orgIds: readonly string[],
  write: (tx: Tx) => Promise<T>,
  referencedSubscriptionIds: readonly string[] = [],
): Promise<T> {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0284; new non-billing transactions are prohibited.
  return await db.transaction(async (tx) => {
    const {
      orderedOrgIds,
      guards,
      snapshots: before,
    } = await preparePendingSnapshotScope(
      tx,
      orgIds,
      referencedSubscriptionIds,
    );
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
      await publishUsagePackPendingSnapshotCount(
        tx,
        orgId,
        prior.size,
        pending.length,
      );
    }
    return result;
  });
}

/** Explicit repair/backfill entry point; preserves grandfathered pending rows. */
export async function repairUsagePackPendingSnapshotGuards(
  db: Pick<ApiDb, "transaction">,
  orgIds: readonly string[],
): Promise<void> {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0285; new non-billing transactions are prohibited.
  await db.transaction(async (tx) => {
    const { guards, snapshots } = await preparePendingSnapshotScope(
      tx,
      orgIds,
      [],
    );
    for (const guard of guards) {
      await publishUsagePackPendingSnapshotCount(
        tx,
        guard.orgId,
        guard.pendingSnapshotCount,
        pendingRows(snapshots, guard.orgId).length,
      );
    }
  });
}
