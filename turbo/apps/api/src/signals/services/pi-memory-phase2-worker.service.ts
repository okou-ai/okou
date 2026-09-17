import {
  checkPiMemoryQuota,
  PiMemoryQuotaError,
} from "./pi-memory-quota.service";
import { checkOrgCreditsForRunAdmission } from "./run-admission.service";
import { piMemoryPhase2SelectionDigest } from "@okouai/pi-agent-runtime/api";
import { PI_MEMORY_ROOT } from "@okouai/api-contracts/contracts/runners";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { command } from "ccstate";
import { and, asc, eq, isNotNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { createAgentRun$ } from "./agent-run-create.service";
import { dispatchRunCallbacks } from "./agent-run-callback.service";
import {
  PiMemoryPhase2CredentialError,
  resolvePiMemoryPhase2Credential,
} from "./pi-memory-phase2-credential.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  claimPiMemoryPhase2Job,
  failPiMemoryPhase2Job,
  PI_MEMORY_PHASE2_LEASE_DURATION_MS,
  type ClaimedPiMemoryPhase2Job,
  type PiMemoryPhase2OwnerScope,
} from "./pi-memory-phase2-job.service";
import { PI_MEMORY_PHASE2_MODEL } from "./pi-memory-phase2-usage.service";

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

async function recoverMaintenanceRun(
  db: Db,
  input: PiMemoryPhase2WorkerInput,
): Promise<PiMemoryPhase2WorkerResult | undefined> {
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
    return { outcome: "dispatched", runId: job.maintenanceRunId };
  }

  await dispatchRunCallbacks(
    db,
    job.maintenanceRunId,
    run.status === "completed" ? "completed" : "failed",
    undefined,
    run.status === "completed" ? undefined : `Run ended as ${run.status}`,
  );
  return { outcome: "dispatched", runId: job.maintenanceRunId };
}

async function checkNewAttemptQuotaAdmission(
  db: Db,
  claim: ClaimedPiMemoryPhase2Job,
  credential: Awaited<ReturnType<typeof resolvePiMemoryPhase2Credential>>,
  signal: AbortSignal,
): Promise<boolean> {
  // Prepare ordinary admission first; quota then sees locally reconciled data.
  // Canonical createAgentRun admission and final transaction remain authoritative.
  const admission = await checkOrgCreditsForRunAdmission({
    db,
    orgId: claim.orgId,
    userId: claim.userId,
    modelProviderType: credential.pin.modelProvider,
    selectedModel: PI_MEMORY_PHASE2_MODEL,
  });
  signal.throwIfAborted();
  if (admission) {
    return false;
  }
  await checkPiMemoryQuota(
    db,
    {
      orgId: claim.orgId,
      userId: claim.userId,
      stage: "phase2",
      source: credential.quota,
    },
    signal,
  );

  return true;
}

