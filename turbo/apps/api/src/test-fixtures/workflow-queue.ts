import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "../lib/db";

export async function readWorkflowRunTriggerSourceFixture(
  runId: string,
): Promise<string | null> {
  const [run] = await db()
    .select({ triggerSource: agentRuns.triggerSource })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  return run?.triggerSource ?? null;
}
