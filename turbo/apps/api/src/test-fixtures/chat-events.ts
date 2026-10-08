import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";

/**
 * Mark one claimed run timed out without completing its terminal side effects.
 * This isolates the interval where cleanup has recorded uncertainty but the
 * Runner has not yet reported process exit and teardown through `/complete`.
 */
export async function timeoutRunWithoutCallbacksFixture(args: {
  readonly runId: string;
}): Promise<void> {
  const updated = await db()
    .update(agentRuns)
    .set({
      status: "timeout",
      completedAt: nowDate(),
      error: "Run timed out (no heartbeat)",
    })
    .where(and(eq(agentRuns.id, args.runId), eq(agentRuns.status, "running")))
    .returning({ id: agentRuns.id });
  if (updated.length !== 1) {
    throw new Error("Expected one running run to time out without callbacks");
  }
}
