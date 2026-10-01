import {
  getInstructionsStorageName,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { storages } from "@okouai/db/schema/storage";
import { and, asc, eq, inArray, or } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

interface LockedAgentInstructionsStorage {
  readonly id: string;
  readonly s3Prefix: string;
}

export async function lockAgentInstructionsStoragesInTransaction(
  tx: Tx,
  targets: readonly {
    readonly orgId: string;
    readonly agentName: string;
  }[],
): Promise<readonly LockedAgentInstructionsStorage[]> {
  if (targets.length === 0) {
    return [];
  }
  const targetCondition = or(
    ...targets.map((target) => {
      return and(
        eq(storages.orgId, target.orgId),
        eq(storages.name, getInstructionsStorageName(target.agentName)),
      );
    }),
  );
  if (!targetCondition) {
    throw new Error("Agent instructions Storage lock condition is empty");
  }
  // GC and publication own Storage parents in ascending UUID order before any
  // artifact or retention edge. Lifecycle deletion must prelock its complete
  // Storage set in that same order before deleting stable-context artifacts;
  // deleting one Agent at a time would instead inherit Agent UUID order.
  return await tx
    .select({ id: storages.id, s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(and(eq(storages.userId, VOLUME_ORG_USER_ID), targetCondition))
    .orderBy(asc(storages.id))
    .for("update");
}

export async function removeLockedAgentInstructionsStoragesInTransaction(
  tx: Tx,
  lockedStorages: readonly LockedAgentInstructionsStorage[],
): Promise<void> {
  if (lockedStorages.length === 0) {
    return;
  }
  await tx.delete(storages).where(
    inArray(
      storages.id,
      lockedStorages.map((storage) => {
        return storage.id;
      }),
    ),
  );
}

export async function removeAgentInstructionsStorageInTransaction(
  tx: Tx,
  args: { readonly orgId: string; readonly agentName: string },
): Promise<string | null> {
  const lockedStorages = await lockAgentInstructionsStoragesInTransaction(tx, [
    args,
  ]);
  await removeLockedAgentInstructionsStoragesInTransaction(tx, lockedStorages);
  return lockedStorages[0]?.s3Prefix ?? null;
}
