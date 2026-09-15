import {
  isPiInferenceRun,
  readPiInferenceLifecycle,
  piInferenceDeadline,
} from "./pi-inference-lifecycle.service";
import type { AgentRunLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { cleanupExpiredRunActivity$ } from "./run-activity-snapshot.service";
import { command } from "ccstate";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  COMPUTE_CLOSURE_ERROR,
  transitionAgentRunsToTerminal,
} from "./agent-run-terminal-transition.service";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { exportJobs } from "@okouai/db/schema/export-job";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import type { Tx } from "../../lib/db-types";
import { writeDb$, type Db } from "../external/db";
import {
  publishCancelToRunnerGroup,
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { deleteS3Objects } from "../external/s3";
import { settle, settleIncludingAbort, tapError } from "../utils";
import {
  dispatchCompleteSideEffects$,
  drainStaleQueues$,
} from "./agent-run-lifecycle.service";
import {
  cleanupExpiredQueueEntries$,
  cleanupQueuedRunLaunchOrphans$,
  type QueuedRunMaintenanceTimeout,
} from "./run-queue.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { drainStaleChatThreadQueues$ } from "./chat-thread-queue-drain.service";
import type { QueueMarkerRevokeNotification } from "./chat-queue-marker.service";
import { drainStaleCanonicalSlackIngress$ } from "./canonical-slack-ingress-processor.service";
import { drainStaleCanonicalFeishuIngress$ } from "./canonical-feishu-ingress-processor.service";
import { retryPendingFeishuConnectWelcomes$ } from "./feishu-welcome.service";
import {
  cleanupThreadlessRuns$,
  type ThreadlessRunCleanupResult,
} from "./threadless-run-cleanup.service";
import { cleanupExpiredPiApiFirstTurnData$ } from "./pi-api-first-turn-cleanup.service";
import { lockAgentRunCheckpointLifecycle } from "./agent-run-checkpoint-lifecycle-lock.service";
import { lockChatQueueThread } from "./chat-event-queue.service";
import {
  finalizeActiveInputDelivery,
  type FinalizeActiveInputDeliveryResult,
} from "./active-input-delivery.service";

const L = logger("CronCleanupSandboxes");

const HEARTBEAT_TIMEOUT_MS = 2 * 60 * 1000;
const DEBUG_HEARTBEAT_TIMEOUT_MS = 60 * 60 * 1000;
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;
const DEBUG_COMPOSE_PREFIX = "debug-";
const EXPORT_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const CONNECTOR_DIAGNOSTIC_REGISTRATION_CLEANUP_BATCH_SIZE = 20;
const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "timeout",
  "cancelled",
] as const;

interface CleanupResult {
  readonly runId: string;
  readonly sandboxId: string | null;
  readonly status: "cleaned" | "error";
  readonly error?: string;
  readonly reason?: string;
}

interface CleanupSandboxesResult {
  readonly cleaned: number;
  readonly errors: number;
  readonly results: readonly CleanupResult[];
  readonly exportJobsCleaned: number;
  readonly exportJobsStuck: number;
  readonly threadlessRuns: ThreadlessRunCleanupResult;
}

type CleanupSandboxesScope =
  | { readonly kind: "global" }
  | {
      readonly kind: "fixtures";
      readonly chatThreadIds: readonly string[];
      readonly runIds: readonly string[];
      readonly orgIds: readonly string[];
      readonly exportJobIds: readonly string[];
    };

interface StaleRun {
  readonly launchSnapshot: AgentRunLaunchSnapshot | null;
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: string;
  readonly sandboxId: string | null;
  readonly runnerGroup: string | null;
  readonly chatThreadId: string | null;
  readonly lastHeartbeatAt: Date | null;
  readonly createdAt: Date;
  readonly composeName: string | null;
}

interface CleanupCutoffs {
  readonly running: Date;
  readonly debug: Date;
  readonly pending: Date;
}

