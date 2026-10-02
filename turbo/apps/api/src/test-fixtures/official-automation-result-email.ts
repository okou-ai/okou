import { agentRuns } from "@okouai/db/runtime/agent-run";
import { workflows } from "@okouai/db/schema/workflow";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";

export async function completeResultEmailRunWithoutCallbacksFixture(
  runId: string,
): Promise<void> {
  const rows = await db()
    .update(agentRuns)
    .set({ status: "completed", completedAt: nowDate() })
    .where(eq(agentRuns.id, runId))
    .returning({ id: agentRuns.id });
  if (rows.length !== 1) {
    throw new Error("Expected one result-email Run to complete");
  }
}

export async function markWorkflowAsMorningBriefResultEmailFixture(
  workflowId: string,
): Promise<void> {
  const rows = await db()
    .update(workflows)
    .set({
      name: "morning-brief",
      visibility: "private",
      instruction: null,
      displayName: null,
      description: null,
      officialDefinitionName: "morning-brief",
      officialInstallationState: "installed",
      updatedAt: nowDate(),
    })
    .where(eq(workflows.id, workflowId))
    .returning({ id: workflows.id });
  if (rows.length !== 1) {
    throw new Error(
      "Expected one result-email Workflow to become Morning Brief",
    );
  }
}
