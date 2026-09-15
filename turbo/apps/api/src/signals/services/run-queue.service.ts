import {
  consumeDeferredPiRun$,
  settleDeferredPiTerminal$,
  failWaitingPiCandidate,
  listDeferredPiCandidates,
  hasEarlierDeferredDemand,
} from "./pi-deferred-sandbox.service";
import { agentRunSandboxIntent } from "@okouai/db/schema/agent-run-inference";
import { command } from "ccstate";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agents } from "@okouai/db/schema/agent";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  and,
  count,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../../lib/time";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { logger } from "../../lib/log";
import { legacySandboxRunPredicate } from "./pi-inference-lifecycle.service";
import { decryptQueuedRunnerJobPayload } from "./agent-run-queue-payload.service";
import { runnerJobQueueTimestamps } from "./runner-job-queue-lifecycle.service";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import {
  revokeQueuedRunAssistantMarkers,
  type QueueMarkerRevokeNotification,
} from "./chat-queue-marker.service";
import {
  cappedBaseConcurrencyLimit,
  loadOrgConcurrencyState,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import type { Tx } from "../../lib/db-types";
import type { PendingRunActivation } from "./agent-run-activation.types";
import { writeRunMetadataInTransaction } from "./agent-run-metadata-write.service";
import {
  refreshPiApiFirstTurnDeadline,
  requirePiApiFirstTurnExecutionContext,
} from "./pi-api-first-turn-config";
import { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import { checkOrgCreditsForRunAdmissionInTransaction } from "./run-admission.service";
import {
  COMPUTE_CLOSURE_ERROR,
  transitionAgentRunsToTerminal,
} from "./agent-run-terminal-transition.service";
import {
  prepareComputeRunAdmission,
  validateComputeRunAdmission,
  stopClosedComputeCandidate,
  withComputeOwnershipRetry,
} from "./compute-erasure-admission.service";
import { settle } from "../utils";

const L = logger("RunQueue");

const PENDING_RUN_TTL_MS = 15 * 60 * 1000;
const QUEUED_RUN_EXPIRED_REASON = "Queued run expired (exceeded queue TTL)";
const QUEUED_RUN_LAUNCH_ORPHAN_REASON =
  "Queued run timed out before queue entry was persisted";

async function effectiveOrgConcurrencyState(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<{ readonly activeRunCount: number; readonly limit: number }> {
  const at = nowDate();
  const state = await loadOrgConcurrencyState(db, {
    orgId,
    at,
    activePendingAfter: new Date(at.getTime() - PENDING_RUN_TTL_MS),
  });
  const baseLimit = cappedBaseConcurrencyLimit(state.baseConcurrencyLimit);
  return {
    activeRunCount: state.activeRunCount,
    limit: totalConcurrencyLimit({ baseLimit, paidSlots: state.paidSlots }),
  };
}

type DbTransaction = Tx;

async function lockQueuedRunThreads(
  tx: DbTransaction,
  runIds: readonly string[],
): Promise<void> {
  if (runIds.length === 0) {
    return;
  }
  // Terminal cleanup takes the provider lock. Queue-marker revocation later
  // writes thread sequence numbers, so own those threads before locking runs
  // or providers, in the same order as completion and final launch admission.
  // Include marker parents for historical runs without a thread binding.
  await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      inArray(
        chatThreads.id,
        tx
          .select({ id: agentRuns.chatThreadId })
          .from(agentRuns)
          .where(inArray(agentRuns.id, runIds))
          .union(
            tx
              .select({ id: chatEvents.chatThreadId })
              .from(chatEvents)
              .where(inArray(chatEvents.runId, runIds)),
          ),
      ),
    )
    .orderBy(chatThreads.id)
    .for("update");
}

type QueuedRunnerJobPayload = NonNullable<
  Awaited<ReturnType<typeof decryptQueuedRunnerJobPayload>>
>;

interface QueueCandidate {
  readonly runId: string;
  readonly agentId: string | null;
  readonly resourceOwner: {
    readonly userId: string;
    readonly orgId: string;
  } | null;
  readonly userId: string;
  readonly runOwner: { readonly userId: string; readonly orgId: string } | null;
  readonly createdAt: Date;
  readonly encryptedParams: string | null;
  readonly runStatus: string | null;
  readonly chatThreadId: string | null;
  readonly prompt: string | null;
  readonly appendSystemPrompt: string | null;
}

interface LockedQueuedRun {
  readonly status: typeof agentRuns.$inferSelect.status;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProvider: string | null;
  readonly selectedModel: string | null;
}

interface PromoteQueuedCandidateArgs {
  readonly orgId: string;
  readonly row: QueueCandidate;
  readonly payload: QueuedRunnerJobPayload | null;
  readonly payloadFailure?: { readonly error: unknown };
}

interface PromotedRunnerJob {
  readonly createdAt: Date;
  readonly apiStartedAt: number;
  readonly profile: string;
  readonly executionContext: QueuedRunnerJobPayload["executionContext"];
}

type PreparedPendingRunActivation = Omit<PendingRunActivation, "timing">;

type PromoteQueuedCandidateNonPromotedResult =
  | { readonly status: "full" }
  | { readonly status: "removed-stale" }
  | { readonly status: "lost" };

interface PromotedQueuedCandidateTransactionResult {
  readonly status: "promoted";
  readonly pendingActivation: PreparedPendingRunActivation;
  readonly queueMarkerNotification: QueueMarkerRevokeNotification | null;
}

interface FailedQueuedCandidateTransactionResult {
  readonly status: "failed";
  readonly terminalTransition: QueuedRunPromotionFailure;
}

type PromotionResult =
  | PromotedQueuedCandidateTransactionResult
  | FailedQueuedCandidateTransactionResult
  | PromoteQueuedCandidateNonPromotedResult;

type PromoteQueuedCandidateResult =
  | {
      readonly status: "promoted";
      readonly pendingActivation: PreparedPendingRunActivation;
      readonly queueMarkerNotification: QueueMarkerRevokeNotification | null;
      readonly transactionReturnedAt: number;
    }
  | FailedQueuedCandidateTransactionResult
  | PromoteQueuedCandidateNonPromotedResult;

type PromoteQueuedCandidateSideEffectResult =
  | {
      readonly status: "drained";
      readonly pendingActivation: PendingRunActivation;
    }
  | {
      readonly status: "failed";
      readonly terminalTransition: QueuedRunPromotionFailure;
    }
  | { readonly status: "full" }
  | { readonly status: "skipped" };

interface QueuedRunPromotionFailure {
  readonly kind: "terminal";
  readonly runId: string;
  readonly orgId: string;
  readonly error: string;
  readonly queueMarkerNotification: QueueMarkerRevokeNotification | null;
}

type QueuedRunPromotionResult =
  | { readonly kind: "deferred"; readonly runId: string }
  | {
      readonly kind: "activation";
      readonly activation: PendingRunActivation;
    }
  | QueuedRunPromotionFailure;

interface TimedOutQueuedRunRow {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
}

export interface QueuedRunMaintenanceTimeout {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly error: string;
  readonly queueMarkerNotification: QueueMarkerRevokeNotification | null;
}

interface QueuedRunMaintenanceResult {
  readonly deletedCount: number;
  readonly timedOutRuns: readonly QueuedRunMaintenanceTimeout[];
}

async function timedOutQueuedRunsWithMarkerNotifications(
  tx: DbTransaction,
  rows: readonly TimedOutQueuedRunRow[],
  error: string,
): Promise<QueuedRunMaintenanceTimeout[]> {
  const timedOutRuns: QueuedRunMaintenanceTimeout[] = [];
  for (const row of rows) {
    timedOutRuns.push({
      ...row,
      error,
      queueMarkerNotification: await revokeQueuedRunAssistantMarkers(tx, {
        runId: row.runId,
        userId: row.userId,
      }),
    });
  }
  return timedOutRuns;
}

async function insertPromotedRunnerJob(
  tx: DbTransaction,
  args: {
    readonly orgId: string;
    readonly runId: string;
    readonly queuedAt: Date;
    readonly payload: QueuedRunnerJobPayload;
    readonly promotedAt: number;
  },
): Promise<PromotedRunnerJob> {
  const [remainingRow] = await tx
    .select({ depth: count() })
    .from(agentRunQueue)
    .where(eq(agentRunQueue.orgId, args.orgId));

  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "dequeue_agent_run",
    durationMs: Math.max(0, args.promotedAt - args.queuedAt.getTime()),
    success: true,
    runId: args.runId,
    dimensions: {
      queue_depth_at_dequeue: Number(remainingRow?.depth ?? 0),
    },
  });

  await writeRunMetadataInTransaction(tx, {
    patch: { apiStartedAt: new Date(args.promotedAt) },
    where: eq(agentRuns.id, args.runId),
  });

  const timestamps = runnerJobQueueTimestamps();
  const profile = args.payload.profile;
  const executionContext = refreshPiApiFirstTurnDeadline(
    args.payload.executionContext,
    args.promotedAt,
  );
  const [runnerJob] = await tx
    .insert(runnerJobQueue)
    .values({
      runId: args.runId,
      runnerGroup: args.payload.runnerGroup,
      profile,
      cliAgentSessionId: args.payload.cliAgentSessionId,
      reuseKey: args.payload.reuseKey,
      executionContext,
      ...timestamps,
    })
    .returning({ createdAt: runnerJobQueue.createdAt });
  if (!runnerJob) {
    throw new Error("Promoted runner job queue insert returned no row");
  }
  return {
    createdAt: runnerJob.createdAt,
    apiStartedAt: args.promotedAt,
    profile,
    executionContext,
  };
}

