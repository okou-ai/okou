import { piMemoryPhase2SelectionDigest } from "@okouai/pi-agent-runtime/api";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import {
  PI_MEMORY_PHASE2_MAX_ATTEMPTS,
  piMemoryPhase2Jobs,
} from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import {
  and,
  eq,
  exists,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { z } from "zod";

import type { ApiDb, Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { findPiMemoryPhase2Checkpoint } from "./pi-memory-phase2-checkpoint.service";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import { PI_MEMORY_PHASE2_RETRY_DELAY_MS } from "./pi-memory-phase2-job.service";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const piMemoryPhase2MaintenanceCallbackPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    memoryStorageId: z.uuid(),
    orgId: z.string().min(1),
    userId: z.string().min(1),
    leaseToken: z.uuid(),
    claimedRevision: z.number().int().positive(),
    claimedBaseVersionId: sha256Schema,
    selectionDigest: sha256Schema,
    selected: z
      .array(
        z
          .object({
            piSessionId: z.string().min(1).max(255),
            sourceHistoryHash: sha256Schema,
          })
          .strict(),
      )
      .max(256),
  })
  .strict()
  .readonly();

type PiMemoryPhase2MaintenanceCallbackPayload = z.infer<
  typeof piMemoryPhase2MaintenanceCallbackPayloadSchema
>;

interface PiMemoryPhase2MaintenanceRunBinding {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly leaseToken: string;
  readonly claimedRevision: number;
  readonly claimedBaseVersionId: string;
  readonly selectionDigest: string;
}

/**
 * Match the complete live sandbox-maintenance fence for one owned run. The
 * job constraints make these fields move together, while spelling them out
 * here keeps cleanup fail-closed if an invalid legacy row is ever observed.
 */
export function activePiMemoryPhase2MaintenanceRunCondition(
  db: Pick<ApiDb, "select">,
  args: {
    readonly runId: string | SQLWrapper;
    readonly orgId: string | SQLWrapper;
    readonly userId: string | SQLWrapper;
    readonly currentTime: Date;
  },
): SQL {
  return and(
    eq(piMemoryPhase2Jobs.maintenanceRunId, args.runId),
    eq(piMemoryPhase2Jobs.orgId, args.orgId),
    eq(piMemoryPhase2Jobs.userId, args.userId),
    eq(piMemoryPhase2Jobs.status, "leased"),
    isNull(piMemoryPhase2Jobs.legacyLeaseToken),
    isNotNull(piMemoryPhase2Jobs.leaseToken),
    eq(piMemoryPhase2Jobs.sandboxLeaseToken, piMemoryPhase2Jobs.leaseToken),
    gt(piMemoryPhase2Jobs.leaseExpiresAt, args.currentTime),
    isNotNull(piMemoryPhase2Jobs.claimedRevision),
    gt(
      piMemoryPhase2Jobs.claimedRevision,
      piMemoryPhase2Jobs.completedRevision,
    ),
    lte(piMemoryPhase2Jobs.claimedRevision, piMemoryPhase2Jobs.inputRevision),
    isNotNull(piMemoryPhase2Jobs.claimedBaseVersionId),
    lt(piMemoryPhase2Jobs.retryCount, PI_MEMORY_PHASE2_MAX_ATTEMPTS),
    isNull(piMemoryPhase2Jobs.retryAt),
    isNull(piMemoryPhase2Jobs.lastErrorClass),
    isNotNull(piMemoryPhase2Jobs.claimedSelectionDigest),
    isNotNull(piMemoryPhase2Jobs.claimedSelectedCount),
    isNotNull(piMemoryPhase2Jobs.claimedSelectedUtf8Bytes),
    exists(
      db
        .select({ id: agentRunCallbacks.id })
        .from(agentRunCallbacks)
        .where(
          and(
            eq(agentRunCallbacks.runId, args.runId),
            eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
            sql`${agentRunCallbacks.payload}->>'schemaVersion' = '1'`,
            sql`${agentRunCallbacks.payload}->>'memoryStorageId' = ${piMemoryPhase2Jobs.memoryStorageId}::text`,
            sql`${agentRunCallbacks.payload}->>'orgId' = ${piMemoryPhase2Jobs.orgId}`,
            sql`${agentRunCallbacks.payload}->>'userId' = ${piMemoryPhase2Jobs.userId}`,
            sql`${agentRunCallbacks.payload}->>'leaseToken' = ${piMemoryPhase2Jobs.leaseToken}::text`,
            sql`${agentRunCallbacks.payload}->>'claimedRevision' = ${piMemoryPhase2Jobs.claimedRevision}::text`,
            sql`${agentRunCallbacks.payload}->>'claimedBaseVersionId' = ${piMemoryPhase2Jobs.claimedBaseVersionId}`,
            sql`${agentRunCallbacks.payload}->>'selectionDigest' = ${piMemoryPhase2Jobs.claimedSelectionDigest}`,
          ),
        ),
    ),
  ) as SQL;
}

