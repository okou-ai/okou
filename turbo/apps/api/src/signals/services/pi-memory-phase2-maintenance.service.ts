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
  or,
} from "drizzle-orm";
import { z } from "zod";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { piMemoryPhase2Checkpoints } from "@okouai/db/schema/pi-memory-phase2-checkpoint";

import type { ApiDb, Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { piMemoryPhase2CheckpointCondition } from "./pi-memory-phase2-checkpoint.service";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import { PI_MEMORY_PHASE2_RETRY_DELAY_MS } from "./pi-memory-phase2-job.service";
import { lockPiMemoryCandidateStorage } from "./pi-memory-stage1-candidate.service";

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

/** Preserve storage-before-checkpoint lock ordering only for maintenance. */
export async function lockPiMemoryPhase2CompletionStorage(
  tx: Tx,
  run: { readonly id: string; readonly orgId: string; readonly userId: string },
): Promise<void> {
  const [callback] = await tx
    .select({ payload: agentRunCallbacks.payload })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, run.id),
        eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
      ),
    )
    .limit(1);
  if (!callback) {
    return;
  }
  const binding = piMemoryPhase2MaintenanceCallbackPayloadSchema.parse(
    callback.payload,
  );
  if (binding.orgId !== run.orgId || binding.userId !== run.userId) {
    throw new Error(
      "Pi memory maintenance callback does not belong to run owner",
    );
  }
  await lockPiMemoryCandidateStorage(tx, run);
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

