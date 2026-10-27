import type { AgentRunLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { command } from "ccstate";
import { eq, inArray, isNull, or } from "drizzle-orm";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  publishCancelToRunnerGroup,
  publishRunQueueChangedForOrgSafely,
} from "../external/realtime";
import { settle, settleIncludingAbort, tapError } from "../utils";
import { expireRunTimeBudgetInput$ } from "./active-input-delivery.service";
import { dispatchCompleteSideEffects$ } from "./agent-run-lifecycle.service";
import { scheduleReleasedSlotPicks$ } from "./agent-run-slot-scheduling.service";
import { commitStaleRunTimeout$ } from "./agent-run-terminal-transition.service";
import { drainStaleCanonicalDiscordIngress$ } from "./canonical-discord-ingress-processor.service";
import { drainStaleCanonicalFeishuIngress$ } from "./canonical-feishu-ingress-processor.service";
import { drainStaleCanonicalSlackIngress$ } from "./canonical-slack-ingress-processor.service";
import { pickAllQueuedOrgs$ } from "./chat-thread-queue-drain.service";
import { retryPendingFeishuConnectWelcomes$ } from "./feishu-welcome.service";
import { releaseStaleTerminalActiveAgentRuns$ } from "./run-activity.service";
import { cleanupExpiredRunnerJobs$ } from "./runner-job-queue-lifecycle.service";
import {
  cleanupThreadlessRuns$,
  type ThreadlessRunCleanupResult,
} from "./threadless-run-cleanup.service";

import { cleanupExpiredExportJobs$ } from "./user-export-cleanup.service";

const L = logger("CronCleanupSandboxes");

const HEARTBEAT_TIMEOUT_MS = 2 * 60 * 1000;
const DEBUG_HEARTBEAT_TIMEOUT_MS = 60 * 60 * 1000;
const PENDING_TIMEOUT_MS = 5 * 60 * 1000;
const DEBUG_COMPOSE_PREFIX = "debug-";
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

interface StaleRun {
  readonly launchSnapshot: AgentRunLaunchSnapshot | null;
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: string;
  readonly sandboxId: string | null;
  readonly runnerGroup: string | null;
  readonly chatThreadId: string | null;
  readonly lastHeartbeatAt: Date;
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
  readonly deliveryNotification?: {
    readonly userId: string;
    readonly chatThreadId: string;
    readonly chatEventsAppended: boolean;
  };
}

function staleRunCutoff(run: StaleRun, cutoffs: CleanupCutoffs): Date {
  if (run.status === "pending") {
    return cutoffs.pending;
  }

  const isDebug = run.composeName?.startsWith(DEBUG_COMPOSE_PREFIX) ?? false;
  return isDebug ? cutoffs.debug : cutoffs.running;
}

function isExpiredRun(run: StaleRun, cutoffs: CleanupCutoffs): boolean {
  return run.lastHeartbeatAt < staleRunCutoff(run, cutoffs);
}

