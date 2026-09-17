import { command } from "ccstate";
import {
  webhookHeartbeatContract,
  webhookTelemetryContract,
  webhookUsageEventContract,
  type RunnerPreSpawnConcurrencyBucket,
  type RunnerResourceBudgetLeaseCountBucket,
  type RunnerResourceBudgetUtilizationBucket,
  type RunnerStartupPath,
  type SandboxReuseResult,
} from "@okouai/api-contracts/contracts/webhooks";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import type { z } from "zod";

import { badRequestMessage, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { getDatasetName, ingestAxiomDirect } from "../external/axiom";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import type { RouteEntry } from "../route-entry";
import { dispatchProgressCallbacks$ } from "../services/agent-run-callbacks.service";
import { settle } from "../utils";
import {
  getSandboxAuthForRun,
  resolveSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";
import { usageUnderbillingFields } from "../usage-underbilling";

const SANDBOX_TELEMETRY_SYSTEM_DATASET = "sandbox-telemetry-system";
const SANDBOX_TELEMETRY_METRICS_DATASET = "sandbox-telemetry-metrics";
const SANDBOX_TELEMETRY_NETWORK_DATASET = "sandbox-telemetry-network";
const MODEL_USAGE_KIND = "model";
const TELEMETRY_INGEST_TIMEOUT_MS = 10_000;

const L = logger("webhooks:agent");

interface SandboxOperationDimensionInput {
  readonly error?: string;
  readonly outcome?: string;
  readonly reason?: string;
  readonly dns_readiness_attempt?: number;
  readonly dns_readiness_final_attempt?: boolean;
  readonly dns_readiness_guest_duration_ms?: number;
  readonly dns_readiness_host_residual_ms?: number;
  readonly dns_readiness_timing?: string;
  readonly runner_startup_path?: RunnerStartupPath;
  readonly sandbox_reuse_result?: SandboxReuseResult;
  readonly runner_pre_spawn_concurrency_bucket?: RunnerPreSpawnConcurrencyBucket;
  readonly runner_resource_budget_vcpu_utilization_bucket?: RunnerResourceBudgetUtilizationBucket;
  readonly runner_resource_budget_memory_utilization_bucket?: RunnerResourceBudgetUtilizationBucket;
  readonly runner_resource_budget_lease_count_bucket?: RunnerResourceBudgetLeaseCountBucket;
  readonly encoding?: string;
  readonly session_history_raw_size_bucket?: string;
  readonly session_history_encoded_size_bucket?: string;
  readonly session_history_compression_ratio_bucket?: string;
  readonly session_history_ref_seen_recently?: string;
  readonly session_history_ref_download_inflight?: string;
  readonly session_history_content_length_state?: string;
  readonly session_history_content_encoding_state?: string;
  readonly session_history_transfer_encoding_state?: string;
  readonly session_history_download_source?: string;
  readonly session_history_framework?: string;
  readonly session_history_raw_bytes?: number;
  readonly session_history_source_bytes?: number;
  readonly session_history_guest_bytes?: number;
  readonly session_history_source_representation?: string;
  readonly session_history_restore_representation?: string;
  readonly session_history_restore_reason?: string;
  readonly session_history_transfer_source?: string;
  readonly session_history_wire_codec?: string;
  readonly session_history_codec_reason?: string;
  readonly session_history_transfer_bytes?: number;
  readonly session_history_wire_bytes?: number;
  readonly session_history_write_requests?: number;
  readonly session_history_selection_ms?: number;
  readonly session_history_file_gate_wait_ms?: number;
  readonly session_history_requests_ms?: number;
  readonly session_history_encoder_pipeline_ms?: number;
  readonly session_history_publication_ms?: number;
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
    ...dnsReadinessDimensions(op),
    ...(op.runner_startup_path
      ? { runner_startup_path: op.runner_startup_path }
      : {}),
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
    ...workspaceHistoryRestoreDimensions(op),
    ...historyTransferDimensions(op),
    ...(op.encoding ? { encoding: op.encoding } : {}),
    ...(op.session_history_raw_size_bucket
      ? {
          session_history_raw_size_bucket: op.session_history_raw_size_bucket,
        }
      : {}),
    ...(op.session_history_encoded_size_bucket
      ? {
          session_history_encoded_size_bucket:
            op.session_history_encoded_size_bucket,
        }
      : {}),
    ...(op.session_history_compression_ratio_bucket
      ? {
          session_history_compression_ratio_bucket:
            op.session_history_compression_ratio_bucket,
        }
      : {}),
    ...(op.session_history_ref_seen_recently
      ? {
          session_history_ref_seen_recently:
            op.session_history_ref_seen_recently,
        }
      : {}),
    ...(op.session_history_ref_download_inflight
      ? {
          session_history_ref_download_inflight:
            op.session_history_ref_download_inflight,
        }
      : {}),
    ...(op.session_history_content_length_state
      ? {
          session_history_content_length_state:
            op.session_history_content_length_state,
        }
      : {}),
    ...(op.session_history_content_encoding_state
      ? {
          session_history_content_encoding_state:
            op.session_history_content_encoding_state,
        }
      : {}),
    ...(op.session_history_transfer_encoding_state
      ? {
          session_history_transfer_encoding_state:
            op.session_history_transfer_encoding_state,
        }
      : {}),
    ...(op.session_history_download_source
      ? { session_history_download_source: op.session_history_download_source }
      : {}),
  };
}

function historyTransferDimensions(
  op: SandboxOperationDimensionInput,
): Record<string, string | number> {
  const dimensions: Record<string, string | number> = {};
  for (const key of [
    "session_history_transfer_source",
    "session_history_wire_codec",
    "session_history_codec_reason",
    "session_history_transfer_bytes",
    "session_history_wire_bytes",
    "session_history_write_requests",
    "session_history_selection_ms",
    "session_history_file_gate_wait_ms",
    "session_history_requests_ms",
    "session_history_encoder_pipeline_ms",
    "session_history_publication_ms",
  ] as const) {
    const value = op[key];
    if (value !== undefined) {
      dimensions[key] = value;
    }
  }
  return dimensions;
}

function workspaceHistoryRestoreDimensions(
  op: SandboxOperationDimensionInput,
): Record<string, string | number> {
  return {
    ...(op.session_history_framework
      ? { session_history_framework: op.session_history_framework }
      : {}),
    ...(op.session_history_raw_bytes !== undefined
      ? { session_history_raw_bytes: op.session_history_raw_bytes }
      : {}),
    ...(op.session_history_source_bytes !== undefined
      ? { session_history_source_bytes: op.session_history_source_bytes }
      : {}),
    ...(op.session_history_guest_bytes !== undefined
      ? { session_history_guest_bytes: op.session_history_guest_bytes }
      : {}),
    ...(op.session_history_source_representation
      ? {
          session_history_source_representation:
            op.session_history_source_representation,
        }
      : {}),
    ...(op.session_history_restore_representation
      ? {
          session_history_restore_representation:
            op.session_history_restore_representation,
        }
      : {}),
    ...(op.session_history_restore_reason
      ? { session_history_restore_reason: op.session_history_restore_reason }
      : {}),
  };
}

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
  const result = await db
    .update(agentRuns)
    .set({ lastHeartbeatAt: nowDate() })
    .where(
      and(
        eq(agentRuns.id, body.runId),
        eq(agentRuns.userId, auth.userId),
        inArray(agentRuns.status, ["pending", "running"]),
      ),
    )
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();

  if (result.length === 0) {
    return notFound("Agent run not found");
  }

  waitUntil(set(dispatchProgressCallbacks$, body.runId, signal));

  return {
    status: 200 as const,
    body: { ok: true },
  };
});

