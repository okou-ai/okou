import { piMemoryPhase2PublicationReceipts } from "@okouai/db/schema/pi-memory-phase2-publication-receipt";
import { and, eq } from "drizzle-orm";

import type { ApiDb, Tx } from "../../lib/db-types";

type PublicationReceipt = typeof piMemoryPhase2PublicationReceipts.$inferInsert;

export function piMemoryPhase2PublicationCondition(
  binding: Omit<PublicationReceipt, "versionId" | "createdAt">,
) {
  return and(
    eq(piMemoryPhase2PublicationReceipts.runId, binding.runId),
    eq(
      piMemoryPhase2PublicationReceipts.memoryStorageId,
      binding.memoryStorageId,
    ),
    eq(piMemoryPhase2PublicationReceipts.orgId, binding.orgId),
    eq(piMemoryPhase2PublicationReceipts.userId, binding.userId),
    eq(piMemoryPhase2PublicationReceipts.leaseToken, binding.leaseToken),
    eq(
      piMemoryPhase2PublicationReceipts.claimedRevision,
      binding.claimedRevision,
    ),
    eq(
      piMemoryPhase2PublicationReceipts.claimedBaseVersionId,
      binding.claimedBaseVersionId,
    ),
    eq(
      piMemoryPhase2PublicationReceipts.selectionDigest,
      binding.selectionDigest,
    ),
  );
}

export async function findPiMemoryPhase2Publication(
  db: ApiDb | Tx,
  binding: Omit<PublicationReceipt, "versionId" | "createdAt">,
): Promise<typeof piMemoryPhase2PublicationReceipts.$inferSelect | undefined> {
  const [receipt] = await db
    .select()
    .from(piMemoryPhase2PublicationReceipts)
    .where(piMemoryPhase2PublicationCondition(binding))
    .limit(1);
  return receipt;
}
