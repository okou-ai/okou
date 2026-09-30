import { agentRuns } from "@okouai/db/runtime/agent-run";
import { userCache } from "@okouai/db/schema/user-cache";
import { users } from "@okouai/db/schema/user";
import { workflows } from "@okouai/db/schema/workflow";
import { count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { nowDate } from "../lib/time";
const waiterCountRowSchema = z.object({ waiterCount: z.int() });

export async function clearResultEmailUserStateFixture(
  userId: string,
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.delete(userCache).where(eq(userCache.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
}

export async function readResultEmailPreferenceFixture(
  userId: string,
): Promise<boolean | null> {
  const [preference] = await db()
    .select({ emailUnsubscribed: users.emailUnsubscribed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return preference?.emailUnsubscribed ?? null;
}

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

interface HeldResultEmailClaimBoundary {
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly blockedChainCount: () => Promise<number>;
}
