import { command } from "ccstate";
import type { HomeReuseResult } from "@okouai/api-contracts/contracts/runner-primitives";
import {
  webhookHeartbeatContract,
  webhookTelemetryContract,
  webhookUsageEventContract,
  type ArchiveConnectionAttempt,
  type ArchiveSizeMismatch,
  type RunnerPreSpawnConcurrencyBucket,
  type RunnerResourceBudgetLeaseCountBucket,
  type RunnerResourceBudgetUtilizationBucket,
  type RunnerStartupPath,
  type SandboxReuseResult,
} from "@okouai/api-contracts/contracts/webhooks";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { and, eq, inArray } from "drizzle-orm";
import * as z from "zod";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { authorization$, request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import {
  DirectAxiomIngestError,
  getDatasetName,
  ingestAxiomDirect,
} from "../external/axiom";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { runnerAuth$ } from "../auth/runner-auth";
import type { RouteEntry } from "../route-entry";
import { dispatchProgressCallbacks$ } from "../services/agent-run-callbacks.service";
import { hasAgentPhoneTypingTargetForRun$ } from "../services/agent-event-consumer-agentphone-typing.service";
import { DISCORD_TYPING_REFRESH_INTERVAL_SECONDS } from "../services/discord-run-typing.service";
import {
  WECHAT_TYPING_REFRESH_INTERVAL_SECONDS,
  hasWechatTypingTargetForRun$,
} from "../services/wechat-thread-typing.service";
import { settle } from "../utils";
import {
  recordRunnerUsageBatch$,
  RunnerUsageRunMissingError,
} from "../services/provider-usage-publication.service";
import {
  getSandboxAuthForRun,
  resolveSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";
import { usageUnderbillingFields } from "../usage-underbilling";
import { readUsageEventBody } from "./webhooks-usage-body";
import { ingestXResourceUsage$ } from "../services/x-resource-usage.service";
import { XResourceUsageError } from "../services/x-resource-usage-values";

import { discordDeliveryTargetSchema } from "../services/discord-chat-callback-payload";
import { internalRunCallbackKindForRecord } from "../services/internal-run-callback";

const SANDBOX_TELEMETRY_SYSTEM_DATASET = "sandbox-telemetry-system";
const SANDBOX_TELEMETRY_METRICS_DATASET = "sandbox-telemetry-metrics";
const SANDBOX_TELEMETRY_NETWORK_DATASET = "sandbox-telemetry-network";
const AGENTPHONE_TYPING_REFRESH_INTERVAL_SECONDS = 4;

const L = logger("webhooks:agent");
const discordTypingPayloadSchema = z.object({
  discordDelivery: discordDeliveryTargetSchema,
});
const DISCORD_TYPING_ACTIVE_RUN_STATUSES = ["pending", "running"] as const;

interface SandboxOperationDimensionInput {
  readonly error?: string;
  readonly outcome?: string;
  readonly reason?: string;
  readonly archive_size_mismatch?: ArchiveSizeMismatch;
  readonly archive_connection_attempt?: ArchiveConnectionAttempt;
  readonly dns_readiness_attempt?: number;
  readonly dns_readiness_final_attempt?: boolean;
  readonly dns_readiness_guest_duration_ms?: number;
  readonly dns_readiness_host_residual_ms?: number;
  readonly dns_readiness_timing?: string;
  readonly storage_batch_guest_duration_ms?: number;
  readonly storage_batch_outer_residual_ms?: number;
  readonly storage_batch_admission_ms?: number;
  readonly storage_batch_request_setup_ms?: number;
  readonly storage_batch_frame_builder_wait_ms?: number;
  readonly storage_batch_frame_encode_ms?: number;
  readonly storage_batch_writer_wait_ms?: number;
  readonly storage_batch_frame_write_ms?: number;
  readonly storage_batch_response_wait_ms?: number;
  readonly storage_batch_result_decode_ms?: number;
  readonly storage_batch_resource_log_ms?: number;
  readonly storage_batch_host_timing?: string;
  readonly storage_batch_guest_timing?: string;
  readonly storage_batch_resources?: string;
  readonly storage_batch_guest_request_ownership_us?: number;
  readonly storage_batch_guest_worker_wait_us?: number;
  readonly storage_batch_guest_response_prepare_us?: number;
  readonly storage_batch_containment_wall_us?: number;
  readonly storage_batch_resource_collection_us?: number;
  readonly storage_batch_cpu_usage_us?: number;
  readonly storage_batch_cpu_throttled_us?: number;
  readonly storage_batch_memory_peak_bytes?: number;
  readonly storage_batch_memory_events_oom?: number;
  readonly storage_batch_memory_events_oom_kill?: number;
  readonly storage_batch_memory_events_oom_group_kill?: number;
  readonly storage_batch_pids_events_max?: number;
  readonly storage_batch_payload_size_bucket?: string;
  readonly storage_batch_timing?: string;
  readonly runner_startup_path?: RunnerStartupPath;
  readonly is_first_run?: boolean;
  readonly reuse_key?: string;
  readonly run_id?: string;
  readonly cache_key?: string;
  readonly profile_name?: string;
  readonly image_generation?: string;
  readonly allocated_bytes?: number;
  readonly handoff_path?: string;
  readonly runner_id?: string;
  readonly runner_heartbeat_generation?: number;
  readonly inventory_loaded?: boolean;
  readonly inventory_observed_states?: number;
  readonly inventory_output_states?: number;
  readonly inventory_omitted_states?: number;
  readonly home_reuse_result?: HomeReuseResult;
  readonly sandbox_reuse_result?: SandboxReuseResult;
  readonly runner_pre_spawn_concurrency_bucket?: RunnerPreSpawnConcurrencyBucket;
  readonly runner_resource_budget_vcpu_utilization_bucket?: RunnerResourceBudgetUtilizationBucket;
  readonly runner_resource_budget_memory_utilization_bucket?: RunnerResourceBudgetUtilizationBucket;
  readonly runner_resource_budget_lease_count_bucket?: RunnerResourceBudgetLeaseCountBucket;
}

interface SandboxRunnerDimensionInput {
  readonly runnerHostname?: string;
  readonly runnerVersion?: string;
}

function runnerResourceBudgetDimensions(
  op: SandboxOperationDimensionInput,
): Record<string, string> {
  return {
    ...(op.runner_resource_budget_vcpu_utilization_bucket
      ? {
          runner_resource_budget_vcpu_utilization_bucket:
            op.runner_resource_budget_vcpu_utilization_bucket,
        }
      : {}),
    ...(op.runner_resource_budget_memory_utilization_bucket
      ? {
          runner_resource_budget_memory_utilization_bucket:
            op.runner_resource_budget_memory_utilization_bucket,
        }
      : {}),
    ...(op.runner_resource_budget_lease_count_bucket
      ? {
          runner_resource_budget_lease_count_bucket:
            op.runner_resource_budget_lease_count_bucket,
        }
      : {}),
  };
}

function dnsReadinessDimensions(
  op: SandboxOperationDimensionInput,
): Record<string, string | number | boolean> {
  return {
    ...(op.dns_readiness_attempt !== undefined
      ? { dns_readiness_attempt: op.dns_readiness_attempt }
      : {}),
    ...(op.dns_readiness_final_attempt !== undefined
      ? { dns_readiness_final_attempt: op.dns_readiness_final_attempt }
      : {}),
    ...(op.dns_readiness_guest_duration_ms !== undefined
      ? { dns_readiness_guest_duration_ms: op.dns_readiness_guest_duration_ms }
      : {}),
    ...(op.dns_readiness_host_residual_ms !== undefined
      ? { dns_readiness_host_residual_ms: op.dns_readiness_host_residual_ms }
      : {}),
    ...(op.dns_readiness_timing
      ? { dns_readiness_timing: op.dns_readiness_timing }
      : {}),
  };
}

function storageBatchGuestEvidenceDimensions(
  op: SandboxOperationDimensionInput,
): Record<string, string | number> {
  return {
    ...(op.storage_batch_guest_timing !== undefined
      ? { storage_batch_guest_timing: op.storage_batch_guest_timing }
      : {}),
    ...(op.storage_batch_resources !== undefined
      ? { storage_batch_resources: op.storage_batch_resources }
      : {}),
    ...(op.storage_batch_guest_request_ownership_us !== undefined
      ? {
          storage_batch_guest_request_ownership_us:
            op.storage_batch_guest_request_ownership_us,
        }
      : {}),
    ...(op.storage_batch_guest_worker_wait_us !== undefined
      ? {
          storage_batch_guest_worker_wait_us:
            op.storage_batch_guest_worker_wait_us,
        }
      : {}),
    ...(op.storage_batch_guest_response_prepare_us !== undefined
      ? {
          storage_batch_guest_response_prepare_us:
            op.storage_batch_guest_response_prepare_us,
        }
      : {}),
    ...(op.storage_batch_containment_wall_us !== undefined
      ? {
          storage_batch_containment_wall_us:
            op.storage_batch_containment_wall_us,
        }
      : {}),
    ...(op.storage_batch_resource_collection_us !== undefined
      ? {
          storage_batch_resource_collection_us:
            op.storage_batch_resource_collection_us,
        }
      : {}),
    ...(op.storage_batch_cpu_usage_us !== undefined
      ? { storage_batch_cpu_usage_us: op.storage_batch_cpu_usage_us }
      : {}),
    ...(op.storage_batch_cpu_throttled_us !== undefined
      ? { storage_batch_cpu_throttled_us: op.storage_batch_cpu_throttled_us }
      : {}),
    ...(op.storage_batch_memory_peak_bytes !== undefined
      ? { storage_batch_memory_peak_bytes: op.storage_batch_memory_peak_bytes }
      : {}),
    ...(op.storage_batch_memory_events_oom !== undefined
      ? { storage_batch_memory_events_oom: op.storage_batch_memory_events_oom }
      : {}),
    ...(op.storage_batch_memory_events_oom_kill !== undefined
      ? {
          storage_batch_memory_events_oom_kill:
            op.storage_batch_memory_events_oom_kill,
        }
      : {}),
    ...(op.storage_batch_memory_events_oom_group_kill !== undefined
      ? {
          storage_batch_memory_events_oom_group_kill:
            op.storage_batch_memory_events_oom_group_kill,
        }
      : {}),
    ...(op.storage_batch_pids_events_max !== undefined
      ? { storage_batch_pids_events_max: op.storage_batch_pids_events_max }
      : {}),
  };
}

function storageBatchDimensions(
  op: SandboxOperationDimensionInput,
): Record<string, string | number> {
  return {
    ...storageBatchGuestEvidenceDimensions(op),
    ...(op.storage_batch_admission_ms !== undefined
      ? { storage_batch_admission_ms: op.storage_batch_admission_ms }
      : {}),
    ...(op.storage_batch_request_setup_ms !== undefined
      ? { storage_batch_request_setup_ms: op.storage_batch_request_setup_ms }
      : {}),
    ...(op.storage_batch_frame_builder_wait_ms !== undefined
      ? {
          storage_batch_frame_builder_wait_ms:
            op.storage_batch_frame_builder_wait_ms,
        }
      : {}),
    ...(op.storage_batch_frame_encode_ms !== undefined
      ? { storage_batch_frame_encode_ms: op.storage_batch_frame_encode_ms }
      : {}),
    ...(op.storage_batch_writer_wait_ms !== undefined
      ? { storage_batch_writer_wait_ms: op.storage_batch_writer_wait_ms }
      : {}),
    ...(op.storage_batch_frame_write_ms !== undefined
      ? { storage_batch_frame_write_ms: op.storage_batch_frame_write_ms }
      : {}),
    ...(op.storage_batch_response_wait_ms !== undefined
      ? { storage_batch_response_wait_ms: op.storage_batch_response_wait_ms }
      : {}),
    ...(op.storage_batch_result_decode_ms !== undefined
      ? { storage_batch_result_decode_ms: op.storage_batch_result_decode_ms }
      : {}),
    ...(op.storage_batch_resource_log_ms !== undefined
      ? { storage_batch_resource_log_ms: op.storage_batch_resource_log_ms }
      : {}),
    ...(op.storage_batch_host_timing !== undefined
      ? { storage_batch_host_timing: op.storage_batch_host_timing }
      : {}),
    ...(op.storage_batch_payload_size_bucket !== undefined
      ? {
          storage_batch_payload_size_bucket:
            op.storage_batch_payload_size_bucket,
        }
      : {}),
    ...(op.storage_batch_guest_duration_ms !== undefined
      ? { storage_batch_guest_duration_ms: op.storage_batch_guest_duration_ms }
      : {}),
    ...(op.storage_batch_outer_residual_ms !== undefined
      ? { storage_batch_outer_residual_ms: op.storage_batch_outer_residual_ms }
      : {}),
    ...(op.storage_batch_timing
      ? { storage_batch_timing: op.storage_batch_timing }
      : {}),
  };
}

function archiveConnectionAttemptDimensions(
  op: SandboxOperationDimensionInput,
): Record<string, number | boolean> {
  const attempt = op.archive_connection_attempt;
  if (!attempt) {
    return {};
  }
  return {
    archive_connection_attempt_started: attempt.started,
    archive_connection_attempt_succeeded: attempt.succeeded,
    archive_connection_attempt_failed: attempt.failed,
    archive_connection_attempt_dropped: attempt.dropped,
    archive_connection_attempt_active_at_headers: attempt.active_at_headers,
    archive_connection_attempt_terminal_duration_ms:
      attempt.terminal_duration_ms,
    archive_connection_attempt_saturated: attempt.saturated,
  };
}

function homeObservationDimensions(
  op: SandboxOperationDimensionInput,
): Record<string, string | number | boolean> {
  return {
    ...(op.cache_key === undefined ? {} : { cache_key: op.cache_key }),
    ...(op.profile_name === undefined ? {} : { profile_name: op.profile_name }),
    ...(op.image_generation === undefined
      ? {}
      : { image_generation: op.image_generation }),
    ...(op.allocated_bytes === undefined
      ? {}
      : { allocated_bytes: op.allocated_bytes }),
    ...(op.handoff_path === undefined ? {} : { handoff_path: op.handoff_path }),
    ...(op.runner_id === undefined ? {} : { runner_id: op.runner_id }),
    ...(op.runner_heartbeat_generation === undefined
      ? {}
      : {
          runner_heartbeat_generation: String(op.runner_heartbeat_generation),
        }),
    ...(op.inventory_loaded === undefined
      ? {}
      : { inventory_loaded: op.inventory_loaded }),
    ...(op.inventory_observed_states === undefined
      ? {}
      : { inventory_observed_states: op.inventory_observed_states }),
    ...(op.inventory_output_states === undefined
      ? {}
      : { inventory_output_states: op.inventory_output_states }),
    ...(op.inventory_omitted_states === undefined
      ? {}
      : { inventory_omitted_states: op.inventory_omitted_states }),
  };
}

function sandboxOperationDimensions(
  op: SandboxOperationDimensionInput,
  runner: SandboxRunnerDimensionInput,
): Record<string, string | number | boolean> {
  return {
    source: "sandbox",
    ...(runner.runnerHostname
      ? { runner_hostname: runner.runnerHostname }
      : {}),
    ...(runner.runnerVersion ? { runner_version: runner.runnerVersion } : {}),
    ...(op.error ? { error: op.error } : {}),
    ...(op.outcome ? { outcome: op.outcome } : {}),
    ...(op.reason ? { reason: op.reason } : {}),
    ...homeObservationDimensions(op),
    ...(op.archive_size_mismatch
      ? {
          archive_size_mismatch_expected_bytes:
            op.archive_size_mismatch.expected_bytes,
          archive_size_mismatch_response_bytes:
            op.archive_size_mismatch.response_bytes,
          archive_size_mismatch_source_kind:
            op.archive_size_mismatch.source_kind,
          archive_size_mismatch_source_index:
            op.archive_size_mismatch.source_index,
          archive_size_mismatch_content_encoding:
            op.archive_size_mismatch.content_encoding,
        }
      : {}),
    ...archiveConnectionAttemptDimensions(op),
    ...dnsReadinessDimensions(op),
    ...storageBatchDimensions(op),
    ...sandboxStartupContextDimensions(op),
    ...(op.sandbox_reuse_result
      ? { sandbox_reuse_result: op.sandbox_reuse_result }
      : {}),
    ...(op.runner_pre_spawn_concurrency_bucket
      ? {
          runner_pre_spawn_concurrency_bucket:
            op.runner_pre_spawn_concurrency_bucket,
        }
      : {}),
    ...runnerResourceBudgetDimensions(op),
  };
}

function sandboxStartupContextDimensions(
  op: SandboxOperationDimensionInput,
): Record<string, string | boolean> {
  return {
    ...(op.runner_startup_path
      ? { runner_startup_path: op.runner_startup_path }
      : {}),
    ...(op.is_first_run !== undefined ? { is_first_run: op.is_first_run } : {}),
    ...(op.reuse_key !== undefined ? { reuse_key: op.reuse_key } : {}),
    ...(op.home_reuse_result
      ? { home_reuse_result: op.home_reuse_result }
      : {}),
  };
}

/**
 * Typing indicators are best-effort side effects of heartbeat progress. The
 * Runner uses this hint for an extra refresh cadence that never counts as a
 * control-path heartbeat failure.
 */
const typingRefreshIntervalSecondsForRun$ = command(
  async (
    { get, set },
    args: { readonly runId: string; readonly triggerSource: string | null },
    signal: AbortSignal,
  ): Promise<number | undefined> => {
    if (args.triggerSource === "wechat") {
      return (await set(hasWechatTypingTargetForRun$, args.runId, signal))
        ? WECHAT_TYPING_REFRESH_INTERVAL_SECONDS
        : undefined;
    }
    if (args.triggerSource === "agentphone") {
      return (await set(hasAgentPhoneTypingTargetForRun$, args.runId, signal))
        ? AGENTPHONE_TYPING_REFRESH_INTERVAL_SECONDS
        : undefined;
    }
    if (args.triggerSource === "discord") {
      const db = get(db$);
      const runId = args.runId;
      const refresh = await (async () => {
        const callbacks = await db
          .select({
            url: agentRunCallbacks.url,
            internalKind: agentRunCallbacks.internalKind,
            payload: agentRunCallbacks.payload,
          })
          .from(agentRunCallbacks)
          .innerJoin(agentRuns, eq(agentRunCallbacks.runId, agentRuns.id))
          .where(
            and(
              eq(agentRunCallbacks.runId, runId),
              eq(agentRunCallbacks.status, "pending"),
              eq(agentRuns.triggerSource, "discord"),
              inArray(agentRuns.status, DISCORD_TYPING_ACTIVE_RUN_STATUSES),
            ),
          );
        return callbacks.some((callback) => {
          return (
            internalRunCallbackKindForRecord(callback) === "chat" &&
            discordTypingPayloadSchema.safeParse(callback.payload).success
          );
        });
      })();
      signal.throwIfAborted();
      return refresh ? DISCORD_TYPING_REFRESH_INTERVAL_SECONDS : undefined;
    }
    return undefined;
  },
);

const heartbeatBody$ = bodyResultOf(webhookHeartbeatContract.send);
const heartbeat$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(heartbeatBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }

  const db = set(writeDb$);
  const heartbeatAt = nowDate();
  // The active row outlives the public status: a run cancelled while running
  // keeps it until the runner reports completion, and its sandbox keeps
  // heartbeating meanwhile. Row existence is the only gate.
  await db
    .update(activeAgentRuns)
    .set({ lastHeartbeatAt: heartbeatAt })
    .where(
      and(
        eq(activeAgentRuns.runId, body.runId),
        eq(activeAgentRuns.userId, auth.userId),
      ),
    );
  signal.throwIfAborted();
  const result = await db
    .select({ triggerSource: agentRuns.triggerSource })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, body.runId),
        eq(agentRuns.userId, auth.userId),
        inArray(agentRuns.status, ["pending", "running"]),
      ),
    );
  signal.throwIfAborted();

  if (result.length === 0) {
    return notFound("Agent run not found");
  }

  const typingRefreshIntervalSeconds = await settle(
    set(
      typingRefreshIntervalSecondsForRun$,
      {
        runId: body.runId,
        triggerSource: result[0]?.triggerSource ?? null,
      },
      signal,
    ),
  );
  signal.throwIfAborted();

  waitUntil(set(dispatchProgressCallbacks$, body.runId, signal));

  return {
    status: 200 as const,
    body: {
      ok: true,
      ...(typingRefreshIntervalSeconds.ok &&
      typingRefreshIntervalSeconds.value !== undefined
        ? { typingRefreshIntervalSeconds: typingRefreshIntervalSeconds.value }
        : {}),
    },
  };
});