const dispatchClaim$ = command(
  async (
    { set },
    input: { readonly db: Db; readonly claim: ClaimedPiMemoryPhase2Job },
    signal: AbortSignal,
  ): Promise<PiMemoryPhase2WorkerResult> => {
    const { db, claim } = input;
    // The claimed job's owner decides, never the cron caller. Off releases
    // the lease with an explicit disposition and dispatches no maintenance run.
    const featureSwitchContext = await loadUserFeatureSwitchContext(
      db,
      claim.orgId,
      claim.userId,
    );
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.PiMemory, featureSwitchContext)) {
      return await failClaim(db, claim, nowDate(), "pi_memory_disabled");
    }
    const credential = await resolvePiMemoryPhase2Credential(db, claim, signal);
    signal.throwIfAborted();

    if (!(await checkNewAttemptQuotaAdmission(db, claim, credential, signal))) {
      return await failClaim(db, claim, nowDate(), "source_admission_denied");
    }

    const selectionDigest = piMemoryPhase2SelectionDigest(claim.selected);
    const maintenance = {
      schemaVersion: 1,
      memoryStorageId: claim.memoryStorageId,
      claimedRevision: claim.claimedRevision,
      claimedBaseVersionId: claim.baseVersion.versionId,
      leaseToken: claim.leaseToken,
      selectionDigest,
      selected: claim.selected.map((candidate) => {
        return {
          ...candidate,
          sourceCompletedAt: candidate.sourceCompletedAt.toISOString(),
        };
      }),
    } as const;
    const result = await set(
      createAgentRun$,
      {
        userId: claim.userId,
        orgId: claim.orgId,
        body: {
          prompt: "Run first-party Pi memory maintenance.",
          triggerSource: "agent",
          artifacts: [
            {
              name: "memory",
              version: claim.baseVersion.versionId,
              mountPath: PI_MEMORY_ROOT,
            },
          ],
        },
        apiStartTime: now(),
        modelProviderType: credential.pin.modelProvider,
        modelProviderId: credential.pin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          credential.pin.modelProviderCredentialScope,
        agentRunModelPin: credential.pin,
        validatePiMemoryPhase2Admission: credential.validate,
        selectedModelOverride: PI_MEMORY_PHASE2_MODEL,
        builtInModelRuntimeRoute: credential.route,
        callbacks: [
          {
            internalKind: "pi-memory:phase2",
            payload: {
              schemaVersion: 1,
              memoryStorageId: claim.memoryStorageId,
              orgId: claim.orgId,
              userId: claim.userId,
              leaseToken: claim.leaseToken,
              claimedRevision: claim.claimedRevision,
              claimedBaseVersionId: claim.baseVersion.versionId,
              selectionDigest,
              selected: claim.selected.map((candidate) => {
                return {
                  piSessionId: candidate.piSessionId,
                  sourceHistoryHash: candidate.sourceHistoryHash,
                };
              }),
            },
          },
        ],
        includeOkouTokenSecret: false,
        productAgentExecutionPlan: {
          identity: "pi-memory-phase2-maintenance",
          content: {
            version: "1",
            // Pi is the sandbox execution overlay; run preparation still
            // needs a supported base framework.
            agent: { framework: "claude-code" },
          },
        },
        connectorScope: {
          allowedConnectorSlugs: [],
          allowedCustomConnectorIds: [],
        },
        validateEnvironmentReferences: false,
        queueOnConcurrencyLimit: true,
        enforceBuiltInCredits: credential.pin.modelProvider === "built-in",
        piExecution: true,
        piMemoryPhase2Maintenance: maintenance,
      },
      signal,
    );
    if (result.status !== 201 || result.body.status === "failed") {
      log.warn("Pi memory maintenance run dispatch was rejected", {
        memoryStorageId: claim.memoryStorageId,
        status: result.status,
        runStatus: result.status === 201 ? result.body.status : undefined,
      });
      return await failClaim(
        db,
        claim,
        nowDate(),
        "maintenance_dispatch_failed",
      );
    }
    return { outcome: "dispatched", runId: result.body.runId };
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
    const recovered = await recoverMaintenanceRun(db, input);
    signal.throwIfAborted();
    if (recovered) {
      return recovered;
    }
    const claim = await claimPiMemoryPhase2Job(db, input);
    signal.throwIfAborted();
    if (!claim) {
      return { outcome: "no_work" };
    }
    const dispatched = await settle(
      set(dispatchClaim$, { db, claim }, signal),
      signal,
    );
    if (dispatched.ok) {
      return dispatched.value;
    }
    if (
      dispatched.error instanceof PiMemoryPhase2CredentialError ||
      dispatched.error instanceof PiMemoryQuotaError
    ) {
      return await failClaim(db, claim, nowDate(), dispatched.error.errorClass);
    }
    log.error("Pi memory maintenance run dispatch failed", {
      memoryStorageId: claim.memoryStorageId,
    });
    return await failClaim(db, claim, nowDate(), "maintenance_dispatch_failed");
  },
);
