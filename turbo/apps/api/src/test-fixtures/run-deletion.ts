import { agentRuns } from "@okouai/db/runtime/agent-run";
import { blobs } from "@okouai/db/schema/blob";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

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