const usageEvent$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await readUsageEventBody(get(request$).raw, signal);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }

  if (
    body.events.some((event) => {
      return "protocol" in event;
    })
  ) {
    const result = await settle(set(ingestXResourceUsage$, body, auth, signal));
    signal.throwIfAborted();
    if (!result.ok) {
      if (result.error instanceof XResourceUsageError) {
        switch (result.error.status) {
          case 400: {
            return badRequestMessage(result.error.message);
          }
          case 404: {
            return notFound(result.error.message);
          }
          case 409: {
            return conflict(result.error.message);
          }
        }
      }
      throw result.error;
    }
    return { status: 200 as const, body: { success: true } };
  }

  const insertResult = await settle(
    set(
      recordRunnerUsageBatch$,
      { ...auth, runId: body.runId, events: body.events },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!insertResult.ok) {
    if (
      insertResult.error instanceof RunnerUsageRunMissingError ||
      isForeignKeyViolation(insertResult.error)
    ) {
      L.error("Run not found for usage event, dropping", {
        ...usageUnderbillingFields("run_not_found", "confirmed"),
        runId: body.runId,
        orgId: auth.orgId,
        eventCount: body.events.length,
      });
      return notFound("Run not found");
    }
    throw insertResult.error;
  }

  return {
    status: 200 as const,
    body: { success: true },
  };
});