/**
 * Serialize cleanup with every exact owner binding for this run, then classify
 * the complete fence under that lock. Locking the bound row before applying
 * the live-lease predicate closes the expired-at-discovery/renewed-at-write
 * race without allowing an unrelated owner row to shield the run.
 */
export async function lockPiMemoryPhase2MaintenanceCleanupProtection(
  tx: Tx,
  args: {
    readonly runId: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<boolean> {
  const bound = await tx
    .select({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId })
    .from(piMemoryPhase2Jobs)
    .where(
      and(
        eq(piMemoryPhase2Jobs.maintenanceRunId, args.runId),
        eq(piMemoryPhase2Jobs.orgId, args.orgId),
        eq(piMemoryPhase2Jobs.userId, args.userId),
      ),
    )
    .for("update", { of: piMemoryPhase2Jobs });
  if (bound.length === 0) {
    return false;
  }

  const [active] = await tx
    .select({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId })
    .from(piMemoryPhase2Jobs)
    .where(
      activePiMemoryPhase2MaintenanceRunCondition(tx, {
        ...args,
        currentTime: nowDate(),
      }),
    )
    .limit(1);
  return active !== undefined;
}

function exactActiveMaintenanceCondition(args: {
  readonly binding: PiMemoryPhase2MaintenanceRunBinding;
  readonly runId: string;
}) {
  return and(
    eq(piMemoryPhase2Jobs.memoryStorageId, args.binding.memoryStorageId),
    eq(piMemoryPhase2Jobs.orgId, args.binding.orgId),
    eq(piMemoryPhase2Jobs.userId, args.binding.userId),
    eq(piMemoryPhase2Jobs.status, "leased"),
    eq(piMemoryPhase2Jobs.leaseToken, args.binding.leaseToken),
    eq(piMemoryPhase2Jobs.sandboxLeaseToken, args.binding.leaseToken),
    eq(piMemoryPhase2Jobs.claimedRevision, args.binding.claimedRevision),
    eq(
      piMemoryPhase2Jobs.claimedBaseVersionId,
      args.binding.claimedBaseVersionId,
    ),
    eq(piMemoryPhase2Jobs.claimedSelectionDigest, args.binding.selectionDigest),
    eq(piMemoryPhase2Jobs.maintenanceRunId, args.runId),
  );
}

/** Bind the run before its transaction can make a runner job visible. */
export async function bindPiMemoryPhase2MaintenanceRun(
  tx: Tx,
  args: {
    readonly binding: PiMemoryPhase2MaintenanceRunBinding;
    readonly runId: string;
  },
): Promise<void> {
  const [bound] = await tx
    .update(piMemoryPhase2Jobs)
    .set({ maintenanceRunId: args.runId, updatedAt: nowDate() })
    .where(
      and(
        eq(piMemoryPhase2Jobs.memoryStorageId, args.binding.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, args.binding.orgId),
        eq(piMemoryPhase2Jobs.userId, args.binding.userId),
        eq(piMemoryPhase2Jobs.status, "leased"),
        eq(piMemoryPhase2Jobs.leaseToken, args.binding.leaseToken),
        eq(piMemoryPhase2Jobs.sandboxLeaseToken, args.binding.leaseToken),
        eq(piMemoryPhase2Jobs.claimedRevision, args.binding.claimedRevision),
        eq(
          piMemoryPhase2Jobs.claimedBaseVersionId,
          args.binding.claimedBaseVersionId,
        ),
        eq(
          piMemoryPhase2Jobs.claimedSelectionDigest,
          args.binding.selectionDigest,
        ),
        sql`${piMemoryPhase2Jobs.maintenanceRunId} IS NULL`,
        sql`${piMemoryPhase2Jobs.leaseExpiresAt} > ${nowDate()}`,
      ),
    )
    .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
  if (!bound) {
    throw new Error("Pi memory Phase 2 maintenance run lost its claim fence");
  }
}

async function updateSelectionWatermarks(
  tx: Tx,
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
): Promise<void> {
  await tx
    .update(piMemoryStage1Candidates)
    .set({ lastSelectedSourceHistoryHash: null })
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, payload.memoryStorageId),
        eq(piMemoryStage1Candidates.orgId, payload.orgId),
        eq(piMemoryStage1Candidates.userId, payload.userId),
      ),
    );
  for (const candidate of payload.selected) {
    await tx
      .update(piMemoryStage1Candidates)
      .set({ lastSelectedSourceHistoryHash: candidate.sourceHistoryHash })
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, payload.memoryStorageId),
          eq(piMemoryStage1Candidates.orgId, payload.orgId),
          eq(piMemoryStage1Candidates.userId, payload.userId),
          eq(piMemoryStage1Candidates.status, "succeeded"),
          eq(piMemoryStage1Candidates.piSessionId, candidate.piSessionId),
          eq(
            piMemoryStage1Candidates.sourceHistoryHash,
            candidate.sourceHistoryHash,
          ),
        ),
      );
  }
}