interface MaintenanceTerminalSideEffectsInput {
  readonly runId: string;
  readonly orgId: string;
  readonly error: string;
  readonly queueMarkerNotification: QueueMarkerRevokeNotification | null;
  readonly deliveryNotification?: {
    readonly userId: string;
    readonly chatThreadId: string;
    readonly chatEventsAppended: boolean;
  };
}

interface LockedTimeoutRun {
  readonly launchSnapshot: AgentRunLaunchSnapshot | null;
  readonly status: string;
  readonly orgId: string;
  readonly userId: string;
  readonly sandboxId: string | null;
  readonly runnerGroup: string | null;
  readonly chatThreadId: string | null;
  readonly lastHeartbeatAt: Date | null;
  readonly createdAt: Date;
}

interface CommittedTimeout {
  readonly previousStatus: "pending" | "running";
  readonly orgId: string;
  readonly userId: string;
  readonly sandboxId: string | null;
  readonly runnerGroup: string | null;
  readonly chatThreadId: string | null;
  readonly finalization: FinalizeActiveInputDeliveryResult;
}

type TimeoutTransactionResult =
  | { readonly kind: "retry"; readonly chatThreadId: string | null }
  | { readonly kind: "skipped" }
  | { readonly kind: "committed"; readonly timeout: CommittedTimeout };

function staleRunCutoff(run: StaleRun, cutoffs: CleanupCutoffs): Date {
  if (run.status === "pending") {
    return cutoffs.pending;
  }

  const isDebug = run.composeName?.startsWith(DEBUG_COMPOSE_PREFIX) ?? false;
  return isDebug ? cutoffs.debug : cutoffs.running;
}

function isExpiredRun(run: StaleRun, cutoffs: CleanupCutoffs): boolean {
  const referenceTime = run.lastHeartbeatAt ?? run.createdAt;
  return referenceTime < staleRunCutoff(run, cutoffs);
}

async function publishQueueMarkerNotificationSafely(
  orgId: string,
  notification: QueueMarkerRevokeNotification,
): Promise<void> {
  await publishChatThreadMessageCreatedSafely({
    userId: notification.userId,
    orgId,
    threadId: notification.chatThreadId,
  });
  await publishThreadListChanged({ userId: notification.userId, orgId });
}

async function lockTimeoutRun(
  tx: Tx,
  runId: string,
): Promise<LockedTimeoutRun | null> {
  const [run] = await tx
    .select({
      status: agentRuns.status,
      launchSnapshot: agentRuns.launchSnapshot,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      sandboxId: agentRuns.sandboxId,
      runnerGroup: agentRuns.runnerGroup,
      chatThreadId: agentRuns.chatThreadId,
      lastHeartbeatAt: agentRuns.lastHeartbeatAt,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update", { of: agentRuns })
    .limit(1);
  return run ?? null;
}

const cleanupExportJobs$ = command(
  async (
    { get },
    db: Db,
    exportJobIds: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<{
    readonly exportJobsCleaned: number;
    readonly exportJobsStuck: number;
  }> => {
    let exportJobsCleaned = 0;
    let exportJobsStuck = 0;
    const currentTime = nowDate();

    const expiredExports = await db
      .select({ id: exportJobs.id, s3Key: exportJobs.s3Key })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.status, "completed"),
          isNotNull(exportJobs.expiresAt),
          lt(exportJobs.expiresAt, currentTime),
          exportJobIds === null
            ? undefined
            : inArray(exportJobs.id, exportJobIds),
        ),
      );
    signal.throwIfAborted();

    if (expiredExports.length > 0) {
      const s3Keys = expiredExports
        .map((entry) => {
          return entry.s3Key;
        })
        .filter((key): key is string => {
          return key !== null;
        });
      if (s3Keys.length > 0) {
        await get(deleteS3Objects(env("R2_USER_STORAGES_BUCKET_NAME"), s3Keys));
        signal.throwIfAborted();
      }

      await db.delete(exportJobs).where(
        inArray(
          exportJobs.id,
          expiredExports.map((entry) => {
            return entry.id;
          }),
        ),
      );
      signal.throwIfAborted();

      exportJobsCleaned = expiredExports.length;
      L.debug("Cleaned up expired export jobs", { count: exportJobsCleaned });
    }

    const stuckCutoffTime = new Date(now() - EXPORT_JOB_TIMEOUT_MS);
    const stuckExportJobs = await db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(
        and(
          inArray(exportJobs.status, ["pending", "running"]),
          lt(exportJobs.createdAt, stuckCutoffTime),
          exportJobIds === null
            ? undefined
            : inArray(exportJobs.id, exportJobIds),
        ),
      );
    signal.throwIfAborted();

    for (const job of stuckExportJobs) {
      await db
        .update(exportJobs)
        .set({
          status: "failed",
          completedAt: currentTime,
          error: "Export job timed out",
        })
        .where(
          and(
            eq(exportJobs.id, job.id),
            inArray(exportJobs.status, ["pending", "running"]),
          ),
        );
      signal.throwIfAborted();
      exportJobsStuck++;
    }

    if (exportJobsStuck > 0) {
      L.debug("Failed stuck export jobs", { count: exportJobsStuck });
    }

    return { exportJobsCleaned, exportJobsStuck };
  },
);

