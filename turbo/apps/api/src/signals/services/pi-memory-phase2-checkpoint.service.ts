import { piMemoryPhase2Checkpoints } from "@okouai/db/schema/pi-memory-phase2-checkpoint";
import { and, eq } from "drizzle-orm";

import type { ApiDb, Tx } from "../../lib/db-types";

type CheckpointReceipt = typeof piMemoryPhase2Checkpoints.$inferInsert;

export function piMemoryPhase2CheckpointCondition(
  binding: Omit<CheckpointReceipt, "versionId" | "createdAt">,
) {
  return and(
    eq(piMemoryPhase2Checkpoints.runId, binding.runId),
    eq(piMemoryPhase2Checkpoints.memoryStorageId, binding.memoryStorageId),
    eq(piMemoryPhase2Checkpoints.orgId, binding.orgId),
    eq(piMemoryPhase2Checkpoints.userId, binding.userId),
    eq(piMemoryPhase2Checkpoints.leaseToken, binding.leaseToken),
    eq(piMemoryPhase2Checkpoints.claimedRevision, binding.claimedRevision),
    eq(
      piMemoryPhase2Checkpoints.claimedBaseVersionId,
      binding.claimedBaseVersionId,
    ),
    eq(piMemoryPhase2Checkpoints.selectionDigest, binding.selectionDigest),
  );
}

export async function findPiMemoryPhase2Checkpoint(
  db: ApiDb | Tx,
  binding: Omit<CheckpointReceipt, "versionId" | "createdAt">,
): Promise<typeof piMemoryPhase2Checkpoints.$inferSelect | undefined> {
  const [receipt] = await db
    .select()
    .from(piMemoryPhase2Checkpoints)
    .where(piMemoryPhase2CheckpointCondition(binding))
    .limit(1);
  return receipt;
}

/** Called only inside the generic commit transaction, after validation/fencing. */
export async function recordPiMemoryPhase2Checkpoint(
  tx: Tx,
  receipt: CheckpointReceipt,
): Promise<void> {
  await tx.insert(piMemoryPhase2Checkpoints).values(receipt);
}