async function transitionMaintenanceFailure(
  tx: Tx,
  args: {
    readonly payload: PiMemoryPhase2MaintenanceCallbackPayload;
    readonly runId: string;
    readonly errorClass: string;
    readonly inputRevision: number;
    readonly retryCount: number;
  },
): Promise<void> {
  const hasNewerInput = args.inputRevision > args.payload.claimedRevision;
  const retryCount = hasNewerInput
    ? 0
    : Math.min(PI_MEMORY_PHASE2_MAX_ATTEMPTS, args.retryCount + 1);
  const terminal = retryCount >= PI_MEMORY_PHASE2_MAX_ATTEMPTS;
  const [failed] = await tx
    .update(piMemoryPhase2Jobs)
    .set({
      status: hasNewerInput
        ? "pending"
        : terminal
          ? "terminal_failure"
          : "retryable_failure",
      claimedRevision: null,
      claimedBaseVersionId: null,
      leaseToken: null,
      legacyLeaseToken: null,
      sandboxLeaseToken: null,
      leaseExpiresAt: null,
      maintenanceRunId: null,
      retryCount,
      retryAt:
        hasNewerInput || terminal
          ? null
          : new Date(nowDate().getTime() + PI_MEMORY_PHASE2_RETRY_DELAY_MS),
      lastErrorClass: hasNewerInput ? null : args.errorClass,
      claimedSelectionDigest: null,
      claimedSelectedCount: null,
      claimedSelectedUtf8Bytes: null,
      lastMaintenanceRunId: args.runId,
      lastMaintenanceRevision: args.payload.claimedRevision,
      lastMaintenanceBaseVersionId: args.payload.claimedBaseVersionId,
      lastMaintenanceSelectionDigest: args.payload.selectionDigest,
      lastMaintenanceCheckpointId: null,
      lastMaintenanceCheckpointVersionId: null,
      lastMaintenanceOutcome: "failed",
      updatedAt: nowDate(),
    })
    .where(
      exactActiveMaintenanceCondition({
        binding: args.payload,
        runId: args.runId,
      }),
    )
    .returning({ id: piMemoryPhase2Jobs.memoryStorageId });
  if (!failed) {
    throw new Error("Pi memory maintenance failure lost its exact run fence");
  }
}

function callbackErrorClass(
  run:
    | Readonly<{
        status: typeof agentRuns.$inferSelect.status;
        failureReason: string | null;
      }>
    | undefined,
): string {
  if (run?.status === "cancelled") {
    return "maintenance_run_cancelled";
  }
  if (run?.failureReason) {
    return `maintenance_${run.failureReason}`;
  }
  return "maintenance_run_failed";
}

interface ExactMaintenanceCheckpoint {
  readonly id: string | null;
  readonly versionId: string;
}

