import { agentRuns } from "@okouai/db/runtime/agent-run";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { command, computed } from "ccstate";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { startMaintenanceRun$ } from "./pi-memory-maintenance-execution.service";

import { dispatchRunCallbacks$ } from "./agent-run-callback.service";

import {
  claimPiMemoryPhase2Job,
  failPiMemoryPhase2Job$,
  PI_MEMORY_PHASE2_LEASE_DURATION_MS,
  type ClaimedPiMemoryPhase2Job,
  type PiMemoryPhase2OwnerScope,
} from "./pi-memory-phase2-job.service";
const log = logger("PiMemoryPhase2Worker");

export type PiMemoryPhase2WorkerResult =
  | { readonly outcome: "no_work" }
  | { readonly outcome: "dispatched"; readonly runId: string }
  | { readonly outcome: "stale" }
  | { readonly outcome: "failed"; readonly errorClass: string };

function claimFence(claim: ClaimedPiMemoryPhase2Job, currentTime: Date) {
  return {
    memoryStorageId: claim.memoryStorageId,
    orgId: claim.orgId,
    userId: claim.userId,
    leaseToken: claim.leaseToken,
    claimedRevision: claim.claimedRevision,
    claimedBaseVersionId: claim.baseVersion.versionId,
    currentTime,
  } as const;
}

const failClaim$ = command(
  async (
    { set },
    claim: ClaimedPiMemoryPhase2Job,
    currentTime: Date,
    errorClass: string,
    signal: AbortSignal,
  ): Promise<PiMemoryPhase2WorkerResult> => {
    const transitioned = await set(
      failPiMemoryPhase2Job$,
      {
        ...claimFence(claim, currentTime),
        expectedMaintenanceRunId: null,
        errorClass,
      },
      signal,
    );
    return transitioned
      ? { outcome: "failed", errorClass }
      : { outcome: "stale" };
  },
);

function createPiMemoryPhase2RecoveryCandidate(
  scope?: PiMemoryPhase2OwnerScope,
) {
  return computed(async (get) => {
    const db = get(db$);
    const [job] = await db
      .select({
        memoryStorageId: piMemoryPhase2Jobs.memoryStorageId,
        orgId: piMemoryPhase2Jobs.orgId,
        userId: piMemoryPhase2Jobs.userId,
        leaseToken: piMemoryPhase2Jobs.leaseToken,
        sandboxLeaseToken: piMemoryPhase2Jobs.sandboxLeaseToken,
        claimedRevision: piMemoryPhase2Jobs.claimedRevision,
        claimedBaseVersionId: piMemoryPhase2Jobs.claimedBaseVersionId,
        maintenanceRunId: piMemoryPhase2Jobs.maintenanceRunId,
      })
      .from(piMemoryPhase2Jobs)
      .where(
        and(
          eq(piMemoryPhase2Jobs.status, "leased"),
          isNotNull(piMemoryPhase2Jobs.maintenanceRunId),
          ...(scope
            ? [
                eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId),
                eq(piMemoryPhase2Jobs.orgId, scope.orgId),
                eq(piMemoryPhase2Jobs.userId, scope.userId),
              ]
            : []),
        ),
      )
      .orderBy(asc(piMemoryPhase2Jobs.leaseExpiresAt))
      .limit(1);
    return job;
  });
}

