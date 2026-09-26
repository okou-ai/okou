import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { asc, count, eq, inArray } from "drizzle-orm";

import { db } from "../lib/db";

async function readAgentLifecycleIdsFixture(agentId: string): Promise<{
  readonly sessionIds: readonly string[];
  readonly runIds: readonly string[];
}> {
  const sessions = await db()
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.agentId, agentId))
    .orderBy(asc(agentSessions.id));
  const sessionIds = sessions.map((session) => {
    return session.id;
  });
  const runs =
    sessionIds.length === 0
      ? []
      : await db()
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(inArray(agentRuns.sessionId, sessionIds))
          .orderBy(asc(agentRuns.id));
  return {
    sessionIds,
    runIds: runs.map((run) => {
      return run.id;
    }),
  };
}

export async function readAgentLifecycleCountsFixture(
  agentId: string,
): Promise<{
  readonly agents: number;
  readonly sessions: number;
  readonly runs: number;
}> {
  const [agentCount] = await db()
    .select({ value: count() })
    .from(agents)
    .where(eq(agents.id, agentId));
  const lifecycle = await readAgentLifecycleIdsFixture(agentId);
  return {
    agents: agentCount?.value ?? 0,
    sessions: lifecycle.sessionIds.length,
    runs: lifecycle.runIds.length,
  };
}

export async function setAgentRunStatusFixture(
  runId: string,
  status: string,
): Promise<void> {
  const rows = await db()
    .update(agentRuns)
    .set({ status })
    .where(eq(agentRuns.id, runId))
    .returning({ id: agentRuns.id });
  if (rows.length !== 1) {
    throw new Error("Expected one agent Run status to change");
  }
}

export async function readUsageEventRunIdFixture(
  usageEventId: string,
): Promise<string | null> {
  const [row] = await db()
    .select({ runId: usageEvent.runId })
    .from(usageEvent)
    .where(eq(usageEvent.id, usageEventId))
    .limit(1);
  if (!row) {
    throw new Error("Expected the retained usage event fixture row");
  }
  return row.runId;
}