async function findExactMaintenanceCheckpoint(
  tx: Tx,
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
  runId: string,
): Promise<ExactMaintenanceCheckpoint | undefined> {
  const [checkpoint] = await tx
    .select({
      id: checkpoints.id,
      storageMounts: checkpoints.storageMounts,
    })
    .from(checkpoints)
    .where(eq(checkpoints.runId, runId))
    .limit(1);
  const memoryMount = checkpoint?.storageMounts?.find((mount) => {
    return (
      mount.storageId === payload.memoryStorageId &&
      mount.name === "memory" &&
      mount.writeback === true
    );
  });
  const versionId = memoryMount?.version;
  if (!checkpoint || !versionId) {
    return undefined;
  }
  if (versionId === payload.claimedBaseVersionId) {
    return { id: checkpoint.id, versionId };
  }

  const [lineage] = await tx
    .select({ id: storageVersionLineage.id })
    .from(storageVersionLineage)
    .where(
      and(
        eq(storageVersionLineage.storageId, payload.memoryStorageId),
        eq(storageVersionLineage.versionId, versionId),
        eq(storageVersionLineage.parentVersionId, payload.claimedBaseVersionId),
        eq(storageVersionLineage.runId, runId),
      ),
    )
    .limit(1);
  return lineage ? { id: checkpoint.id, versionId } : undefined;
}

async function completeMaintenanceSuccess(
  tx: Tx,
  args: {
    readonly payload: PiMemoryPhase2MaintenanceCallbackPayload;
    readonly runId: string;
    readonly checkpoint: ExactMaintenanceCheckpoint;
  },
): Promise<void> {
  await updateSelectionWatermarks(tx, args.payload);
  const published =
    args.checkpoint.versionId !== args.payload.claimedBaseVersionId;
  const completedAt = nowDate();
  const [completed] = await tx
    .update(piMemoryPhase2Jobs)
    .set({
      status: sql`CASE
        WHEN ${piMemoryPhase2Jobs.inputRevision} = ${args.payload.claimedRevision}
        THEN 'idle'
        ELSE 'pending'
      END`,
      completedRevision: args.payload.claimedRevision,
      claimedRevision: null,
      claimedBaseVersionId: null,
      leaseToken: null,
      legacyLeaseToken: null,
      sandboxLeaseToken: null,
      leaseExpiresAt: null,
      maintenanceRunId: null,
      retryCount: 0,
      retryAt: null,
      lastErrorClass: null,
      lastSucceededAt: completedAt,
      claimedSelectionDigest: null,
      claimedSelectedCount: null,
      claimedSelectedUtf8Bytes: null,
      ...(published
        ? {
            lastPublishedVersionId: args.checkpoint.versionId,
            lastPublishedAt: completedAt,
          }
        : {}),
      lastMaintenanceRunId: args.runId,
      lastMaintenanceRevision: args.payload.claimedRevision,
      lastMaintenanceBaseVersionId: args.payload.claimedBaseVersionId,
      lastMaintenanceSelectionDigest: args.payload.selectionDigest,
      lastMaintenanceCheckpointId: args.checkpoint.id,
      lastMaintenanceCheckpointVersionId: args.checkpoint.versionId,
      lastMaintenanceOutcome: published ? "published" : "no_diff",
      updatedAt: completedAt,
    })
    .where(
      exactActiveMaintenanceCondition({
        binding: args.payload,
        runId: args.runId,
      }),
    )
    .returning({ id: piMemoryPhase2Jobs.memoryStorageId });
  if (!completed) {
    throw new Error(
      "Pi memory maintenance completion lost its exact run fence",
    );
  }
}

/**
 * Commit validated checkpoint control state in the publisher's transaction.
 * No completion/observer acknowledgement is needed to make the receipt true.
 * This also prevents a draining API's failed-run observer from retrying a
 * publication whose later completion report was lost.
 */
export async function settlePiMemoryPhase2Checkpoint(
  tx: Tx,
  runId: string,
  versionId: string,
): Promise<void> {
  const [callback] = await tx
    .select({ payload: agentRunCallbacks.payload })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, runId),
        eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
      ),
    )
    .limit(1);
  const payload = piMemoryPhase2MaintenanceCallbackPayloadSchema.parse(
    callback?.payload,
  );
  if (
    piMemoryPhase2SelectionDigest(payload.selected) !== payload.selectionDigest
  ) {
    throw new Error("Pi memory checkpoint selection mismatch");
  }
  await completeMaintenanceSuccess(tx, {
    payload,
    runId,
    checkpoint: { id: null, versionId },
  });
}