const dispatchMaintenanceTerminalSideEffects$ = command(
  async (
    { set },
    input: MaintenanceTerminalSideEffectsInput,
    signal: AbortSignal,
  ): Promise<void> => {
    if (input.queueMarkerNotification) {
      await publishQueueMarkerNotificationSafely(
        input.orgId,
        input.queueMarkerNotification,
      );
    }

    await set(
      dispatchCompleteSideEffects$,
      {
        kind: "terminal",
        runId: input.runId,
        orgId: input.orgId,
        status: "failed",
        error: input.error,
        ...(input.deliveryNotification
          ? { deliveryNotification: input.deliveryNotification }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();
  },
);

async function commitStaleRunTimeout(
  db: Db,
  run: StaleRun,
  cutoff: Date,
  timeoutReason: string,
  signal: AbortSignal,
): Promise<CommittedTimeout | undefined> {
  let expectedChatThreadId = run.chatThreadId;
  while (true) {
    const result = await db.transaction(
      async (tx): Promise<TimeoutTransactionResult> => {
        await lockAgentRunCheckpointLifecycle(tx, run.id);
        signal.throwIfAborted();
        const threadLocked =
          expectedChatThreadId === null
            ? false
            : await lockChatQueueThread(tx, expectedChatThreadId);
        signal.throwIfAborted();
        const lockedRun = await lockTimeoutRun(tx, run.id);
        signal.throwIfAborted();
        if (!lockedRun) {
          return { kind: "skipped" };
        }
        if (lockedRun.chatThreadId !== expectedChatThreadId) {
          return { kind: "retry", chatThreadId: lockedRun.chatThreadId };
        }
        if (expectedChatThreadId !== null && !threadLocked) {
          throw new Error("Agent run retained a missing chat thread");
        }
        if (
          lockedRun.status !== run.status ||
          (lockedRun.status !== "pending" && lockedRun.status !== "running")
        ) {
          return { kind: "skipped" };
        }
        const referenceTime = lockedRun.lastHeartbeatAt ?? lockedRun.createdAt;
        const lifecycle = await readPiInferenceLifecycle(
          tx,
          run.id,
          lockedRun.launchSnapshot,
        );
        if (lifecycle) {
          const deadlineExpired =
            piInferenceDeadline(lifecycle).getTime() <= now();
          const heartbeatExpired =
            lifecycle.inference.phase === "sandbox_running" &&
            referenceTime < cutoff;
          if (!deadlineExpired && !heartbeatExpired) {
            return { kind: "skipped" };
          }
        } else if (referenceTime >= cutoff) {
          return { kind: "skipped" };
        }

        const finalization =
          lockedRun.status === "running" && lockedRun.chatThreadId !== null
            ? await finalizeActiveInputDelivery(tx, {
                runId: run.id,
                chatThreadId: lockedRun.chatThreadId,
                deliveredDeliveryIds: new Set<string>(),
              })
            : { finalized: false, chatEventsAppended: false };
        signal.throwIfAborted();

        const [updatedRun] = await transitionAgentRunsToTerminal(tx, {
          values: {
            status: "timeout",
            completedAt: nowDate(),
            error: timeoutReason,
          },
          conditions: [
            eq(agentRuns.id, run.id),
            eq(agentRuns.status, lockedRun.status),
          ],
        });
        signal.throwIfAborted();
        if (!updatedRun) {
          throw new Error("Locked stale run lost its timeout transition");
        }

        await tx.delete(runnerJobQueue).where(eq(runnerJobQueue.runId, run.id));
        signal.throwIfAborted();

        return {
          kind: "committed",
          timeout: {
            previousStatus: lockedRun.status,
            orgId: lockedRun.orgId,
            userId: lockedRun.userId,
            sandboxId: lockedRun.sandboxId,
            runnerGroup: lockedRun.runnerGroup,
            chatThreadId: lockedRun.chatThreadId,
            finalization,
          },
        };
      },
    );
    signal.throwIfAborted();
    if (result.kind === "retry") {
      expectedChatThreadId = result.chatThreadId;
      continue;
    }
    return result.kind === "committed" ? result.timeout : undefined;
  }
}

const cleanupSingleRun$ = command(
  async (
    { set },
    db: Db,
    run: StaleRun,
    cutoffs: CleanupCutoffs,
    signal: AbortSignal,
  ): Promise<CleanupResult | undefined> => {
    const timeoutReason = isPiInferenceRun(run.launchSnapshot)
      ? "Pi inference or Sandbox phase deadline expired"
      : run.status === "pending"
        ? "Run timed out while pending (never started)"
        : "Run timed out (no heartbeat)";
    const cutoff = staleRunCutoff(run, cutoffs);
    const committed = await commitStaleRunTimeout(
      db,
      run,
      cutoff,
      timeoutReason,
      signal,
    );
    signal.throwIfAborted();

    if (!committed) {
      L.debug("Run already transitioned, skipping timeout", { runId: run.id });
      return undefined;
    }

    if (committed.previousStatus === "running" && committed.runnerGroup) {
      const cancellation = await settleIncludingAbort(
        publishCancelToRunnerGroup(committed.runnerGroup, run.id, "hard"),
      );
      signal.throwIfAborted();
      if (!cancellation.ok) {
        L.error("Failed to publish timeout cancel to runner group", {
          runId: run.id,
          runnerGroup: committed.runnerGroup,
          error: cancellation.error,
        });
      }
    }

    await set(
      dispatchMaintenanceTerminalSideEffects$,
      {
        runId: run.id,
        orgId: committed.orgId,
        error: timeoutReason,
        queueMarkerNotification: null,
        ...(committed.chatThreadId !== null
          ? {
              deliveryNotification: {
                userId: committed.userId,
                chatThreadId: committed.chatThreadId,
                chatEventsAppended: committed.finalization.chatEventsAppended,
              },
            }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    const isDebug = run.composeName?.startsWith(DEBUG_COMPOSE_PREFIX) ?? false;
    const referenceTime = run.lastHeartbeatAt ?? run.createdAt;
    L.debug("Cleaned up expired run", {
      runId: run.id,
      status: run.status,
      sandboxId: committed.sandboxId,
      composeName: run.composeName,
      isDebug,
      referenceTime: referenceTime.toISOString(),
    });

    return {
      runId: run.id,
      sandboxId: committed.sandboxId,
      status: "cleaned",
      reason: timeoutReason,
    };
  },
);

const cleanupQueuedTerminalRuns$ = command(
  async (
    { set },
    runs: readonly QueuedRunMaintenanceTimeout[],
    signal: AbortSignal,
  ): Promise<CleanupResult[]> => {
    const results: CleanupResult[] = [];
    for (const run of runs) {
      const cleanupResult = await settle(
        set(
          dispatchMaintenanceTerminalSideEffects$,
          {
            runId: run.runId,
            orgId: run.orgId,
            error: run.error,
            queueMarkerNotification: run.queueMarkerNotification,
          },
          signal,
        ),
      );
      signal.throwIfAborted();

      if (cleanupResult.ok) {
        results.push({
          runId: run.runId,
          sandboxId: null,
          status: "cleaned",
          reason: run.error,
        });
        continue;
      }

      const errorMessage =
        cleanupResult.error instanceof Error
          ? cleanupResult.error.message
          : "Unknown error";
      L.error("Failed to dispatch queued run timeout side effects", {
        runId: run.runId,
        error: errorMessage,
      });
      results.push({
        runId: run.runId,
        sandboxId: null,
        status: "error",
        error: errorMessage,
      });
    }
    return results;
  },
);

const cleanupExpiredRuns$ = command(
  async (
    { set },
    db: Db,
    runs: readonly StaleRun[],
    cutoffs: CleanupCutoffs,
    signal: AbortSignal,
  ): Promise<CleanupResult[]> => {
    const results: CleanupResult[] = [];
    for (const run of runs) {
      const cleanupResult = await settle(
        set(cleanupSingleRun$, db, run, cutoffs, signal),
      );
      signal.throwIfAborted();

      if (cleanupResult.ok) {
        if (cleanupResult.value) {
          results.push(cleanupResult.value);
        }
        continue;
      }

      const errorMessage =
        cleanupResult.error instanceof Error
          ? cleanupResult.error.message
          : "Unknown error";
      L.error("Failed to cleanup run", {
        runId: run.id,
        error: errorMessage,
      });
      results.push({
        runId: run.id,
        sandboxId: run.sandboxId,
        status: "error",
        error: errorMessage,
      });
    }
    return results;
  },
);

async function cleanupExpiredRunnerJobs(
  db: Db,
  runIds: readonly string[] | null,
  signal: AbortSignal,
): Promise<number> {
  const deletedCount = await db.transaction(async (tx) => {
    // Lock run before queue, as claims do. Recheck closure after waiting so an
    // in-flight TTL statement cannot discard a newly retained locator.
    const candidates = await tx
      .select({ runId: agentRuns.id })
      .from(agentRuns)
      .innerJoin(runnerJobQueue, eq(runnerJobQueue.runId, agentRuns.id))
      .where(
        and(
          lte(runnerJobQueue.expiresAt, sql`now()`),
          sql`${agentRuns.error} IS DISTINCT FROM ${COMPUTE_CLOSURE_ERROR}`,
          runIds === null ? undefined : inArray(agentRuns.id, runIds),
        ),
      )
      .orderBy(agentRuns.createdAt, agentRuns.id)
      .limit(100)
      .for("update", { of: agentRuns });
    if (candidates.length === 0) {
      return 0;
    }
    const { rowCount } = await tx.delete(runnerJobQueue).where(
      and(
        inArray(
          runnerJobQueue.runId,
          candidates.map((row) => {
            return row.runId;
          }),
        ),
        lte(runnerJobQueue.expiresAt, sql`now()`),
      ),
    );
    return rowCount ?? 0;
  });
  signal.throwIfAborted();

  if (deletedCount > 0) {
    L.debug("Cleaned up expired runner job queue entries", {
      count: deletedCount,
    });
  }
  return deletedCount;
}

async function cleanupConnectorDiagnosticRegistrations(
  db: Db,
  runIds: readonly string[] | null,
  signal: AbortSignal,
): Promise<number> {
  const candidates = db
    .select({ runId: agentRunConnectorDiagnosticRegistrations.runId })
    .from(agentRunConnectorDiagnosticRegistrations)
    .leftJoin(
      agentRuns,
      eq(agentRuns.id, agentRunConnectorDiagnosticRegistrations.runId),
    )
    .where(
      and(
        or(
          isNull(agentRuns.id),
          inArray(agentRuns.status, TERMINAL_RUN_STATUSES),
        ),
        sql`${agentRuns.error} IS DISTINCT FROM ${COMPUTE_CLOSURE_ERROR}`,
        runIds === null
          ? undefined
          : inArray(agentRunConnectorDiagnosticRegistrations.runId, runIds),
      ),
    )
    .orderBy(
      agentRunConnectorDiagnosticRegistrations.createdAt,
      agentRunConnectorDiagnosticRegistrations.runId,
    )
    .limit(CONNECTOR_DIAGNOSTIC_REGISTRATION_CLEANUP_BATCH_SIZE);
  const deleted = await db
    .delete(agentRunConnectorDiagnosticRegistrations)
    .where(inArray(agentRunConnectorDiagnosticRegistrations.runId, candidates))
    .returning({ runId: agentRunConnectorDiagnosticRegistrations.runId });
  signal.throwIfAborted();

  if (deleted.length > 0) {
    L.debug("Cleaned up terminal connector diagnostic registrations", {
      count: deleted.length,
    });
  }
  return deleted.length;
}

function logQueueMaintenance(args: {
  readonly expired: number;
  readonly expiredTimedOut: number;
  readonly launchOrphansTimedOut: number;
  readonly expiredRunnerJobs: number;
  readonly drained: number;
}): void {
  if (
    Object.values(args).every((count) => {
      return count === 0;
    })
  ) {
    return;
  }
  L.debug("Queue maintenance completed", args);
}

const cleanupGlobalMaintenance$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(
      drainStaleChatThreadQueues$,
      { dispatchFailedCallbacks: dispatchFailedRunCallbacks },
      signal,
    );
    signal.throwIfAborted();
    await tapError(set(drainStaleCanonicalSlackIngress$, signal), (error) => {
      L.error("Failed to drain stale canonical Slack ingress", { error });
    });
    signal.throwIfAborted();
    await tapError(set(drainStaleCanonicalFeishuIngress$, signal), (error) => {
      L.error("Failed to drain stale canonical Feishu ingress", { error });
    });
    signal.throwIfAborted();
    await tapError(set(retryPendingFeishuConnectWelcomes$, signal), (error) => {
      L.error("Failed to retry Feishu connect welcomes", { error });
    });
    signal.throwIfAborted();
    await set(cleanupExpiredRunActivity$, null, signal);
    signal.throwIfAborted();
    await set(cleanupExpiredPiApiFirstTurnData$, signal);
    signal.throwIfAborted();
  },
);

const cleanupFixtureMaintenance$ = command(
  async (
    { set },
    scope: Extract<CleanupSandboxesScope, { kind: "fixtures" }>,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(cleanupExpiredRunActivity$, scope.runIds, signal);
    signal.throwIfAborted();
    await set(
      drainStaleChatThreadQueues$,
      {
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        chatThreadIds: scope.chatThreadIds,
      },
      signal,
    );
  },
);

export const cleanupSandboxes$ = command(
  async (
    { set },
    scope: CleanupSandboxesScope,
    signal: AbortSignal,
  ): Promise<CleanupSandboxesResult> => {
    const db = set(writeDb$);
    const runIds = scope.kind === "global" ? null : scope.runIds;
    const orgIds = scope.kind === "global" ? null : scope.orgIds;
    const currentTime = now();
    const cutoffs = {
      running: new Date(currentTime - HEARTBEAT_TIMEOUT_MS),
      debug: new Date(currentTime - DEBUG_HEARTBEAT_TIMEOUT_MS),
      pending: new Date(currentTime - PENDING_TIMEOUT_MS),
    };

    L.debug("Checking for expired runs", {
      runningBefore: cutoffs.running.toISOString(),
      pendingBefore: cutoffs.pending.toISOString(),
      debugBefore: cutoffs.debug.toISOString(),
    });

    const staleRuns = await db
      .select({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
        status: agentRuns.status,
        launchSnapshot: agentRuns.launchSnapshot,
        sandboxId: agentRuns.sandboxId,
        runnerGroup: agentRuns.runnerGroup,
        chatThreadId: agentRuns.chatThreadId,
        lastHeartbeatAt: agentRuns.lastHeartbeatAt,
        createdAt: agentRuns.createdAt,
        composeName: agents.name,
      })
      .from(agentRuns)
      .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
      .leftJoin(agents, eq(agentSessions.agentId, agents.id))
      .where(
        and(
          inArray(agentRuns.status, ["pending", "running"]),
          runIds === null ? undefined : inArray(agentRuns.id, runIds),
        ),
      );
    signal.throwIfAborted();

    // New owners are inspected under the per-run error boundary and run lock.
    const expiredRuns = staleRuns.filter((run) => {
      return isPiInferenceRun(run.launchSnapshot) || isExpiredRun(run, cutoffs);
    });

    // Run before generic queue maintenance so an active threadless run always
    // takes the hard-cancel path and can never become terminal and be deleted
    // within the same maintenance pass.
    const threadlessRuns = await set(cleanupThreadlessRuns$, runIds, signal);
    signal.throwIfAborted();

    const expiredQueueResult = await set(
      cleanupExpiredQueueEntries$,
      runIds,
      signal,
    );
    signal.throwIfAborted();
    const queuedOrphanResult = await set(
      cleanupQueuedRunLaunchOrphans$,
      cutoffs.pending,
      runIds,
      signal,
    );
    signal.throwIfAborted();
    const expiredRunnerJobCount = await cleanupExpiredRunnerJobs(
      db,
      runIds,
      signal,
    );
    signal.throwIfAborted();
    await cleanupConnectorDiagnosticRegistrations(db, runIds, signal);
    signal.throwIfAborted();
    const drainedCount = await set(drainStaleQueues$, orgIds, signal);
    signal.throwIfAborted();
    if (scope.kind === "global") {
      await set(cleanupGlobalMaintenance$, signal);
    } else {
      await set(cleanupFixtureMaintenance$, scope, signal);
    }
    signal.throwIfAborted();
    const queuedTerminalRuns = [
      ...expiredQueueResult.timedOutRuns,
      ...queuedOrphanResult.timedOutRuns,
    ];
    logQueueMaintenance({
      expired: expiredQueueResult.deletedCount,
      expiredTimedOut: expiredQueueResult.timedOutRuns.length,
      launchOrphansTimedOut: queuedOrphanResult.timedOutRuns.length,
      expiredRunnerJobs: expiredRunnerJobCount,
      drained: drainedCount,
    });

    L.debug("Run timeout candidates", { count: expiredRuns.length });

    const queuedResults = await set(
      cleanupQueuedTerminalRuns$,
      queuedTerminalRuns,
      signal,
    );
    signal.throwIfAborted();
    const expiredRunResults = await set(
      cleanupExpiredRuns$,
      db,
      expiredRuns,
      cutoffs,
      signal,
    );
    signal.throwIfAborted();
    const results = [...queuedResults, ...expiredRunResults];

    const { exportJobsCleaned, exportJobsStuck } = await set(
      cleanupExportJobs$,
      db,
      scope.kind === "global" ? null : scope.exportJobIds,
      signal,
    );

    return {
      cleaned: results.filter((result) => {
        return result.status === "cleaned";
      }).length,
      errors: results.filter((result) => {
        return result.status === "error";
      }).length,
      results,
      exportJobsCleaned,
      exportJobsStuck,
      threadlessRuns,
    };
  },
);