const usageEventBody$ = bodyResultOf(webhookUsageEventContract.send);
const usageEvent$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(usageEventBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }

  // Prepared reader only: #34713 must replace this guard with the complete
  // source-ledger/resource transaction and two-date lifecycle admission.
  // Never pass resource observations (including mixed batches) to count billing.
  if (
    body.events.some((event) => {
      return "protocol" in event;
    })
  ) {
    return badRequestMessage("X resource observations are not enabled");
  }

  const db = set(writeDb$);
  const hasModelEvents = body.events.some((event) => {
    return event.kind === MODEL_USAGE_KIND;
  });
  const [runModelContext] = hasModelEvents
    ? await db
        .select({
          modelProvider: agentRuns.modelProvider,
        })
        .from(agentRuns)
        .where(
          and(eq(agentRuns.id, body.runId), isNotNull(agentRuns.triggerSource)),
        )
        .limit(1)
    : [];
  signal.throwIfAborted();

  const modelProviderType = runModelContext?.modelProvider ?? null;
  const usageEventValues = body.events
    .filter((event) => {
      return (
        event.kind !== MODEL_USAGE_KIND ||
        modelProviderType === null ||
        isBuiltInModelProviderType(modelProviderType)
      );
    })
    .map((event) => {
      return {
        runId: body.runId,
        orgId: auth.orgId,
        userId: auth.userId,
        kind: event.kind,
        provider: event.provider,
        category: event.category,
        quantity: event.quantity,
        idempotencyKey: event.idempotencyKey,
      };
    });
  const insertResult = await settle(
    (async () => {
      if (usageEventValues.length > 0) {
        await db
          .insert(usageEvent)
          .values(usageEventValues)
          .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
      }
    })(),
  );
  signal.throwIfAborted();
  if (!insertResult.ok) {
    if (isForeignKeyViolation(insertResult.error)) {
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
    disk_used: metric.disk_used,
    disk_total: metric.disk_total,
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

const telemetryBody$ = bodyResultOf(webhookTelemetryContract.send);
const telemetry$ = command(async ({ get }, signal: AbortSignal) => {
  const bodyResult = await get(telemetryBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const authResult = resolveSandboxAuthForRun(body.runId, get(authorization$));
  if (!authResult.ok) {
    L.warn("Agent telemetry rejected sandbox auth", {
      authFailureReason: authResult.reason,
    });
    return unauthorizedRunMismatch;
  }
  const { auth } = authResult;

  const db = get(db$);
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, auth.userId)))
    .limit(1);
  signal.throwIfAborted();

  if (!run) {
    return notFound("Agent run not found");
  }

  const telemetryBatches: {
    readonly dataset: string;
    readonly events: readonly Record<string, unknown>[];
    readonly includesOomEvidence?: boolean;
  }[] = [];

  if (body.systemLog) {
    telemetryBatches.push({
      dataset: getDatasetName(SANDBOX_TELEMETRY_SYSTEM_DATASET),
      events: [
        {
          _time: nowDate().toISOString(),
          runId: body.runId,
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
        return telemetryMetricEvent(metric, body.runId, auth.userId);
      }),
    });
  }

  if (body.oomEvidence) {
    telemetryBatches.push({
      includesOomEvidence: true,
      dataset: getDatasetName(SANDBOX_TELEMETRY_METRICS_DATASET),
      events: telemetryOomEvents(
        body.oomEvidence,
        body.runId,
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
          runId: body.runId,
          userId: auth.userId,
        };
      }),
    });
  }

  let oomEvidenceIngested = false;
  if (telemetryBatches.length > 0) {
    const ingestionResults = await Promise.all(
      telemetryBatches.map(async (batch) => {
        const result = await ingestAxiomDirect(
          batch.dataset,
          batch.events,
          TELEMETRY_INGEST_TIMEOUT_MS,
          signal,
        );
        return batch.includesOomEvidence === true && result.configured;
      }),
    );
    signal.throwIfAborted();
    oomEvidenceIngested = ingestionResults.some((ingested) => {
      return ingested;
    });
  }

  if (body.sandboxOperations && body.sandboxOperations.length > 0) {
    for (const op of body.sandboxOperations) {
      recordSandboxOperation({
        actionType: op.action_type,
        sandboxType: "runner",
        durationMs: op.duration_ms,
        success: op.success,
        runId: body.runId,
        timestamp: op.ts,
        dimensions: sandboxOperationDimensions(op, {
          runnerHostname: body.runnerHostname,
          runnerVersion: body.runnerVersion,
        }),
      });
    }
  }

  return {
    status: 200 as const,
    body: {
      success: true,
      id: body.runId,
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