async function loadDrainCandidates(
  db: Db,
  orgId: string,
): Promise<readonly QueueCandidate[]> {
  const concurrency = await effectiveOrgConcurrencyState(db, orgId);
  if (concurrency.activeRunCount >= concurrency.limit) {
    return [];
  }

  return await db
    .select({
      runId: agentRunQueue.runId,
      agentId: agentSessions.agentId,
      resourceOwner: { userId: agents.owner, orgId: agents.orgId },
      userId: agentRunQueue.userId,
      runOwner: { userId: agentRuns.userId, orgId: agentRuns.orgId },
      createdAt: agentRunQueue.createdAt,
      encryptedParams: agentRunQueue.encryptedParams,
      runStatus: agentRuns.status,
      chatThreadId: agentRuns.chatThreadId,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
    })
    .from(agentRunQueue)
    .leftJoin(agentRuns, eq(agentRunQueue.runId, agentRuns.id))
    .leftJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .leftJoin(agents, eq(agents.id, agentSessions.agentId))
    .where(
      and(
        eq(agentRunQueue.orgId, orgId),
        sql`${agentRuns.error} IS DISTINCT FROM ${COMPUTE_CLOSURE_ERROR}`,
        sql`${agentRuns.triggerSource} IS DISTINCT FROM 'goal'`,
      ),
    )
    .orderBy(agentRunQueue.createdAt);
}

