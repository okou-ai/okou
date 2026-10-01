import { PiMemoryQuotaError } from "./pi-memory-quota.service";

import { agentRuns } from "@okouai/db/runtime/agent-run";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { command, computed, state } from "ccstate";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import {
  createMaintenanceRunObjects,
  PiMaintenanceDispositionError,
} from "./pi-memory-maintenance-execution.service";

import { dispatchRunCallbacks$ } from "./agent-run-callback.service";
import { PiMemoryPhase2CredentialError } from "./pi-memory-phase2-credential.service";

import {
  claimPiMemoryPhase2Job,
  failPiMemoryPhase2Job,
  PI_MEMORY_PHASE2_LEASE_DURATION_MS,
  type ClaimedPiMemoryPhase2Job,
  type PiMemoryPhase2OwnerScope,
} from "./pi-memory-phase2-job.service";
const log = logger("PiMemoryPhase2Worker");

interface PiMemoryPhase2WorkerInput {
  readonly scope?: PiMemoryPhase2OwnerScope;
  readonly currentTime: Date;
}

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

async function failClaim(
  db: Db,
  claim: ClaimedPiMemoryPhase2Job,
  currentTime: Date,
  errorClass: string,
): Promise<PiMemoryPhase2WorkerResult> {
  const transitioned = await failPiMemoryPhase2Job(db, {
    ...claimFence(claim, currentTime),
    expectedMaintenanceRunId: null,
    errorClass,
  });
  return transitioned
    ? { outcome: "failed", errorClass }
    : { outcome: "stale" };
}

const recoverMaintenanceRun$ = command(
  async (
    { set },
    db: Db,
    input: PiMemoryPhase2WorkerInput,
    signal: AbortSignal,
  ): Promise<PiMemoryPhase2WorkerResult | undefined> => {
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
          ...(input.scope
            ? [
                eq(
                  piMemoryPhase2Jobs.memoryStorageId,
                  input.scope.memoryStorageId,
                ),
                eq(piMemoryPhase2Jobs.orgId, input.scope.orgId),
                eq(piMemoryPhase2Jobs.userId, input.scope.userId),
              ]
            : []),
        ),
      )
      .orderBy(asc(piMemoryPhase2Jobs.leaseExpiresAt))
      .limit(1);
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
    signal.throwIfAborted();
    if (!run) {
      await failPiMemoryPhase2Job(db, {
        memoryStorageId: job.memoryStorageId,
        orgId: job.orgId,
        userId: job.userId,
        leaseToken: job.leaseToken,
        claimedRevision: job.claimedRevision,
        claimedBaseVersionId: job.claimedBaseVersionId,
        currentTime: input.currentTime,
        expectedMaintenanceRunId: job.maintenanceRunId,
        allowExpiredLease: true,
        errorClass: "maintenance_run_missing",
      });
      signal.throwIfAborted();
      return { outcome: "failed", errorClass: "maintenance_run_missing" };
    }
    if (["queued", "pending", "running"].includes(run.status)) {
      await db
        .update(piMemoryPhase2Jobs)
        .set({
          leaseExpiresAt: new Date(
            input.currentTime.getTime() + PI_MEMORY_PHASE2_LEASE_DURATION_MS,
          ),
          updatedAt: input.currentTime,
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

    await set(
      dispatchRunCallbacks$,
      {
        db,
        runId: job.maintenanceRunId,
        status: run.status === "completed" ? "completed" : "failed",
        error:
          run.status === "completed" ? undefined : `Run ended as ${run.status}`,
      },
      signal,
    );
    return { outcome: "dispatched", runId: job.maintenanceRunId };
  },
);

// The claimed job is a write result; its maintenance graph is derived once
// per claim, as the Thread pick derives its claim graph.
const internalClaimedJob$ = state<ClaimedPiMemoryPhase2Job | null>(null);
const claimedMaintenanceRunObjects$ = computed((get) => {
  const claim = get(internalClaimedJob$);
  return claim ? createMaintenanceRunObjects(claim) : null;
});

const dispatchClaim$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<PiMemoryPhase2WorkerResult> => {
    const objects = get(claimedMaintenanceRunObjects$);
    if (!objects) {
      throw new Error("Pi maintenance dispatch requires a claimed job");
    }
    const runId = await set(objects.startRun$, signal);
    return { outcome: "dispatched", runId };
  },
);

export const executePiMemoryPhase2Work$ = command(
  async (
    { set },
    input: PiMemoryPhase2WorkerInput,
    signal: AbortSignal,
  ): Promise<PiMemoryPhase2WorkerResult> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const recovered = await set(recoverMaintenanceRun$, db, input, signal);
    signal.throwIfAborted();
    if (recovered) {
      return recovered;
    }
    const claim = await claimPiMemoryPhase2Job(db, input);
    signal.throwIfAborted();
    if (!claim) {
      return { outcome: "no_work" };
    }
    set(internalClaimedJob$, claim);
    const dispatched = await settle(set(dispatchClaim$, signal), signal);
    if (dispatched.ok) {
      return dispatched.value;
    }
    if (
      dispatched.error instanceof PiMemoryPhase2CredentialError ||
      dispatched.error instanceof PiMemoryQuotaError ||
      dispatched.error instanceof PiMaintenanceDispositionError
    ) {
      return await failClaim(db, claim, nowDate(), dispatched.error.errorClass);
    }
    log.error("Pi memory maintenance run dispatch failed", {
      memoryStorageId: claim.memoryStorageId,
    });
    return await failClaim(db, claim, nowDate(), "maintenance_dispatch_failed");
  },
);
