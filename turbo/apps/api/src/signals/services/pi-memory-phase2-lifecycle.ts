import { agentRuns } from "@okouai/db/runtime/agent-run";
import { piMemoryPhase2Jobs } from "@okouai/db/runtime/pi-memory-phase2-job";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

/** Publication settles the Job before this exact Run stops executing. */
export function publishedPiMemoryPhase2RunProtection() {
  return new QueryBuilder()
    .select({ id: piMemoryPhase2Jobs.memoryStorageId })
    .from(piMemoryPhase2Jobs)
    .innerJoin(
      agentRunCallbacks,
      and(
        eq(agentRunCallbacks.runId, agentRuns.id),
        eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
      ),
    )
    .where(
      and(
        inArray(agentRuns.status, ["pending", "running"]),
        isNull(agentRuns.chatThreadId),
        eq(sql`${agentRuns.launchSnapshot}->>'framework'`, "pi"),
        eq(piMemoryPhase2Jobs.orgId, agentRuns.orgId),
        eq(piMemoryPhase2Jobs.userId, agentRuns.userId),
        eq(piMemoryPhase2Jobs.lastMaintenanceRunId, agentRuns.id),
        inArray(piMemoryPhase2Jobs.lastMaintenanceOutcome, [
          "published",
          "no_diff",
        ]),
        eq(sql`${agentRunCallbacks.payload}->>'orgId'`, agentRuns.orgId),
        eq(sql`${agentRunCallbacks.payload}->>'userId'`, agentRuns.userId),
        eq(
          sql`${agentRunCallbacks.payload}->>'memoryStorageId'`,
          sql`${piMemoryPhase2Jobs.memoryStorageId}::text`,
        ),
        eq(
          sql`${agentRunCallbacks.payload}->>'claimedRevision'`,
          sql`${piMemoryPhase2Jobs.lastMaintenanceRevision}::text`,
        ),
        eq(
          sql`${agentRunCallbacks.payload}->>'claimedBaseVersionId'`,
          piMemoryPhase2Jobs.lastMaintenanceBaseVersionId,
        ),
        eq(
          sql`${agentRunCallbacks.payload}->>'selectionDigest'`,
          piMemoryPhase2Jobs.lastMaintenanceSelectionDigest,
        ),
      ),
    );
}