function createPiMemoryPhase2Recovery(scope?: PiMemoryPhase2OwnerScope) {
  const leasedJob$ = createPiMemoryPhase2RecoveryCandidate(scope);
  const recoveryRun$ = computed(async (get) => {
    const db = get(db$);
    const job = await get(leasedJob$);
    if (!job?.maintenanceRunId) {
      return undefined;
    }
    const [run] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, job.maintenanceRunId),
          eq(agentRuns.orgId, job.orgId),
          eq(agentRuns.userId, job.userId),
        ),
      )
      .limit(1);
    return run;
  });

  const recoverMaintenanceRun$ = command(
    async (
      { get, set },
      currentTime: Date,
      signal: AbortSignal,
    ): Promise<PiMemoryPhase2WorkerResult | undefined> => {
      const job = await get(leasedJob$);
      signal.throwIfAborted();
      if (
        !job?.maintenanceRunId ||
        !job.leaseToken ||
        job.sandboxLeaseToken !== job.leaseToken ||
        !job.claimedRevision ||
        !job.claimedBaseVersionId
      ) {
        return undefined;
      }
      const run = await get(recoveryRun$);
      signal.throwIfAborted();
      if (!run) {
        await set(
          failPiMemoryPhase2Job$,
          {
            memoryStorageId: job.memoryStorageId,
            orgId: job.orgId,
            userId: job.userId,
            leaseToken: job.leaseToken,
            claimedRevision: job.claimedRevision,
            claimedBaseVersionId: job.claimedBaseVersionId,
            currentTime,
            expectedMaintenanceRunId: job.maintenanceRunId,
            allowExpiredLease: true,
            errorClass: "maintenance_run_missing",
          },
          signal,
        );
        signal.throwIfAborted();
        return { outcome: "failed", errorClass: "maintenance_run_missing" };
      }
      if (["queued", "pending", "running"].includes(run.status)) {
        const db = set(writeDb$);
        await db
          .update(piMemoryPhase2Jobs)
          .set({
            leaseExpiresAt: new Date(
              currentTime.getTime() + PI_MEMORY_PHASE2_LEASE_DURATION_MS,
            ),
            updatedAt: currentTime,
          })
          .where(
            and(
              eq(piMemoryPhase2Jobs.memoryStorageId, job.memoryStorageId),
              eq(piMemoryPhase2Jobs.maintenanceRunId, job.maintenanceRunId),
              eq(piMemoryPhase2Jobs.leaseToken, job.leaseToken),
              eq(piMemoryPhase2Jobs.sandboxLeaseToken, job.leaseToken),
            ),
          );
        signal.throwIfAborted();
        return { outcome: "dispatched", runId: job.maintenanceRunId };
      }

      const db = set(writeDb$);
      await set(
        dispatchRunCallbacks$,
        {
          db,
          runId: job.maintenanceRunId,
          status: run.status === "completed" ? "completed" : "failed",
          error:
            run.status === "completed"
              ? undefined
              : `Run ended as ${run.status}`,
        },
        signal,
      );
      return { outcome: "dispatched", runId: job.maintenanceRunId };
    },
  );

  return recoverMaintenanceRun$;
}

// Each graph is consumed once per Store. Requests own fresh Stores; callers
// executing another work unit in the same Store construct another graph first.
export function createPiMemoryPhase2Worker(scope?: PiMemoryPhase2OwnerScope) {
  const recoverMaintenanceRun$ = createPiMemoryPhase2Recovery(scope);
  const execute$ = command(
    async (
      { set },
      currentTime: Date,
      signal: AbortSignal,
    ): Promise<PiMemoryPhase2WorkerResult> => {
      const db = set(writeDb$);
      signal.throwIfAborted();
      const recovered = await set(recoverMaintenanceRun$, currentTime, signal);
      signal.throwIfAborted();
      if (recovered) {
        return recovered;
      }
      const claim = await claimPiMemoryPhase2Job(db, { scope, currentTime });
      signal.throwIfAborted();
      if (!claim) {
        return { outcome: "no_work" };
      }
      const dispatched = await settle(
        set(startMaintenanceRun$, claim, signal),
        signal,
      );
      if (dispatched.ok) {
        return typeof dispatched.value === "string"
          ? { outcome: "dispatched", runId: dispatched.value }
          : await set(
              failClaim$,
              claim,
              nowDate(),
              dispatched.value.errorClass,
              signal,
            );
      }
      log.error("Pi memory maintenance run dispatch failed", {
        memoryStorageId: claim.memoryStorageId,
      });
      return await set(
        failClaim$,
        claim,
        nowDate(),
        "maintenance_dispatch_failed",
        signal,
      );
    },
  );

  return { execute$ };
}