async function acquirePromotionAdmissionLock(
  tx: DbTransaction,
  orgId: string,
  timing: ApiDispatchTimingCollector,
): Promise<number> {
  await timing.measure(
    "api_dispatch_queue_promotion_lock_wait",
    "nested",
    async () => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);
    },
  );
  return now();
}

function finalizePromoteQueuedCandidate(
  timing: ApiDispatchTimingCollector,
  committed: {
    readonly result: PromotionResult;
    readonly lockHeldAt: number;
  },
): PromoteQueuedCandidateResult {
  const transactionReturnedAt = now();
  timing.recordElapsed(
    "api_dispatch_queue_promotion_lock_held",
    "nested",
    committed.lockHeldAt,
    transactionReturnedAt,
  );
  const result = committed.result;
  if (result.status !== "promoted") {
    return result;
  }
  const runnerNotification = result.pendingActivation.runnerNotification;
  // Promotion is durable now; later side-effect failures must not suppress it.
  timing.flush({
    runId: runnerNotification.runId,
    runnerGroup: runnerNotification.runnerGroup,
    profile: runnerNotification.profile,
    dispatchPath: "direct",
    dimensions: { activation_origin: "promotion" },
  });
  return {
    ...result,
    transactionReturnedAt,
  };
}

async function failQueuedRunAdmission(
  tx: DbTransaction,
  args: PromoteQueuedCandidateArgs,
  lockedRun: LockedQueuedRun,
  error: string,
): Promise<PromotionResult> {
  const [failed] = await transitionAgentRunsToTerminal(tx, {
    values: {
      status: "failed",
      completedAt: nowDate(),
      creditAdmitted: false,
      error,
      failureReason: "insufficient_credits",
    },
    conditions: [
      eq(agentRuns.id, args.row.runId),
      eq(agentRuns.status, "queued"),
      sql`(${legacySandboxRunPredicate()})`,
    ],
  });
  if (!failed) {
    return { status: "lost" };
  }
  await tx.delete(agentRunQueue).where(eq(agentRunQueue.runId, args.row.runId));
  const queueMarkerNotification = await revokeQueuedRunAssistantMarkers(tx, {
    runId: args.row.runId,
    userId: lockedRun.userId,
  });
  return {
    status: "failed",
    terminalTransition: {
      kind: "terminal",
      runId: args.row.runId,
      orgId: lockedRun.orgId,
      error,
      queueMarkerNotification,
    },
  };
}

