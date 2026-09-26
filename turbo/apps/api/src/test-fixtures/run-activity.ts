import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRuns } from "@okouai/db/runtime/agent-run";
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

/** Simulate a run whose active row has already been released. */
export async function deleteActiveAgentRunFixture(runId: string) {
  await db().delete(activeAgentRuns).where(eq(activeAgentRuns.runId, runId));
}

/** Active-row bookkeeping is not exposed through public responses. */
export async function readActiveAgentRunFixture(runId: string) {
  const [row] = await db()
    .select({
      activityEntries: activeAgentRuns.activityEntries,
      summary: activeAgentRuns.summary,
      claimId: activeAgentRuns.claimId,
      chatThreadId: activeAgentRuns.chatThreadId,
      lastHeartbeatAt: activeAgentRuns.lastHeartbeatAt,
    })
    .from(activeAgentRuns)
    .where(eq(activeAgentRuns.runId, runId));
  return row;
}

/** Contract-only observation: the retained row must no longer receive heartbeats. */
export async function readRetainedRunHeartbeatFixture(runId: string) {
  const [row] = await db()
    .select({ lastHeartbeatAt: agentRuns.lastHeartbeatAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  return row?.lastHeartbeatAt;
}
