import { piMemoryPhase2Checkpoints } from "@okouai/db/schema/pi-memory-phase2-checkpoint";
import { and, eq } from "drizzle-orm";

import type { ApiDb, Tx } from "../../lib/db-types";

type PublicationReceipt = typeof piMemoryPhase2Checkpoints.$inferInsert;

export function piMemoryPhase2PublicationCondition(
  binding: Omit<PublicationReceipt, "versionId" | "createdAt">,
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

export async function findPiMemoryPhase2Publication(
  db: ApiDb | Tx,
  binding: Omit<PublicationReceipt, "versionId" | "createdAt">,
): Promise<typeof piMemoryPhase2Checkpoints.$inferSelect | undefined> {
  const [receipt] = await db
    .select()
    .from(piMemoryPhase2Checkpoints)
    .where(piMemoryPhase2PublicationCondition(binding))
    .limit(1);
  return receipt;
}