async function promoteAdmittedQueuedRun(
  tx: DbTransaction,
  args: PromoteQueuedCandidateArgs,
  lockedRun: LockedQueuedRun,
  payload: QueuedRunnerJobPayload,
): Promise<PromotionResult> {
  const promotedAt = now();
  const [updated] = await tx
    .update(agentRuns)
    .set({
      status: "pending",
      lastHeartbeatAt: new Date(promotedAt),
      creditAdmitted: isBuiltInModelProviderType(lockedRun.modelProvider),
      runnerGroup: payload.runnerGroup,
    })
    .where(
      and(eq(agentRuns.id, args.row.runId), eq(agentRuns.status, "queued")),
    )
    .returning({ id: agentRuns.id });
  if (!updated) {
    return { status: "lost" };
  }

  await tx.delete(agentRunQueue).where(eq(agentRunQueue.runId, args.row.runId));
  const queueMarkerNotification = await revokeQueuedRunAssistantMarkers(tx, {
    runId: args.row.runId,
    userId: args.row.userId,
  });
  const runnerJob = await insertPromotedRunnerJob(tx, {
    orgId: args.orgId,
    runId: args.row.runId,
    queuedAt: args.row.createdAt,
    payload,
    promotedAt,
  });
  return {
    status: "promoted",
    queueMarkerNotification,
    pendingActivation: {
      apiStartTime: runnerJob.apiStartedAt,
      chatThreadId: args.row.chatThreadId ?? undefined,
      runnerNotification: {
        runId: args.row.runId,
        runnerGroup: payload.runnerGroup,
        profile: runnerJob.profile,
        reuseKey: payload.reuseKey,
        cliAgentSessionId: payload.cliAgentSessionId,
        historyGenerationRunId: payload.historyGenerationRunId,
        createdAt: runnerJob.createdAt,
      },
      ...(runnerJob.executionContext.piLaunchConfig &&
      !runnerJob.executionContext.piLaunchConfig.maintenance &&
      args.row.prompt !== null
        ? {
            piApiFirstTurn: {
              runId: args.row.runId,
              runnerGroup: payload.runnerGroup,
              userId: args.row.userId,
              orgId: args.orgId,
              prompt: args.row.prompt,
              appendSystemPrompt: args.row.appendSystemPrompt,
              executionContext: requirePiApiFirstTurnExecutionContext(
                runnerJob.executionContext,
              ),
            },
          }
        : {}),
    },
  };
}

