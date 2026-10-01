import {
  piStableContextArtifacts,
  piStableContextGenerations,
  piStableContextHeads,
  piStableContextPublications,
} from "@okouai/db/schema/pi-stable-context";
import { asc, eq, type SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

async function deleteStableContextGenerations(
  tx: Tx,
  condition: SQL,
): Promise<void> {
  await tx
    .select({
      orgId: piStableContextGenerations.orgId,
      agentId: piStableContextGenerations.agentId,
      subject: piStableContextGenerations.subject,
    })
    .from(piStableContextGenerations)
    .where(condition)
    .orderBy(
      asc(piStableContextGenerations.orgId),
      asc(piStableContextGenerations.agentId),
      asc(piStableContextGenerations.subject),
    )
    .for("update");
  await tx.delete(piStableContextGenerations).where(condition);
}

async function deleteStableContextHeads(tx: Tx, condition: SQL): Promise<void> {
  await tx
    .select({ id: piStableContextHeads.id })
    .from(piStableContextHeads)
    .where(condition)
    .orderBy(asc(piStableContextHeads.id))
    .for("update");
  await tx.delete(piStableContextHeads).where(condition);
}

export async function deleteAgentStableContextLifecycleData(
  tx: Tx,
  agentId: string,
): Promise<void> {
  await deleteStableContextGenerations(
    tx,
    eq(piStableContextGenerations.agentId, agentId),
  );
  await tx
    .delete(piStableContextPublications)
    .where(eq(piStableContextPublications.agentId, agentId));
  await deleteStableContextHeads(tx, eq(piStableContextHeads.agentId, agentId));
  await tx
    .delete(piStableContextArtifacts)
    .where(eq(piStableContextArtifacts.agentId, agentId));
}
