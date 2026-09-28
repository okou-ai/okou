import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { and, eq, gt, inArray, notExists, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import {
  activePiMemoryPhase2MaintenanceRunCondition,
  lockPiMemoryPhase2MaintenanceCleanupProtection,
} from "./pi-memory-phase2-maintenance.service";
import {
  loadPiMemoryPhase2UsageBinding,
  piMemoryPhase2ProviderCondition,
  PI_MEMORY_PHASE2_USAGE_DRAIN_MS,
  PI_MEMORY_PHASE2_MODELS,
} from "./pi-memory-phase2-usage.service";
import type { ThreadlessRunProtection } from "./threadless-run-protection.service";

/**
 * Keeps exact live Phase 2 maintenance leases, and recently completed
 * maintenance Runs whose private usage is still draining, out of generic
 * threadless cleanup and cancellation.
 */
export const piMemoryPhase2ThreadlessRunProtection: ThreadlessRunProtection = {
  sweepEligibility: (db, { currentTime }) => {
    const usageQuietBefore = new Date(
      currentTime.getTime() - PI_MEMORY_PHASE2_USAGE_DRAIN_MS,
    );
    return [
      notExists(
        db
          .select({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId })
          .from(piMemoryPhase2Jobs)
          .where(
            activePiMemoryPhase2MaintenanceRunCondition(db, {
              runId: agentRuns.id,
              orgId: agentRuns.orgId,
              userId: agentRuns.userId,
              currentTime,
            }),
          ),
      ),
      // Do not let retained private billing contexts occupy the bounded
      // sweep and starve ordinary threadless cleanup. Revalidate under lock.
      notExists(
        db
          .select({ id: agentRunCallbacks.id })
          .from(agentRunCallbacks)
          .where(
            and(
              eq(agentRunCallbacks.runId, agentRuns.id),
              eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
              eq(sql`${agentRunCallbacks.payload}->>'orgId'`, agentRuns.orgId),
              eq(
                sql`${agentRunCallbacks.payload}->>'userId'`,
                agentRuns.userId,
              ),
              eq(agentRuns.triggerSource, "agent"),
              piMemoryPhase2ProviderCondition(),
              inArray(agentRuns.selectedModel, [...PI_MEMORY_PHASE2_MODELS]),
              eq(sql`${agentRuns.launchSnapshot}->>'framework'`, "pi"),
              gt(agentRuns.completedAt, usageQuietBefore),
            ),
          ),
      ),
    ];
  },
  lockCancellationProtection: async (tx, run) => {
    return await lockPiMemoryPhase2MaintenanceCleanupProtection(tx, run);
  },
  lockDeletionProtection: async (tx, run) => {
    if (await lockPiMemoryPhase2MaintenanceCleanupProtection(tx, run)) {
      return true;
    }
    return (
      run.completedAt.getTime() >
        nowDate().getTime() - PI_MEMORY_PHASE2_USAGE_DRAIN_MS &&
      (await loadPiMemoryPhase2UsageBinding(tx, run)) !== undefined
    );
  },
};