function maintenanceFailureValues(args: {
  readonly payload: PiMemoryPhase2MaintenanceCallbackPayload;
  readonly runId: string;
  readonly errorClass: string;
  readonly inputRevision: number;
  readonly retryCount: number;
}) {
  const hasNewerInput = args.inputRevision > args.payload.claimedRevision;
  const retryCount = hasNewerInput
    ? 0
    : Math.min(PI_MEMORY_PHASE2_MAX_ATTEMPTS, args.retryCount + 1);
  const terminal = retryCount >= PI_MEMORY_PHASE2_MAX_ATTEMPTS;

  return {
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
  } as const;
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

function maintenanceCheckpointVersion(
  checkpoint:
    | Pick<typeof checkpoints.$inferSelect, "storageMounts">
    | undefined,
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
) {
  return checkpoint?.storageMounts?.find((mount) => {
    return (
      mount.storageId === payload.memoryStorageId &&
      mount.name === "memory" &&
      mount.writeback === true
    );
  })?.version;
}

function maintenanceCheckpointLineageCondition(
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
  runId: string,
  versionId: string,
) {
  return and(
    eq(storageVersionLineage.storageId, payload.memoryStorageId),
    eq(storageVersionLineage.versionId, versionId),
    eq(storageVersionLineage.parentVersionId, payload.claimedBaseVersionId),
    eq(storageVersionLineage.runId, runId),
  );
}

function maintenanceSuccessValues(args: {
  readonly payload: PiMemoryPhase2MaintenanceCallbackPayload;
  readonly runId: string;
  readonly checkpoint: ExactMaintenanceCheckpoint;
}) {
  const published =
    args.checkpoint.versionId !== args.payload.claimedBaseVersionId;
  const completedAt = nowDate();

  return {
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
  } as const;
}

const maintenanceJobColumns = Object.freeze({
  inputRevision: piMemoryPhase2Jobs.inputRevision,
  retryCount: piMemoryPhase2Jobs.retryCount,
  lastMaintenanceRunId: piMemoryPhase2Jobs.lastMaintenanceRunId,
});
const maintenanceRunColumns = Object.freeze({
  status: agentRuns.status,
  failureReason: agentRuns.failureReason,
});
function maintenanceJobOwnerCondition(
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
) {
  return and(
    eq(piMemoryPhase2Jobs.memoryStorageId, payload.memoryStorageId),
    eq(piMemoryPhase2Jobs.orgId, payload.orgId),
    eq(piMemoryPhase2Jobs.userId, payload.userId),
  );
}
function maintenanceCandidateOwnerCondition(
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
) {
  return and(
    eq(piMemoryStage1Candidates.memoryStorageId, payload.memoryStorageId),
    eq(piMemoryStage1Candidates.orgId, payload.orgId),
    eq(piMemoryStage1Candidates.userId, payload.userId),
  );
}
function maintenanceSelectionWatermarkValues(
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
) {
  if (payload.selected.length === 0) {
    return { lastSelectedSourceHistoryHash: null };
  }
  const selected = and(
    eq(piMemoryStage1Candidates.status, "succeeded"),
    or(
      ...payload.selected.map((candidate) => {
        return and(
          eq(piMemoryStage1Candidates.piSessionId, candidate.piSessionId),
          eq(
            piMemoryStage1Candidates.sourceHistoryHash,
            candidate.sourceHistoryHash,
          ),
        );
      }),
    ),
  );
  return {
    lastSelectedSourceHistoryHash: sql`CASE WHEN ${selected} THEN ${piMemoryStage1Candidates.sourceHistoryHash} ELSE NULL END`,
  };
}

function observedCheckpoint(
  receipt: typeof piMemoryPhase2Checkpoints.$inferSelect | undefined,
  checkpoint:
    | Pick<typeof checkpoints.$inferSelect, "id" | "storageMounts">
    | undefined,
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
): ExactMaintenanceCheckpoint | undefined {
  if (receipt) {
    return { id: checkpoint?.id ?? null, versionId: receipt.versionId };
  }
  const versionId = maintenanceCheckpointVersion(checkpoint, payload);
  return checkpoint && versionId ? { id: checkpoint.id, versionId } : undefined;
}
function observedTerminalValues(
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
  envelope: InternalRunCallbackEnvelope,
  observed: {
    readonly checkpoint: ExactMaintenanceCheckpoint | undefined;
    readonly job: {
      readonly inputRevision: number;
      readonly retryCount: number;
    };
    readonly run: Parameters<typeof callbackErrorClass>[0];
  },
) {
  if (observed.checkpoint) {
    return maintenanceSuccessValues({
      payload,
      runId: envelope.runId,
      checkpoint: observed.checkpoint,
    });
  }
  return maintenanceFailureValues({
    payload,
    runId: envelope.runId,
    inputRevision: observed.job.inputRevision,
    retryCount: observed.job.retryCount,
    errorClass:
      envelope.status !== "completed" || observed.run?.status !== "completed"
        ? callbackErrorClass(observed.run)
        : "maintenance_checkpoint_invalid",
  });
}

function maintenanceRunOwnerCondition(
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
  runId: string,
) {
  return and(
    eq(agentRuns.id, runId),
    eq(agentRuns.orgId, payload.orgId),
    eq(agentRuns.userId, payload.userId),
  );
}
function maintenanceReplayCondition(
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
  runId: string,
) {
  return and(
    eq(piMemoryPhase2Jobs.memoryStorageId, payload.memoryStorageId),
    eq(piMemoryPhase2Jobs.lastMaintenanceRunId, runId),
    sql`${piMemoryPhase2Jobs.lastMaintenanceOutcome} IN ('published', 'no_diff')`,
  );
}

const checkpointColumns = Object.freeze({
  id: checkpoints.id,
  storageMounts: checkpoints.storageMounts,
});
const terminalMaintenanceResult = Object.freeze({ success: true } as const);
const skippedMaintenanceResult = Object.freeze({
  success: true,
  skipped: true,
} as const);

const observeTerminalMaintenance$ = command(
  async (
    { set },
    envelope: InternalRunCallbackEnvelope,
    payload: PiMemoryPhase2MaintenanceCallbackPayload,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    signal.throwIfAborted();
    const binding = { ...payload, runId: envelope.runId };
    // The job fence, checkpoint evidence, selected watermarks and terminal receipt
    // commit together. Publication itself remains owned by Storage.
    const result = await set(writeDb$).transaction(async (tx) => {
      const [job] = await tx
        .select(maintenanceJobColumns)
        .from(piMemoryPhase2Jobs)
        .where(maintenanceJobOwnerCondition(payload))
        .limit(1)
        .for("update", { of: piMemoryPhase2Jobs });
      signal.throwIfAborted();
      if (!job) {
        return skippedMaintenanceResult;
      }
      if (job.lastMaintenanceRunId === envelope.runId) {
        const [checkpoint] = await tx
          .select({ id: checkpoints.id })
          .from(checkpoints)
          .where(eq(checkpoints.runId, envelope.runId))
          .limit(1);
        signal.throwIfAborted();
        if (checkpoint) {
          await tx
            .update(piMemoryPhase2Jobs)
            .set({ lastMaintenanceCheckpointId: checkpoint.id })
            .where(maintenanceReplayCondition(payload, envelope.runId));
          signal.throwIfAborted();
        }
        return skippedMaintenanceResult;
      }
      const [run] = await tx
        .select(maintenanceRunColumns)
        .from(agentRuns)
        .where(maintenanceRunOwnerCondition(payload, envelope.runId))
        .limit(1);
      signal.throwIfAborted();
      const activeCondition = exactActiveMaintenanceCondition({
        binding: payload,
        runId: envelope.runId,
      });
      const [active] = await tx
        .select({ id: piMemoryPhase2Jobs.memoryStorageId })
        .from(piMemoryPhase2Jobs)
        .where(activeCondition)
        .limit(1);
      signal.throwIfAborted();
      if (!active) {
        return skippedMaintenanceResult;
      }
      const [receipt] = await tx
        .select()
        .from(piMemoryPhase2Checkpoints)
        .where(piMemoryPhase2CheckpointCondition(binding))
        .limit(1);
      signal.throwIfAborted();
      let exactCheckpoint: ExactMaintenanceCheckpoint | undefined;
      if (
        receipt ||
        (envelope.status === "completed" && run?.status === "completed")
      ) {
        const [checkpoint] = await tx
          .select(checkpointColumns)
          .from(checkpoints)
          .where(eq(checkpoints.runId, envelope.runId))
          .limit(1);
        signal.throwIfAborted();
        exactCheckpoint = observedCheckpoint(receipt, checkpoint, payload);
        if (
          exactCheckpoint &&
          !receipt &&
          exactCheckpoint.versionId !== payload.claimedBaseVersionId
        ) {
          const [lineage] = await tx
            .select({ id: storageVersionLineage.id })
            .from(storageVersionLineage)
            .where(
              maintenanceCheckpointLineageCondition(
                payload,
                envelope.runId,
                exactCheckpoint.versionId,
              ),
            )
            .limit(1);
          signal.throwIfAborted();
          if (!lineage) {
            exactCheckpoint = undefined;
          }
        }
      }
      if (exactCheckpoint) {
        await tx
          .update(piMemoryStage1Candidates)
          .set(maintenanceSelectionWatermarkValues(payload))
          .where(maintenanceCandidateOwnerCondition(payload));
        signal.throwIfAborted();
      }
      const [finished] = await tx
        .update(piMemoryPhase2Jobs)
        .set(
          observedTerminalValues(payload, envelope, {
            checkpoint: exactCheckpoint,
            job,
            run,
          }),
        )
        .where(activeCondition)
        .returning({ id: piMemoryPhase2Jobs.memoryStorageId });
      signal.throwIfAborted();
      if (!finished) {
        throw new Error(
          exactCheckpoint
            ? "Pi memory maintenance completion lost its exact run fence"
            : "Pi memory maintenance failure lost its exact run fence",
        );
      }
      return terminalMaintenanceResult;
    });
    signal.throwIfAborted();
    return result;
  },
);

/** Observe an exact terminal run/checkpoint; never writes Storage state. */
export const handlePiMemoryPhase2MaintenanceCallback$ = command(
  async (
    { set },
    envelope: InternalRunCallbackEnvelope,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    signal.throwIfAborted();
    if (envelope.status === "progress") {
      return skippedMaintenanceResult;
    }
    const parsed = piMemoryPhase2MaintenanceCallbackPayloadSchema.safeParse(
      envelope.payload,
    );
    if (!parsed.success) {
      return {
        success: false,
        error: "Invalid Pi memory maintenance callback",
      };
    }
    const payload = parsed.data;
    if (
      piMemoryPhase2SelectionDigest(payload.selected) !==
      payload.selectionDigest
    ) {
      return {
        success: false,
        error: "Pi memory maintenance callback selection mismatch",
      };
    }
    return await set(observeTerminalMaintenance$, envelope, payload, signal);
  },
);