const dispatchMaintenanceTerminalSideEffects$ = command(
  async (
    { set },
    input: MaintenanceTerminalSideEffectsInput,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchCompleteSideEffects$,
      {
        kind: "terminal",
        firstTerminalTransition: true,
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

const cleanupSingleRun$ = command(
  async (
    { set },
    run: StaleRun,
    cutoffs: CleanupCutoffs,
    signal: AbortSignal,
  ): Promise<CleanupResult | undefined> => {
    const timeoutReason =
      run.status === "pending"
        ? "Run timed out while pending (never started)"
        : "Run timed out (no heartbeat)";
    const cutoff = staleRunCutoff(run, cutoffs);
    const committed = await set(
      commitStaleRunTimeout$,
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
    set(scheduleReleasedSlotPicks$, committed.releasedSlots, signal);
    const budgetExpired =
      committed.previousStatus === "running" && committed.chatThreadId !== null
        ? await set(
            expireRunTimeBudgetInput$,
            { runId: run.id, chatThreadId: committed.chatThreadId },
            signal,
          )
        : false;

    await publishRunQueueChangedForOrgSafely(committed.orgId);
    signal.throwIfAborted();

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
        ...(committed.chatThreadId !== null
          ? {
              deliveryNotification: {
                userId: committed.userId,
                chatThreadId: committed.chatThreadId,
                chatEventsAppended: budgetExpired,
              },
            }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    const isDebug = run.composeName?.startsWith(DEBUG_COMPOSE_PREFIX) ?? false;
    L.debug("Cleaned up expired run", {
      runId: run.id,
      status: run.status,
      sandboxId: committed.sandboxId,
      composeName: run.composeName,
      isDebug,
      referenceTime: run.lastHeartbeatAt.toISOString(),
    });

    return {
      runId: run.id,
      sandboxId: committed.sandboxId,
      status: "cleaned",
      reason: timeoutReason,
    };
  },
);

const cleanupExpiredRuns$ = command(
  async (
    { set },
    runs: readonly StaleRun[],
    cutoffs: CleanupCutoffs,
    signal: AbortSignal,
  ): Promise<CleanupResult[]> => {
    const results: CleanupResult[] = [];
    for (const run of runs) {
      const cleanupResult = await settle(
        set(cleanupSingleRun$, run, cutoffs, signal),
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

const cleanupGlobalMaintenance$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    // Release silent terminal runs first so the org pick can admit the
    // threads they held in the same pass.
    await set(releaseStaleTerminalActiveAgentRuns$, signal);
    signal.throwIfAborted();
    await set(pickAllQueuedOrgs$, signal);
    signal.throwIfAborted();
    await tapError(set(drainStaleCanonicalSlackIngress$, signal), (error) => {
      L.error("Failed to drain stale canonical Slack ingress", { error });
    });
    signal.throwIfAborted();
    await tapError(set(drainStaleCanonicalDiscordIngress$, signal), (error) => {
      L.error("Failed to drain stale canonical Discord ingress", { error });
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
  },
);

export const cleanupSandboxes$ = command(
  async ({ set }, signal: AbortSignal): Promise<CleanupSandboxesResult> => {
    const db = set(writeDb$);
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
        lastHeartbeatAt: activeAgentRuns.lastHeartbeatAt,
        composeName: agents.name,
      })
      .from(activeAgentRuns)
      .innerJoin(agentRuns, eq(agentRuns.id, activeAgentRuns.runId))

      .leftJoin(agents, eq(agentRuns.agentId, agents.id))
      .where(inArray(agentRuns.status, ["pending", "running"]));
    signal.throwIfAborted();

    const expiredRuns = staleRuns.filter((run) => {
      return isExpiredRun(run, cutoffs);
    });

    // Run before expired-run timeouts so an active threadless run always
    // takes the hard-cancel path and can never become terminal and be deleted
    // within the same maintenance pass.
    const threadlessRuns = await set(cleanupThreadlessRuns$, signal);
    signal.throwIfAborted();

    await set(cleanupExpiredRunnerJobs$, signal);
    signal.throwIfAborted();
    await (async (signal: AbortSignal): Promise<number> => {
      const candidates = db
        .select({ runId: agentRunConnectorDiagnosticRegistrations.runId })
        .from(agentRunConnectorDiagnosticRegistrations)
        .leftJoin(
          agentRuns,
          eq(agentRuns.id, agentRunConnectorDiagnosticRegistrations.runId),
        )
        .where(
          or(
            isNull(agentRuns.id),
            inArray(agentRuns.status, TERMINAL_RUN_STATUSES),
          ),
        )
        .orderBy(
          agentRunConnectorDiagnosticRegistrations.createdAt,
          agentRunConnectorDiagnosticRegistrations.runId,
        )
        .limit(CONNECTOR_DIAGNOSTIC_REGISTRATION_CLEANUP_BATCH_SIZE);
      const deleted = await db
        .delete(agentRunConnectorDiagnosticRegistrations)
        .where(
          inArray(agentRunConnectorDiagnosticRegistrations.runId, candidates),
        )
        .returning({ runId: agentRunConnectorDiagnosticRegistrations.runId });
      signal.throwIfAborted();

      if (deleted.length > 0) {
        L.debug("Cleaned up terminal connector diagnostic registrations", {
          count: deleted.length,
        });
      }
      return deleted.length;
    })(signal);
    signal.throwIfAborted();
    await set(cleanupGlobalMaintenance$, signal);
    signal.throwIfAborted();

    L.debug("Run timeout candidates", { count: expiredRuns.length });

    const results = await set(
      cleanupExpiredRuns$,
      expiredRuns,
      cutoffs,
      signal,
    );
    signal.throwIfAborted();

    const { exportJobsCleaned, exportJobsStuck } = await set(
      cleanupExpiredExportJobs$,
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
