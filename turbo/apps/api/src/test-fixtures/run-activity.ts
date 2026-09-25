import { agentRuns } from "@okouai/db/runtime/agent-run";
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

/** Runs created by an older API during rollout have no active row. */
export async function deleteActiveAgentRunFixture(runId: string) {
  await db().delete(activeAgentRuns).where(eq(activeAgentRuns.runId, runId));
}

/**
 * Give a run an active row whose heartbeat is older than the inactivity sweep
 * threshold. For a terminal run this reproduces a row its terminal transition
 * missed; no production API can leave one behind.
 */
export async function staleActiveAgentRunFixture(runId: string) {
  const [run] = await db()
    .select({ orgId: agentRuns.orgId, userId: agentRuns.userId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  if (!run) {
    throw new Error("Missing agent run");
  }
  const lastHeartbeatAt = sql`(statement_timestamp() AT TIME ZONE 'UTC') - interval '11 minutes'`;
  await db()
    .insert(activeAgentRuns)
    .values({ runId, ...run, lastHeartbeatAt })
    .onConflictDoUpdate({
      target: activeAgentRuns.runId,
      set: { lastHeartbeatAt },
    });
}

/** Active-row bookkeeping is not exposed through public responses. */
export async function readActiveAgentRunFixture(runId: string) {
  const [row] = await db()
    .select({
      activityEntries: activeAgentRuns.activityEntries,
      summary: activeAgentRuns.summary,
      claimId: activeAgentRuns.claimId,
    })
    .from(activeAgentRuns)
    .where(eq(activeAgentRuns.runId, runId));
  return row;
}