async function observeTerminalMaintenance(
  tx: Tx,
  envelope: InternalRunCallbackEnvelope,
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
): Promise<InternalRunCallbackDispatchResult> {
  const [job] = await tx
    .select({
      inputRevision: piMemoryPhase2Jobs.inputRevision,
      retryCount: piMemoryPhase2Jobs.retryCount,
      lastMaintenanceRunId: piMemoryPhase2Jobs.lastMaintenanceRunId,
    })
    .from(piMemoryPhase2Jobs)
    .where(
      and(
        eq(piMemoryPhase2Jobs.memoryStorageId, payload.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, payload.orgId),
        eq(piMemoryPhase2Jobs.userId, payload.userId),
      ),
    )
    .limit(1)
    .for("update", { of: piMemoryPhase2Jobs });
  if (!job) {
    return { success: true, skipped: true };
  }
  if (job.lastMaintenanceRunId === envelope.runId) {
    const [checkpoint] = await tx
      .select({ id: checkpoints.id })
      .from(checkpoints)
      .where(eq(checkpoints.runId, envelope.runId))
      .limit(1);
    if (checkpoint) {
      await tx
        .update(piMemoryPhase2Jobs)
        .set({ lastMaintenanceCheckpointId: checkpoint.id })
        .where(
          and(
            eq(piMemoryPhase2Jobs.memoryStorageId, payload.memoryStorageId),
            eq(piMemoryPhase2Jobs.lastMaintenanceRunId, envelope.runId),
            sql`${piMemoryPhase2Jobs.lastMaintenanceOutcome} IN ('published', 'no_diff')`,
          ),
        );
    }
    return { success: true, skipped: true };
  }

  const [run] = await tx
    .select({
      status: agentRuns.status,
      failureReason: agentRuns.failureReason,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, envelope.runId),
        eq(agentRuns.orgId, payload.orgId),
        eq(agentRuns.userId, payload.userId),
      ),
    )
    .limit(1);
  const activeCondition = exactActiveMaintenanceCondition({
    binding: payload,
    runId: envelope.runId,
  });
  const [active] = await tx
    .select({ id: piMemoryPhase2Jobs.memoryStorageId })
    .from(piMemoryPhase2Jobs)
    .where(activeCondition)
    .limit(1);
  if (!active) {
    return { success: true, skipped: true };
  }

  const receipt = await findPiMemoryPhase2Checkpoint(tx, {
    ...payload,
    runId: envelope.runId,
  });
  if (receipt) {
    const [checkpoint] = await tx
      .select({ id: checkpoints.id })
      .from(checkpoints)
      .where(eq(checkpoints.runId, envelope.runId))
      .limit(1);
    await completeMaintenanceSuccess(tx, {
      payload,
      runId: envelope.runId,
      checkpoint: { id: checkpoint?.id ?? null, versionId: receipt.versionId },
    });
    return { success: true };
  }

  if (envelope.status !== "completed" || run?.status !== "completed") {
    await transitionMaintenanceFailure(tx, {
      payload,
      runId: envelope.runId,
      errorClass: callbackErrorClass(run),
      inputRevision: job.inputRevision,
      retryCount: job.retryCount,
    });
    return { success: true };
  }

  const checkpoint = await findExactMaintenanceCheckpoint(
    tx,
    payload,
    envelope.runId,
  );
  if (!checkpoint) {
    await transitionMaintenanceFailure(tx, {
      payload,
      runId: envelope.runId,
      errorClass: "maintenance_checkpoint_invalid",
      inputRevision: job.inputRevision,
      retryCount: job.retryCount,
    });
    return { success: true };
  }

  await completeMaintenanceSuccess(tx, {
    payload,
    runId: envelope.runId,
    checkpoint,
  });
  return { success: true };
}

/** Observe an exact terminal run/checkpoint; never writes Storage state. */
export async function handlePiMemoryPhase2MaintenanceCallback(
  db: ApiDb,
  envelope: InternalRunCallbackEnvelope,
): Promise<InternalRunCallbackDispatchResult> {
  if (envelope.status === "progress") {
    return { success: true, skipped: true };
  }
  const parsed = piMemoryPhase2MaintenanceCallbackPayloadSchema.safeParse(
    envelope.payload,
  );
  if (!parsed.success) {
    return { success: false, error: "Invalid Pi memory maintenance callback" };
  }
  const payload = parsed.data;
  if (
    piMemoryPhase2SelectionDigest(payload.selected) !== payload.selectionDigest
  ) {
    return {
      success: false,
      error: "Pi memory maintenance callback selection mismatch",
    };
  }
  return await db.transaction(async (tx) => {
    return await observeTerminalMaintenance(tx, envelope, payload);
  });
}
