import { agentRuns } from "@okouai/db/runtime/agent-run";
import { blobs } from "@okouai/db/schema/blob";
import {
  deleteLockedRuns,
  deleteRunConversations,
  releaseDeletedConversationReferences,
} from "../signals/services/conversation-history-deletion.service";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

/** Deletes one run root without invoking a global maintenance sweep. */
export async function deleteAgentRunRootFixture(runId: string): Promise<void> {
  await db().transaction(async (tx) => {
    const runs = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .for("update");
    const ids = runs.map((run) => {
      return run.id;
    });
    const removed = await deleteRunConversations(tx, ids);
    await deleteLockedRuns(tx, ids);
    await releaseDeletedConversationReferences(tx, removed);
  });
}

/** Moves a run to a deterministic position in an oldest-first test sweep. */
export async function setAgentRunCreatedAtFixture(
  runId: string,
  createdAt: Date,
): Promise<void> {
  await db()
    .update(agentRuns)
    .set({ createdAt })
    .where(eq(agentRuns.id, runId));
}

/** Infrastructure-only observation: no production endpoint exposes the ledger. */
export async function readHistoryBlobReferenceCountFixture(
  hash: string,
): Promise<number | null> {
  const [row] = await db()
    .select({ count: blobs.refCount })
    .from(blobs)
    .where(eq(blobs.hash, hash));
  return row?.count ?? null;
}