type TelemetryBody = z.infer<(typeof webhookTelemetryContract.send)["body"]>;
type TelemetryMetric = NonNullable<TelemetryBody["metrics"]>[number];

interface TelemetryBatch {
  readonly dataset: string;
  readonly events: readonly Record<string, unknown>[];
  readonly includesOomEvidence?: boolean;
}

async function ingestTelemetryBatch(
  batch: TelemetryBatch,
  signal: AbortSignal,
): Promise<{
  readonly retryableFailure: boolean;
  readonly oomEvidenceIngested: boolean;
}> {
  const result = await settle(
    ingestAxiomDirect(batch.dataset, batch.events, signal),
  );
  signal.throwIfAborted();
  if (!result.ok) {
    const { error } = result;
    if (
      error instanceof DirectAxiomIngestError &&
      error.reason === "transport_error"
    ) {
      return { retryableFailure: true, oomEvidenceIngested: false };
    }
    throw error;
  }
  return {
    retryableFailure: false,
    oomEvidenceIngested:
      batch.includesOomEvidence === true && result.value.configured,
  };
}

function telemetryMetricEvent(
  metric: TelemetryMetric,
  runId: string,
  userId: string,
): Record<string, unknown> {
  return {
    _time: metric.ts,
    runId,
    userId,
    cpu: metric.cpu,
    ...(metric.memory === undefined ? {} : { memory: metric.memory }),
    ...(metric.cpu_steal_percent === undefined
      ? {}
      : { cpu_steal_percent: metric.cpu_steal_percent }),
    ...(metric.scheduled_lag_ms === undefined
      ? {}
      : { scheduled_lag_ms: metric.scheduled_lag_ms }),
    mem_used: metric.mem_used,
    mem_total: metric.mem_total,
    ...(metric.rootfs === undefined
      ? {}
      : {
          rootfs_used_bytes: metric.rootfs.used_bytes,
          rootfs_total_bytes: metric.rootfs.total_bytes,
          rootfs_available_bytes: metric.rootfs.available_bytes,
          rootfs_used_inodes: metric.rootfs.used_inodes,
          rootfs_total_inodes: metric.rootfs.total_inodes,
          rootfs_available_inodes: metric.rootfs.available_inodes,
        }),
    ...(metric.home === undefined
      ? {}
      : {
          home_used_bytes: metric.home.used_bytes,
          home_total_bytes: metric.home.total_bytes,
          home_available_bytes: metric.home.available_bytes,
          home_used_inodes: metric.home.used_inodes,
          home_total_inodes: metric.home.total_inodes,
          home_available_inodes: metric.home.available_inodes,
        }),
    ...(metric.control_cpu_usage_usec === undefined
      ? {}
      : { control_cpu_usage_usec: metric.control_cpu_usage_usec }),
    ...(metric.control_cpu_nr_throttled === undefined
      ? {}
      : { control_cpu_nr_throttled: metric.control_cpu_nr_throttled }),
    ...(metric.control_cpu_throttled_usec === undefined
      ? {}
      : { control_cpu_throttled_usec: metric.control_cpu_throttled_usec }),
    ...(metric.workload_cpu_usage_usec === undefined
      ? {}
      : { workload_cpu_usage_usec: metric.workload_cpu_usage_usec }),
    ...(metric.workload_cpu_nr_throttled === undefined
      ? {}
      : { workload_cpu_nr_throttled: metric.workload_cpu_nr_throttled }),
    ...(metric.workload_cpu_throttled_usec === undefined
      ? {}
      : { workload_cpu_throttled_usec: metric.workload_cpu_throttled_usec }),
  };
}

