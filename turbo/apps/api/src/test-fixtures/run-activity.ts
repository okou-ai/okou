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

/** Active-row bookkeeping is not exposed through public responses. */
export async function readActiveAgentRunFixture(runId: string) {
  const [row] = await db()
    .select({
      activityEntries: activeAgentRuns.activityEntries,
      summary: activeAgentRuns.summary,
      claimId: activeAgentRuns.claimId,
      chatThreadId: activeAgentRuns.chatThreadId,
    })
    .from(activeAgentRuns)
    .where(eq(activeAgentRuns.runId, runId));
  return row;
}

/**
 * Infrastructure-only time passage: age a terminal run's completion and its
 * sandbox's last heartbeat past the cancellation-recovery grace. No API can
 * make a runner fall silent.
 */
export async function ageSilentTerminalRunFixture(runId: string) {
  const past = sql`(statement_timestamp() AT TIME ZONE 'UTC') - interval '10 minutes'`;
  await db()
    .update(agentRuns)
    .set({ completedAt: past })
    .where(eq(agentRuns.id, runId));
  await db()
    .update(activeAgentRuns)
    .set({ lastHeartbeatAt: past })
    .where(eq(activeAgentRuns.runId, runId));
}
