import { PI_MEMORY_ROOT } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { piMemoryPhase2Jobs } from "@okouai/db/runtime/pi-memory-phase2-job";
import { and, eq, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

/** A terminal output is immutable; cancellation additionally owns a recovery barrier. */
function finalizedPrivateMaintenanceOutput() {
  return sql`(SELECT ${agentRuns.id} WHERE ${and(
    inArray(agentRuns.status, ["completed", "failed", "cancelled"]),
    or(
      ne(agentRuns.status, "cancelled"),
      isNull(agentRuns.cancellationRecoveryCompleted),
      eq(agentRuns.cancellationRecoveryCompleted, true),
    ),
    eq(agentRuns.framework, "pi"),
    eq(agentRuns.frameworkSessionId, sql`${agentRuns.id}::text`),
    isNull(agentRuns.legacyConversationHistoryHash),
    or(
      and(
        eq(sql`${agentRuns.result}->>'framework'`, "pi"),
        eq(
          sql`${agentRuns.result}->>'frameworkSessionId'`,
          sql`${agentRuns.id}::text`,
        ),
      ),
      // The prepared outgoing API commits the native mirrors and exact
      // storage receipt together, but its result still carries legacy IDs.
      // It can finish after migration; native-only writers never use this.
      // Remove after outgoing API/finalizer drain and projection of their late
      // terminal receipts in #37970's physical contraction.
      and(
        sql`${agentRuns.launchSnapshot}->>'schemaVersion' <> '5'`,
        sql`NOT (${agentRuns.result} ?| ARRAY['framework', 'frameworkSessionId'])`,
        sql`jsonb_typeof(${agentRuns.result}->'agentSessionId') = 'string'`,
        sql`jsonb_typeof(${agentRuns.result}->'conversationId') = 'string'`,
      ),
    ),
    sql`${agentRuns.result}->'storageOutputs' @> jsonb_build_array(jsonb_build_object('name', 'memory', 'mountPath', ${PI_MEMORY_ROOT}::text))`,
  )})`;
}

/**
 * Check every original private callback, including overlap created by an older
 * worker. Failed/cancelled Runs without final output still accept recovery;
 * timeout closes that endpoint, and actual Run deletion closes all its callers.
 * Time elapsed, a cleared Job lease and a terminal status alone do not admit B.
 */
export function unfinishedPiMemoryPhase2Runs() {
  return new QueryBuilder()
    .select({ id: agentRuns.id })
    .from(agentRunCallbacks)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunCallbacks.runId))
    .where(
      and(
        eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
        eq(
          sql`${agentRunCallbacks.payload}->>'memoryStorageId'`,
          sql`${piMemoryPhase2Jobs.memoryStorageId}::text`,
        ),
        eq(
          sql`${agentRunCallbacks.payload}->>'orgId'`,
          piMemoryPhase2Jobs.orgId,
        ),
        eq(
          sql`${agentRunCallbacks.payload}->>'userId'`,
          piMemoryPhase2Jobs.userId,
        ),
        eq(agentRuns.orgId, piMemoryPhase2Jobs.orgId),
        eq(agentRuns.userId, piMemoryPhase2Jobs.userId),
        isNull(agentRuns.chatThreadId),
        eq(sql`${agentRuns.launchSnapshot}->>'framework'`, "pi"),
        ne(agentRuns.status, "timeout"),
        notExists(finalizedPrivateMaintenanceOutput()),
      ),
    );
}

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