function telemetryOomEvents(
  evidence: NonNullable<TelemetryBody["oomEvidence"]>,
  runId: string,
  userId: string,
  sandboxId: string | undefined,
): Record<string, unknown>[] {
  const identity = {
    runId: runId,
    userId: userId,
    sandboxId: sandboxId,
    operation_id: evidence.operation_id,
    guest_boot_id: evidence.guest_boot_id,
    started_boottime_us: evidence.started_boottime_us,
    kernel_cursor: evidence.kernel_cursor,
    ingested_at: nowDate().toISOString(),
    dropped_incidents: evidence.dropped_incidents,
  };
  return [
    {
      ...identity,
      type: "guest_memory_snapshot",
      _time: evidence.sampled_at,
      sampled_at: evidence.sampled_at,
      kernel_status: evidence.kernel_status,
      groups: evidence.groups,
    },
    ...evidence.incidents.map((incident) => {
      return {
        ...identity,
        type: "guest_oom_incident",
        _time: incident.captured_at,
        incident_id: incident.id,
        captured_at: incident.captured_at,
        reason: incident.reason,
        after_observation: incident.after_observation,
        before_cleanup: incident.before_cleanup,
        kernel_status: incident.kernel_status,
        kernel_events: incident.kernel_events,
        groups: incident.groups,
      };
    }),
  ];
}

