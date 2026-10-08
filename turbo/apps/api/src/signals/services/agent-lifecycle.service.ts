import {
  storagePublicationGenerations,
  storagePublicationTokens,
} from "@okouai/db/schema/storage-publication-fence";
import { asc, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

/** Remove an Agent's non-FK storage publication fence rows. */
export async function deleteAgentPublicationFences(
  tx: Tx,
  agentId: string,
): Promise<void> {
  const condition = eq(storagePublicationGenerations.agentId, agentId);
  await tx
    .select({
      orgId: storagePublicationGenerations.orgId,
      agentId: storagePublicationGenerations.agentId,
      subject: storagePublicationGenerations.subject,
    })
    .from(storagePublicationGenerations)
    .where(condition)
    .orderBy(
      asc(storagePublicationGenerations.orgId),
      asc(storagePublicationGenerations.agentId),
      asc(storagePublicationGenerations.subject),
    )
    .for("update");
  await tx.delete(storagePublicationGenerations).where(condition);
  await tx
    .delete(storagePublicationTokens)
    .where(eq(storagePublicationTokens.agentId, agentId));
}