async function promoteQueuedCandidateInTransaction(
  tx: DbTransaction,
  args: PromoteQueuedCandidateArgs,
  timing: ApiDispatchTimingCollector,
): Promise<{ readonly result: PromotionResult; readonly lockHeldAt: number }> {
  // A mismatch in the single discovery snapshot is persisted corruption, not
  // a resource disappearing while admission waits. Preserve its existing error.
  if (
    args.row.runOwner &&
    (args.row.runOwner.userId !== args.row.userId ||
      args.row.runOwner.orgId !== args.orgId)
  ) {
    throw new Error(
      `Queued run "${args.row.runId}" does not match its queue owner`,
    );
  }
  const admission = await prepareComputeRunAdmission(tx, args.row.runId, {
    userId: args.row.userId,
    orgId: args.orgId,
    agentId: args.row.agentId,
    resourceOwner: args.row.resourceOwner ?? undefined,
  });
  if (!admission) {
    return { result: { status: "lost" }, lockHeldAt: now() };
  }
  const lockHeldAt = await acquirePromotionAdmissionLock(
    tx,
    args.orgId,
    timing,
  );
  const complete = (result: PromotionResult) => {
    return { result, lockHeldAt };
  };
  await lockQueuedRunThreads(tx, [args.row.runId]);
  if (!(await validateComputeRunAdmission(tx, admission))) {
    return complete({ status: "lost" });
  }
  if (admission.closed) {
    await stopClosedComputeCandidate(tx, admission);
    return complete({ status: "lost" });
  }
  if (
    await hasEarlierDeferredDemand(
      tx,
      args.orgId,
      args.row.createdAt,
      args.row.runId,
    )
  ) {
    return complete({ status: "full" });
  }
  const concurrency = await effectiveOrgConcurrencyState(tx, args.orgId);
  if (concurrency.activeRunCount >= concurrency.limit) {
    return complete({ status: "full" });
  }

  const [lockedRun] = await tx
    .select({
      status: agentRuns.status,
      triggerSource: agentRuns.triggerSource,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      modelProvider: agentRuns.modelProvider,
      selectedModel: agentRuns.selectedModel,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.row.runId))
    .for("update");
  if (!lockedRun || lockedRun.status !== "queued") {
    await tx
      .delete(agentRunQueue)
      .where(eq(agentRunQueue.runId, args.row.runId));
    return complete({ status: "removed-stale" });
  }
  if (lockedRun.triggerSource === "goal") {
    return complete({ status: "lost" });
  }
  if (args.row.runStatus !== "queued") {
    return complete({ status: "lost" });
  }

  const [queueRow] = await tx
    .select({ runId: agentRunQueue.runId })
    .from(agentRunQueue)
    .where(
      and(
        eq(agentRunQueue.runId, args.row.runId),
        eq(agentRunQueue.orgId, args.orgId),
      ),
    )
    .limit(1);
  if (!queueRow) {
    return complete({ status: "lost" });
  }
  if (args.payload === null) {
    if (args.payloadFailure) {
      throw args.payloadFailure.error;
    }
    throw new Error(
      `Queued run "${args.row.runId}" is missing its runner job payload`,
    );
  }
  if (lockedRun.orgId !== args.orgId || lockedRun.userId !== args.row.userId) {
    throw new Error(
      `Queued run "${args.row.runId}" does not match its queue owner`,
    );
  }
  const admissionFailure = await checkOrgCreditsForRunAdmissionInTransaction({
    db: tx,
    orgId: lockedRun.orgId,
    userId: lockedRun.userId,
    modelProviderType: lockedRun.modelProvider,
    selectedModel: lockedRun.selectedModel,
  });
  const result = admissionFailure
    ? await failQueuedRunAdmission(
        tx,
        args,
        lockedRun,
        admissionFailure.body.error.message,
      )
    : await promoteAdmittedQueuedRun(tx, args, lockedRun, args.payload);
  return complete(result);
}

async function promoteQueuedCandidate(
  db: Db,
  args: PromoteQueuedCandidateArgs,
): Promise<PromoteQueuedCandidateResult> {
  // Promotion may outlive the create-run collector, so buffer timing until commit.
  const timing = new ApiDispatchTimingCollector();
  const committed = await withComputeOwnershipRetry(() => {
    return db.transaction(async (tx) => {
      return await promoteQueuedCandidateInTransaction(tx, args, timing);
    });
  });
  return finalizePromoteQueuedCandidate(timing, committed);
}

