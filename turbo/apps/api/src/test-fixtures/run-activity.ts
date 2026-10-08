import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db";

/** Infrastructure-only time passage for the summary lease and cooldown. */
export async function advanceRunActivityClockFixture(
  runId: string,
  milliseconds: number,
): Promise<void> {
  await db()
    .update(activeAgentRuns)
    .set({
      nextAttemptAt: sql`${activeAgentRuns.nextAttemptAt} - ${milliseconds} * interval '1 millisecond'`,
      claimExpiresAt: sql`${activeAgentRuns.claimExpiresAt} - ${milliseconds} * interval '1 millisecond'`,
    })
    .where(eq(activeAgentRuns.runId, runId));
}