function recordTelemetrySandboxOperations(
  body: TelemetryBody,
  attribution: {
    readonly runId?: string;
    readonly runnerAuthType?: "user" | "official-runner";
  },
): void {
  for (const op of body.sandboxOperations ?? []) {
    const dimensions = sandboxOperationDimensions(op, {
      runnerHostname: body.runnerHostname,
      runnerVersion: body.runnerVersion,
    });
    if (attribution.runnerAuthType !== undefined) {
      dimensions.runner_auth_type = attribution.runnerAuthType;
      dimensions.source = "runner";
    }
    recordSandboxOperation({
      actionType: op.action_type,
      sandboxType: "runner",
      durationMs: op.duration_ms,
      success: op.success,
      runId: attribution.runId ?? op.run_id,
      timestamp: op.ts,
      dimensions,
    });
  }
}

const runnerTelemetry$ = command(
  async ({ get, set }, body: TelemetryBody, signal: AbortSignal) => {
    if (
      body.systemLog !== undefined ||
      body.metrics !== undefined ||
      body.networkLogs !== undefined ||
      body.oomEvidence !== undefined ||
      body.sandboxId !== undefined ||
      !body.sandboxOperations?.length
    ) {
      return badRequestMessage(
        "Runless telemetry accepts sandbox operations only",
      );
    }
    const runnerAuth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!runnerAuth) {
      return unauthorizedRunMismatch;
    }
    if (runnerAuth.type === "user") {
      const runIds = [
        ...new Set(
          body.sandboxOperations.flatMap((op) => {
            return op.run_id === undefined ? [] : [op.run_id];
          }),
        ),
      ];
      if (runIds.length > 0) {
        const runs = await get(db$)
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              inArray(agentRuns.id, runIds),
              eq(agentRuns.userId, runnerAuth.userId),
            ),
          );
        signal.throwIfAborted();
        if (runs.length !== runIds.length) {
          return unauthorizedRunMismatch;
        }
      }
    }
    recordTelemetrySandboxOperations(body, { runnerAuthType: runnerAuth.type });
    return { status: 200 as const, body: { success: true } };
  },
);