export async function publishQueueMarkerNotification(args: {
  readonly orgId: string;
  readonly queueMarkerNotification: QueueMarkerRevokeNotification | null;
}): Promise<void> {
  if (args.queueMarkerNotification) {
    await publishChatThreadMessageCreatedSafely({
      userId: args.queueMarkerNotification.userId,
      orgId: args.orgId,
      threadId: args.queueMarkerNotification.chatThreadId,
    });
    await publishThreadListChanged({
      userId: args.queueMarkerNotification.userId,
      orgId: args.orgId,
    });
  }
}

async function promoteQueuedCandidateWithSideEffects(
  db: Db,
  args: {
    readonly orgId: string;
    readonly row: QueueCandidate;
    readonly payload: QueuedRunnerJobPayload | null;
    readonly payloadFailure?: { readonly error: unknown };
  },
): Promise<PromoteQueuedCandidateSideEffectResult> {
  const result = await promoteQueuedCandidate(db, args);
  if (result.status === "removed-stale") {
    return { status: "skipped" };
  }
  if (result.status === "full") {
    return { status: "full" };
  }
  if (result.status === "lost") {
    L.debug("drainOrgQueue: queued run already transitioned, skipping", {
      runId: args.row.runId,
    });
    return { status: "skipped" };
  }
  if (result.status === "failed") {
    return result;
  }

  await publishQueueMarkerNotification({
    orgId: args.orgId,
    queueMarkerNotification: result.queueMarkerNotification,
  });
  const promotionSideEffectsRegisteredAt = now();
  return {
    status: "drained",
    pendingActivation: {
      ...result.pendingActivation,
      timing: {
        activationOrigin: "promotion",
        commitReturnedAt: result.transactionReturnedAt,
        promotionSideEffectsRegisteredAt,
      },
    },
  };
}

/**
 * Drain the org's queued runs after a concurrency slot frees up.
 *
 * Scope: API-created queue entries carry a prepared runner job payload
 * in `agent_run_queue.encrypted_params`. Draining promotes one queued run
 * to pending and inserts the matching `runner_job_queue` row so the runner
 * can claim it. A queued run without that payload violates the owning writer's
 * invariant and fails before any state transition.
 *
 * Candidate discovery is an unlocked snapshot. Final promotion acquires
 * `pg_advisory_xact_lock(hashtext(orgId))` and revalidates concurrency and
 * queue ownership before changing state.
 *
 * Returns the post-commit activation for one admitted run, the terminal
 * transition for one rejected run, or null when the queue is empty or
 * concurrency is full. The lifecycle owner must finish commit-owned side
 * effects even if its originating request was cancelled.
 */
