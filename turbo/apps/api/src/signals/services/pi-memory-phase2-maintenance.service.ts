import { piMemoryPhase2SelectionDigest } from "@okouai/pi-agent-runtime/api";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import {
  PI_MEMORY_PHASE2_MAX_ATTEMPTS,
  piMemoryPhase2Jobs,
} from "@okouai/db/schema/pi-memory-phase2-job";
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
import { QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";
import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
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

/** Preserve storage-before-publication lock ordering only for maintenance. */
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
 * canonical lease, Run identity and captured inputs protect this attempt.
 * Legacy publisher markers remain write-only during the database rollout.
 */
export function activePiMemoryPhase2MaintenanceRunCondition(args: {
  readonly runId: string | SQLWrapper;
  readonly orgId: string | SQLWrapper;
  readonly userId: string | SQLWrapper;
  readonly currentTime: Date;
}): SQL {
  return and(
    eq(piMemoryPhase2Jobs.maintenanceRunId, args.runId),
    eq(piMemoryPhase2Jobs.orgId, args.orgId),
    eq(piMemoryPhase2Jobs.userId, args.userId),
    eq(piMemoryPhase2Jobs.status, "leased"),
    isNotNull(piMemoryPhase2Jobs.leaseToken),
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
      new QueryBuilder()
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
      activePiMemoryPhase2MaintenanceRunCondition({
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
    eq(piMemoryPhase2Jobs.claimedRevision, args.binding.claimedRevision),
    eq(
      piMemoryPhase2Jobs.claimedBaseVersionId,
      args.binding.claimedBaseVersionId,
    ),
    eq(piMemoryPhase2Jobs.claimedSelectionDigest, args.binding.selectionDigest),
    eq(piMemoryPhase2Jobs.maintenanceRunId, args.runId),
  );
}

/** The admission owner samples this clock after its update timestamp. */
export function piMemoryPhase2MaintenanceBindingCondition(
  args: {
    readonly binding: PiMemoryPhase2MaintenanceRunBinding;
  },
  currentTime: Date,
) {
  return and(
    eq(piMemoryPhase2Jobs.memoryStorageId, args.binding.memoryStorageId),
    eq(piMemoryPhase2Jobs.orgId, args.binding.orgId),
    eq(piMemoryPhase2Jobs.userId, args.binding.userId),
    eq(piMemoryPhase2Jobs.status, "leased"),
    eq(piMemoryPhase2Jobs.leaseToken, args.binding.leaseToken),
    eq(piMemoryPhase2Jobs.claimedRevision, args.binding.claimedRevision),
    eq(
      piMemoryPhase2Jobs.claimedBaseVersionId,
      args.binding.claimedBaseVersionId,
    ),
    eq(piMemoryPhase2Jobs.claimedSelectionDigest, args.binding.selectionDigest),
    isNull(piMemoryPhase2Jobs.maintenanceRunId),
    gt(piMemoryPhase2Jobs.leaseExpiresAt, currentTime),
  );
}

function maintenanceFailureValues(args: {
  readonly payload: PiMemoryPhase2MaintenanceCallbackPayload;
  readonly runId: string;
  readonly errorClass: string;
  readonly currentTime: Date;
}) {
  const hasNewerInput = sql`${piMemoryPhase2Jobs.inputRevision} > ${args.payload.claimedRevision}`;
  const retryCount = sql`LEAST(${PI_MEMORY_PHASE2_MAX_ATTEMPTS}, ${piMemoryPhase2Jobs.retryCount} + 1)`;
  const terminal = sql`${retryCount} >= ${PI_MEMORY_PHASE2_MAX_ATTEMPTS}`;
  const retryAt = new Date(
    args.currentTime.getTime() + PI_MEMORY_PHASE2_RETRY_DELAY_MS,
  );
  return {
    status: sql`CASE WHEN ${hasNewerInput} THEN 'pending'
      WHEN ${terminal} THEN 'terminal_failure' ELSE 'retryable_failure' END`,
    claimedRevision: null,
    claimedBaseVersionId: null,
    leaseToken: null,
    // Keep outgoing writers/readers and the deployed schema compatible until contraction.
    legacyLeaseToken: null,
    sandboxLeaseToken: null,
    leaseExpiresAt: null,
    maintenanceRunId: null,
    retryCount: sql`CASE WHEN ${hasNewerInput} THEN 0 ELSE ${retryCount} END`,
    retryAt: sql`CASE WHEN ${hasNewerInput} OR ${terminal} THEN NULL
      ELSE ${sql.param(retryAt, piMemoryPhase2Jobs.retryAt)}::timestamp END`,
    lastErrorClass: sql`CASE WHEN ${hasNewerInput} THEN NULL ELSE ${args.errorClass} END`,
    claimedSelectionDigest: null,
    claimedSelectedCount: null,
    claimedSelectedUtf8Bytes: null,
    lastMaintenanceRunId: args.runId,
    lastMaintenanceRevision: args.payload.claimedRevision,
    lastMaintenanceBaseVersionId: args.payload.claimedBaseVersionId,
    lastMaintenanceSelectionDigest: args.payload.selectionDigest,
    lastMaintenancePublicationVersionId: null,
    lastMaintenanceOutcome: "failed" as const,
    updatedAt: args.currentTime,
  };
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
const terminalMaintenanceResult = Object.freeze({ success: true } as const);
const skippedMaintenanceResult = Object.freeze({
  success: true,
  skipped: true,
} as const);

const observeTerminalMaintenance$ = command(
  async (
    { get, set },
    envelope: InternalRunCallbackEnvelope,
    payload: PiMemoryPhase2MaintenanceCallbackPayload,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    const [run] = await get(db$)
      .select({
        status: agentRuns.status,
        failureReason: agentRuns.failureReason,
      })
      .from(agentRuns)
      .where(maintenanceRunOwnerCondition(payload, envelope.runId))
      .limit(1);
    signal.throwIfAborted();
    // Storage publication already completed the Job and selected-input watermarks.
    // Only a still-owned, uncommitted attempt can transition here; late callbacks skip.
    const [finished] = await set(writeDb$)
      .update(piMemoryPhase2Jobs)
      .set(
        maintenanceFailureValues({
          payload,
          runId: envelope.runId,
          currentTime: nowDate(),
          errorClass:
            envelope.status !== "completed" || run?.status !== "completed"
              ? callbackErrorClass(run)
              : "maintenance_publication_missing",
        }),
      )
      .where(
        exactActiveMaintenanceCondition({
          binding: payload,
          runId: envelope.runId,
        }),
      )
      .returning({ id: piMemoryPhase2Jobs.memoryStorageId });
    signal.throwIfAborted();
    return finished ? terminalMaintenanceResult : skippedMaintenanceResult;
  },
);

/** Observe an exact terminal run/publication; never writes Storage state. */
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