const telemetryBody$ = bodyResultOf(webhookTelemetryContract.send);
const telemetry$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(telemetryBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const runId = body.runId;
  if (runId === undefined) {
    return set(runnerTelemetry$, body, signal);
  }
  const authResult = resolveSandboxAuthForRun(runId, get(authorization$));
  if (!authResult.ok) {
    L.warn("Agent telemetry rejected sandbox auth", {
      authFailureReason: authResult.reason,
    });
    return unauthorizedRunMismatch;
  }
  const { auth } = authResult;
  if (
    body.sandboxOperations?.some((op) => {
      return op.run_id !== undefined && op.run_id !== runId;
    })
  ) {
    return unauthorizedRunMismatch;
  }

  const db = get(db$);
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, auth.userId)))
    .limit(1);
  signal.throwIfAborted();

  if (!run) {
    return notFound("Agent run not found");
  }

  const telemetryBatches: TelemetryBatch[] = [];

  if (body.systemLog) {
    telemetryBatches.push({
      dataset: getDatasetName(SANDBOX_TELEMETRY_SYSTEM_DATASET),
      events: [
        {
          _time: nowDate().toISOString(),
          runId: runId,
          userId: auth.userId,
          log: body.systemLog,
        },
      ],
    });
  }

  if (body.metrics && body.metrics.length > 0) {
    telemetryBatches.push({
      dataset: getDatasetName(SANDBOX_TELEMETRY_METRICS_DATASET),
      events: body.metrics.map((metric) => {
        return telemetryMetricEvent(metric, runId, auth.userId);
      }),
    });
  }

  if (body.oomEvidence) {
    telemetryBatches.push({
      includesOomEvidence: true,
      dataset: getDatasetName(SANDBOX_TELEMETRY_METRICS_DATASET),
      events: telemetryOomEvents(
        body.oomEvidence,
        runId,
        auth.userId,
        body.sandboxId,
      ),
    });
  }

  if (body.networkLogs && body.networkLogs.length > 0) {
    telemetryBatches.push({
      dataset: getDatasetName(SANDBOX_TELEMETRY_NETWORK_DATASET),
      events: body.networkLogs.map(({ timestamp, ...rest }) => {
        return {
          ...rest,
          _time: timestamp,
          runId: runId,
          userId: auth.userId,
        };
      }),
    });
  }

  let oomEvidenceIngested = false;
  if (telemetryBatches.length > 0) {
    const ingestionResults = await Promise.all(
      telemetryBatches.map((batch) => {
        return ingestTelemetryBatch(batch, signal);
      }),
    );
    signal.throwIfAborted();
    if (
      ingestionResults.some((result) => {
        return result.retryableFailure;
      })
    ) {
      return createErrorResponse(
        "INTERNAL_SERVER_ERROR",
        "Internal server error",
      );
    }
    oomEvidenceIngested = ingestionResults.some((result) => {
      return result.oomEvidenceIngested;
    });
  }

  recordTelemetrySandboxOperations(body, { runId });

  return {
    status: 200 as const,
    body: {
      success: true,
      id: runId,
      ...(oomEvidenceIngested ? { oomEvidenceVersion: 1 as const } : {}),
    },
  };
});

export const webhooksAgentHealthUsageTelemetryRoutes: readonly RouteEntry[] = [
  {
    route: webhookHeartbeatContract.send,
    handler: heartbeat$,
  },
  {
    route: webhookUsageEventContract.send,
    handler: usageEvent$,
  },
  {
    route: webhookTelemetryContract.send,
    handler: telemetry$,
  },
];