export const promoteNextQueuedRun$ = command(
  async (
    { set },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<QueuedRunPromotionResult | null> => {
    const writeDb = set(writeDb$);

    const queueRows = await loadDrainCandidates(writeDb, args.orgId);
    signal.throwIfAborted();

    const deferredRows = await listDeferredPiCandidates(writeDb, args.orgId);
    signal.throwIfAborted();
    const candidates = [
      ...queueRows.map((row) => {
        return { kind: "legacy" as const, row };
      }),
      ...deferredRows.map((row) => {
        return { kind: "deferred" as const, row };
      }),
    ].sort((left, right) => {
      return (
        left.row.createdAt.getTime() - right.row.createdAt.getTime() ||
        left.row.runId.localeCompare(right.row.runId)
      );
    });
    for (const candidate of candidates) {
      if (candidate.kind === "deferred") {
        const result = await settle(
          set(consumeDeferredPiRun$, candidate.row.runId, signal),
        );
        signal.throwIfAborted();
        if (!result.ok) {
          await failWaitingPiCandidate(writeDb, candidate.row.runId);
          signal.throwIfAborted();
          await set(settleDeferredPiTerminal$, candidate.row.runId, signal);
          L.warn("Deferred Pi materialization awaits durable recovery", {
            runId: candidate.row.runId,
          });
        }
        if (result.ok && result.value) {
          return { kind: "deferred", runId: candidate.row.runId };
        }
        continue;
      }
      const row = candidate.row;
      const payloadResult =
        row.runStatus === "queued"
          ? await settle(decryptQueuedRunnerJobPayload(row.encryptedParams))
          : { ok: true as const, value: null };
      signal.throwIfAborted();
      const result = await promoteQueuedCandidateWithSideEffects(writeDb, {
        orgId: args.orgId,
        row,
        payload: payloadResult.ok ? payloadResult.value : null,
        ...(payloadResult.ok
          ? {}
          : { payloadFailure: { error: payloadResult.error } }),
      });
      // Promotion is durable now. Observe request cancellation for diagnostics,
      // but let the commit-owned activation finish independently.
      if (signal.aborted) {
        L.debug("Request aborted after queued run promotion commit", {
          runId: row.runId,
          orgId: args.orgId,
        });
      }
      if (result.status === "full") {
        return null;
      }
      if (result.status === "skipped") {
        continue;
      }
      if (result.status === "failed") {
        return result.terminalTransition;
      }
      return { kind: "activation", activation: result.pendingActivation };
    }

    return null;
  },
);

export const cleanupExpiredQueueEntries$ = command(
  async (
    { set },
    runIds: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<QueuedRunMaintenanceResult> => {
    const writeDb = set(writeDb$);
    const currentTime = nowDate();

    const result = await writeDb.transaction(async (tx) => {
      const expiredRunIds = tx
        .select({ runId: agentRunQueue.runId })
        .from(agentRunQueue)
        .where(
          and(
            lt(agentRunQueue.expiresAt, currentTime),
            runIds === null ? undefined : inArray(agentRunQueue.runId, runIds),
          ),
        );

      const discovered = await tx
        .select({
          runId: agentRuns.id,
        })
        .from(agentRuns)
        .where(
          and(
            inArray(agentRuns.id, expiredRunIds),
            eq(agentRuns.status, "queued"),
            sql`(${legacySandboxRunPredicate()})`,
          ),
        )
        .orderBy(agentRuns.createdAt, agentRuns.id);
      signal.throwIfAborted();

      const candidateRunIds = discovered.map((candidate) => {
        return candidate.runId;
      });
      await lockQueuedRunThreads(tx, candidateRunIds);
      if (candidateRunIds.length > 0) {
        await tx
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(inArray(agentRuns.id, candidateRunIds))
          .orderBy(agentRuns.createdAt, agentRuns.id)
          .for("update");
      }

      const timedOut =
        candidateRunIds.length === 0
          ? []
          : await transitionAgentRunsToTerminal(tx, {
              values: {
                status: "timeout",
                completedAt: currentTime,
                error: QUEUED_RUN_EXPIRED_REASON,
              },
              conditions: [
                inArray(agentRuns.id, candidateRunIds),
                eq(agentRuns.status, "queued"),
                sql`(${legacySandboxRunPredicate()})`,
                inArray(agentRuns.id, expiredRunIds),
              ],
            });
      const timedOutRuns = await timedOutQueuedRunsWithMarkerNotifications(
        tx,
        timedOut,
        QUEUED_RUN_EXPIRED_REASON,
      );

      const deletableRows = await tx
        .select({ runId: agentRunQueue.runId })
        .from(agentRunQueue)
        .leftJoin(agentRuns, eq(agentRunQueue.runId, agentRuns.id))
        .where(
          and(
            lt(agentRunQueue.expiresAt, currentTime),
            runIds === null ? undefined : inArray(agentRunQueue.runId, runIds),
            or(isNull(agentRuns.id), ne(agentRuns.status, "queued")),
            sql`${agentRuns.error} IS DISTINCT FROM ${COMPUTE_CLOSURE_ERROR}`,
          ),
        );

      if (deletableRows.length === 0) {
        return { deletedCount: 0, timedOutRuns };
      }

      const deleted = await tx
        .delete(agentRunQueue)
        .where(
          inArray(
            agentRunQueue.runId,
            deletableRows.map((entry) => {
              return entry.runId;
            }),
          ),
        )
        .returning({ runId: agentRunQueue.runId });

      return {
        deletedCount: deleted.length,
        timedOutRuns,
      };
    });
    signal.throwIfAborted();

    if (result.deletedCount > 0 || result.timedOutRuns.length > 0) {
      L.debug("Cleaned up expired queue entries", {
        count: result.deletedCount,
        timedOut: result.timedOutRuns.length,
      });
    }
    return result;
  },
);

export const cleanupQueuedRunLaunchOrphans$ = command(
  async (
    { set },
    cutoff: Date,
    runIds: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<QueuedRunMaintenanceResult> => {
    const writeDb = set(writeDb$);
    const currentTime = nowDate();

    const result = await writeDb.transaction(async (tx) => {
      const candidates = await tx
        .select({
          runId: agentRuns.id,
          orgId: agentRuns.orgId,
          userId: agentRuns.userId,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.status, "queued"),
            sql`(${legacySandboxRunPredicate()})`,
            lt(agentRuns.createdAt, cutoff),
            runIds === null ? undefined : inArray(agentRuns.id, runIds),
            notExists(
              tx
                .select({ runId: agentRunQueue.runId })
                .from(agentRunQueue)
                .where(eq(agentRunQueue.runId, agentRuns.id)),
            ),
          ),
        )
        .orderBy(agentRuns.createdAt, agentRuns.id);
      signal.throwIfAborted();

      if (candidates.length === 0) {
        return { deletedCount: 0, timedOutRuns: [] };
      }

      const candidateRunIds = candidates.map((candidate) => {
        return candidate.runId;
      });
      await lockQueuedRunThreads(tx, candidateRunIds);
      await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(inArray(agentRuns.id, candidateRunIds))
        .orderBy(agentRuns.createdAt, agentRuns.id)
        .for("update");

      // Queue persistence locks the run before inserting agent_run_queue. If
      // this transaction waited for that lock, re-check the queue table with a
      // fresh statement before timing out the run.
      const timedOut = await transitionAgentRunsToTerminal(tx, {
        values: {
          status: "timeout",
          completedAt: currentTime,
          error: QUEUED_RUN_LAUNCH_ORPHAN_REASON,
        },
        conditions: [
          eq(agentRuns.status, "queued"),
          sql`(${legacySandboxRunPredicate()})`,
          inArray(agentRuns.id, candidateRunIds),
          notExists(
            tx
              .select({ runId: agentRunQueue.runId })
              .from(agentRunQueue)
              .where(eq(agentRunQueue.runId, agentRuns.id)),
          ),
        ],
      });
      const timedOutRuns = await timedOutQueuedRunsWithMarkerNotifications(
        tx,
        timedOut,
        QUEUED_RUN_LAUNCH_ORPHAN_REASON,
      );

      return { deletedCount: 0, timedOutRuns };
    });
    signal.throwIfAborted();

    if (result.timedOutRuns.length > 0) {
      L.debug("Cleaned up queued run launch orphans", {
        timedOut: result.timedOutRuns.length,
      });
    }
    return result;
  },
);

export const staleQueueOrgIds$ = command(
  async (
    { set },
    orgIds: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    const writeDb = set(writeDb$);
    const legacyOrgsWithQueued = await writeDb
      .selectDistinct({ orgId: agentRunQueue.orgId })
      .from(agentRunQueue)
      .where(
        orgIds === null ? undefined : inArray(agentRunQueue.orgId, orgIds),
      );
    signal.throwIfAborted();

    const deferredOrgs = await writeDb
      .selectDistinct({ orgId: agentRuns.orgId })
      .from(agentRunSandboxIntent)
      .innerJoin(agentRuns, eq(agentRuns.id, agentRunSandboxIntent.runId))
      .where(
        and(
          eq(agentRunSandboxIntent.state, "waiting"),
          orgIds === null ? undefined : inArray(agentRuns.orgId, orgIds),
        ),
      );
    signal.throwIfAborted();
    const staleOrgIds: string[] = [];
    const orgsWithQueued = [
      ...new Set(
        [...legacyOrgsWithQueued, ...deferredOrgs].map((row) => {
          return row.orgId;
        }),
      ),
    ];
    for (const orgId of orgsWithQueued) {
      const capacity = await effectiveOrgConcurrencyState(writeDb, orgId);
      signal.throwIfAborted();
      if (capacity.activeRunCount < capacity.limit) {
        staleOrgIds.push(orgId);
      }
    }

    return staleOrgIds;
  },
);
