import { createStore } from "ccstate";

import { blobs } from "@okouai/db/schema/blob";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { agentRunList } from "../signals/services/agent-runs.service";
/**
 * Test fixtures for agent-run state that no public route reads or seeds
 * directly. Runs themselves start through the real Thread or Pi entries.
 */

export async function readSessionHistoryBlobRefCountFixture(
  hash: string,
): Promise<number> {
  const [blob] = await db()
    .select({ refCount: blobs.refCount })
    .from(blobs)
    .where(eq(blobs.hash, hash))
    .limit(1);
  if (!blob) {
    throw new Error("Expected the Session history Blob fixture to exist");
  }
  return blob.refCount;
}

export async function listAgentRunsFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly status?: string;
  readonly agent?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}) {
  // Disposable database fixtures replace the pool between operations, so each
  // listing owns its read store instead of retaining a previous db$ binding.
  return await createStore().get(
    agentRunList({
      userId: args.userId,
      orgId: args.orgId,
      status: args.status,
      agent: args.agent,
      since: args.since,
      until: args.until,
      limit: args.limit ?? 50,
    }),
  );
}
