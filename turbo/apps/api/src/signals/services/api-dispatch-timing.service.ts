import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { performance } from "node:perf_hooks";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import type { PgQueryExecution } from "../../lib/db-instrumentation";
import { env } from "../../lib/env";
import { singleton } from "../../lib/singleton";
import { now } from "../../lib/time";
import {
  recordApiOperationTimings,
  recordSandboxOperations,
} from "../external/sandbox-op-log";
import { safeSync } from "../utils";

type ApiDispatchTimingSpanKind = "top_level" | "nested";
export type ApiDispatchTimingDimensions = Readonly<Record<string, string>>;
// Bounded string dimensions and numeric observation metrics share the ingest fields.
type ApiDispatchTimingFields = Readonly<Record<string, string | number>>;
export type ApiDispatchTimingDimensionsInput =
  ApiDispatchTimingFields | (() => ApiDispatchTimingFields | undefined);

type ApiProcessAgeBucket =
  "0_1s" | "1_10s" | "10_60s" | "1_5m" | "5_15m" | "15m_plus";
type ApiProcessDispatchOrdinalBucket =
  "first" | "2_4" | "5_16" | "17_64" | "65_plus";

interface ApiProcessDispatchState {
  ordinal: number;
}

const apiProcessDispatchState = singleton((): ApiProcessDispatchState => {
  return { ordinal: 0 };
});

function apiProcessAgeBucket(processAgeMs: number): ApiProcessAgeBucket {
  if (processAgeMs < 1000) {
    return "0_1s";
  }
  if (processAgeMs < 10_000) {
    return "1_10s";
  }
  if (processAgeMs < 60_000) {
    return "10_60s";
  }
  if (processAgeMs < 300_000) {
    return "1_5m";
  }
  if (processAgeMs < 900_000) {
    return "5_15m";
  }
  return "15m_plus";
}

function claimApiProcessDispatchOrdinal(): ApiProcessDispatchOrdinalBucket {
  const state = apiProcessDispatchState();
  state.ordinal = Math.min(state.ordinal + 1, 65);
  if (state.ordinal === 1) {
    return "first";
  }
  if (state.ordinal <= 4) {
    return "2_4";
  }
  if (state.ordinal <= 16) {
    return "5_16";
  }
  if (state.ordinal <= 64) {
    return "17_64";
  }
  return "65_plus";
}

export type ApiDispatchTimingActionType =
  | "api_dispatch_discord_prompt_binding"
  | "api_dispatch_discord_prompt_provider"
  | "api_dispatch_discord_prompt_capability"
  | "api_dispatch_pre_create_agent_load_agent"
  | "api_dispatch_pre_create_agent_capture_subscription_account"
  | "api_dispatch_pre_create_agent_workflow_slash_prepare_normal_send"
  | "api_dispatch_pre_create_agent_workflow_slash_load_thread_mapping"
  | "api_dispatch_pre_create_agent_workflow_slash_ensure_thread"
  | "api_dispatch_pre_create_agent_teams_entrypoint_gap"
  | "api_dispatch_pre_create_agent_teams_create_run"
  | "api_dispatch_pre_create_agent_workflow_automation_entrypoint_gap"
  | "api_dispatch_pre_create_agent_workflow_automation_queue_admission"
  | "api_dispatch_workflow_enqueue_display_name"
  | "api_dispatch_workflow_enqueue_transaction"
  | "api_dispatch_workflow_enqueue_transaction_callback"
  | "api_dispatch_workflow_event_created_to_consume_start"
  | "api_dispatch_enqueue_commit_to_consume_start"
  | "api_dispatch_request_received_to_enqueue_commit"
  | "api_dispatch_pre_create_agent_workflow_automation_resolve_model_context"
  | "api_dispatch_pre_create_agent_automation_event_background_start_gap"
  | "api_dispatch_pre_create_agent_automation_event_load_source_state"
  | "api_dispatch_pre_create_agent_automation_event_load_external_events"
  | "api_dispatch_pre_create_agent_automation_event_load_automations"
  | "api_dispatch_pre_create_agent_automation_event_match_automations"
  | "api_dispatch_pre_create_agent_automation_event_record_processed_event"
  | "api_dispatch_pre_create_agent_automation_event_build_run_input"
  | "api_dispatch_pre_create_agent_automation_event_handoff_run"
  | "api_dispatch_prepare_context_resolve_model_provider"
  | "api_dispatch_prepare_context_load_connector_contexts"
  | "api_dispatch_prepare_context_materialize_stored_connector_snapshot"
  | "api_dispatch_prepare_context_load_custom_connector_rows"
  | "api_dispatch_prepare_context_load_custom_connector_value_rows"
  | "api_dispatch_prepare_context_project_custom_connector_value_rows"
  | "api_dispatch_prepare_context_connector_context_environment_query"
  | "api_dispatch_prepare_context_connector_context_pool_acquire"
  | "api_dispatch_prepare_context_connector_context_environment_materialize"
  | "api_dispatch_prepare_context_connector_context_sources_materialize"
  | "api_dispatch_prepare_context_build_custom_connector_firewalls"
  | "api_dispatch_prepare_context_build_permission_manifest"
  | "api_dispatch_prepare_context_select_builtin_targets"
  | "api_dispatch_prepare_context_builtin_metadata_lookup"
  | "api_dispatch_prepare_context_builtin_base_url_validation"
  | "api_dispatch_prepare_context_builtin_target_assembly"
  | "api_dispatch_prepare_context_apply_custom_permission_policies"
  | "api_dispatch_prepare_context_merge_permission_manifest"
  | "api_dispatch_insert_run_with_concurrency"
  | "api_dispatch_prepare_atomic_launch_persistence"
  | "api_dispatch_persist_atomic_launch"
  | "api_dispatch_persist_atomic_launch_build"
  | "api_dispatch_persist_atomic_launch_sql_call"
  | "api_dispatch_persist_atomic_launch_application_remainder"
  | "api_dispatch_persist_atomic_launch_materialize"
  | "api_dispatch_prepare_execution_package_sources"
  | "api_dispatch_prepare_execution_package_wait"
  | "api_dispatch_connector_catalog_load_runtime_snapshot"
  | "api_dispatch_connector_catalog_validate_compatibility"
  | "api_dispatch_connector_catalog_materialize_accepted_snapshot"
  | "api_dispatch_connector_catalog_materialize_server_firewalls"
  | "api_dispatch_prepare_launch_pick_snapshot"
  | "api_dispatch_prepare_launch_initialize"
  | "api_dispatch_prepare_launch_resources"
  | "api_dispatch_prepare_launch_run_plan"
  | "api_dispatch_prepare_launch_runner_resources"
  | "api_dispatch_prepare_launch_runner_input"
  | "api_dispatch_prepare_launch_memory"
  | "api_dispatch_prepare_launch_memory_initialization"
  | "api_dispatch_prepare_launch_callbacks"
  | "api_dispatch_prepare_launch_assembly"
  | "api_dispatch_prepare_launch_resources_join"
  | "api_dispatch_prepare_launch_connector_sources"
  | "api_dispatch_prepare_launch_connector_thread_selection"
  | "api_dispatch_prepare_launch_preparation_join"
  | "api_dispatch_prepare_launch_queue_observation"
  | "api_dispatch_phase_prepare_launch"
  | "api_dispatch_phase_commit";

type ApiDispatchPhaseActionType =
  "api_dispatch_phase_prepare_launch" | "api_dispatch_phase_commit";

interface ApiDispatchPhaseRecord {
  readonly actionType: ApiDispatchPhaseActionType;
  readonly startedAt: number;
  readonly finishedAt: number;
}

export class ApiDispatchPhaseCollector {
  private readonly records: ApiDispatchPhaseRecord[] = [];
  private previousBoundaryAt: number;

  constructor(startedAt: number) {
    this.previousBoundaryAt = startedAt;
  }

  checkpoint(
    actionType: ApiDispatchPhaseActionType,
    finishedAt: number = now(),
  ): void {
    const boundedFinishedAt = Math.max(this.previousBoundaryAt, finishedAt);
    this.records.push({
      actionType,
      startedAt: this.previousBoundaryAt,
      finishedAt: boundedFinishedAt,
    });
    this.previousBoundaryAt = boundedFinishedAt;
  }

  appendTo(timing: ApiDispatchTimingCollector): void {
    for (const record of this.records.splice(0)) {
      timing.recordElapsed(
        record.actionType,
        "top_level",
        record.startedAt,
        record.finishedAt,
      );
    }
  }
}

export interface ApiDispatchTimingRecord {
  readonly actionType: ApiDispatchTimingActionType;
  readonly spanKind: ApiDispatchTimingSpanKind;
  readonly durationMs: number;
  readonly timestamp: string;
  readonly dimensions?: ApiDispatchTimingFields;
}

export class ApiDispatchTimingCollector {
  private readonly records: ApiDispatchTimingRecord[] = [];
  private readonly processAgeBucket = apiProcessAgeBucket(performance.now());
  private processDispatchOrdinalBucket:
    ApiProcessDispatchOrdinalBucket | undefined;

  /** Completed observations passed as plain data to the publication owner. */
  snapshot(): readonly ApiDispatchTimingRecord[] {
    return [...this.records];
  }

  recordDatabaseElapsed(
    parentActionType: ApiDispatchTimingActionType,
    sqlActionType: ApiDispatchTimingActionType,
    applicationActionType: ApiDispatchTimingActionType,
    startedAt: number,
    executions: readonly PgQueryExecution[],
  ): void {
    safeSync(() => {
      const durationMs = performance.now() - startedAt;
      const finishedAt = now();
      const dimensions = {
        db_query_capture:
          executions.length === 1
            ? "single"
            : executions.length === 0
              ? "missing"
              : "multiple",
      };
      this.recordDuration(
        parentActionType,
        "nested",
        durationMs,
        finishedAt,
        dimensions,
      );
      const [execution] = executions;
      if (executions.length === 1 && execution) {
        this.recordDuration(
          sqlActionType,
          "nested",
          execution.durationMs,
          execution.finishedAt,
          dimensions,
        );
        // Query construction, ORM/schema decoding and projection are outside
        // the client's SQL-call wall. Never infer them from missing capture.
        if (durationMs >= execution.durationMs) {
          this.recordDuration(
            applicationActionType,
            "nested",
            durationMs - execution.durationMs,
            finishedAt,
            dimensions,
          );
        }
      }
    });
  }

  recordDuration(
    actionType: ApiDispatchTimingActionType,
    spanKind: ApiDispatchTimingSpanKind,
    durationMs: number,
    finishedAt: number,
    dimensions?: ApiDispatchTimingDimensionsInput,
  ): void {
    this.records.push({
      actionType,
      spanKind,
      durationMs: Math.max(0, durationMs),
      timestamp: new Date(finishedAt).toISOString(),
      dimensions: resolveApiDispatchTimingDimensions(dimensions),
    });
  }

  recordElapsed(
    actionType: ApiDispatchTimingActionType,
    spanKind: ApiDispatchTimingSpanKind,
    startedAt: number,
    finishedAt: number = now(),
    dimensions?: ApiDispatchTimingDimensionsInput,
  ): void {
    this.recordDuration(
      actionType,
      spanKind,
      finishedAt - startedAt,
      finishedAt,
      dimensions,
    );
  }

  async measure<T>(
    actionType: ApiDispatchTimingActionType,
    spanKind: ApiDispatchTimingSpanKind,
    operation: () => T | Promise<T>,
    dimensions?: ApiDispatchTimingDimensionsInput,
  ): Promise<T> {
    const startedAt = performance.now();
    return await (async () => {
      return await operation();
    })().finally(() => {
      this.recordDuration(
        actionType,
        spanKind,
        performance.now() - startedAt,
        now(),
        dimensions,
      );
    });
  }

  measureSync<T>(
    actionType: ApiDispatchTimingActionType,
    spanKind: ApiDispatchTimingSpanKind,
    operation: () => T,
    dimensions?: ApiDispatchTimingDimensionsInput,
  ): T {
    const startedAt = performance.now();
    const result = safeSync(operation);
    this.recordDuration(
      actionType,
      spanKind,
      performance.now() - startedAt,
      now(),
      dimensions,
    );
    if ("error" in result) {
      throw result.error;
    }
    return result.ok;
  }

  /**
   * Emit the records of work that ends before any run exists, such as an
   * enqueue whose pick runs in the background.
   */
  flushWithoutRun(
    dimensions?: ApiDispatchTimingDimensions,
    success = true,
  ): void {
    const records = this.records.splice(0);
    const apiCommitSha = normalizeBuildCommitSha(env("GIT_COMMIT_SHA"));
    recordApiOperationTimings(
      records.map((record) => {
        return {
          actionType: record.actionType,
          durationMs: record.durationMs,
          success,
          timestamp: record.timestamp,
          dimensions: {
            ...dimensions,
            ...record.dimensions,
            span_kind: record.spanKind,
            ...(apiCommitSha ? { api_commit_sha: apiCommitSha } : {}),
          },
        };
      }),
    );
  }

  flush(args: {
    readonly runId: string;
    readonly runnerGroup: string;
    readonly profile: string;
    readonly triggerSource?: TriggerSource;
    readonly dimensions?: ApiDispatchTimingDimensions;
  }): void {
    const records = this.records.splice(0);
    // A scheduler can construct a collector for an empty drain. Only a
    // run-associated telemetry flush should advance the dispatch ordinal.
    if (records.length === 0) {
      recordSandboxOperations([]);
      return;
    }
    this.processDispatchOrdinalBucket ??= claimApiProcessDispatchOrdinal();
    const processDimensions = {
      api_process_age_bucket: this.processAgeBucket,
      api_process_dispatch_ordinal_bucket: this.processDispatchOrdinalBucket,
    } satisfies ApiDispatchTimingDimensions;
    const apiCommitSha = normalizeBuildCommitSha(env("GIT_COMMIT_SHA"));
    recordSandboxOperations(
      records.map((record) => {
        return {
          sandboxType: "runner",
          actionType: record.actionType,
          durationMs: record.durationMs,
          success: true,
          runId: args.runId,
          timestamp: record.timestamp,
          dimensions: {
            ...args.dimensions,
            ...record.dimensions,
            ...processDimensions,
            runner_group: args.runnerGroup,
            profile: args.profile,
            dispatch_path: "direct",
            span_kind: record.spanKind,
            ...(apiCommitSha ? { api_commit_sha: apiCommitSha } : {}),
            ...(args.triggerSource
              ? { trigger_source: args.triggerSource }
              : {}),
          },
        };
      }),
    );
  }
}

export async function measureApiDispatchTiming<T>(
  collector: ApiDispatchTimingCollector | undefined,
  actionType: ApiDispatchTimingActionType,
  spanKind: ApiDispatchTimingSpanKind,
  operation: () => T | Promise<T>,
  dimensions?: ApiDispatchTimingDimensionsInput,
): Promise<T> {
  if (!collector) {
    return await operation();
  }
  return await collector.measure(actionType, spanKind, operation, dimensions);
}

function resolveApiDispatchTimingDimensions(
  dimensions: ApiDispatchTimingDimensionsInput | undefined,
): ApiDispatchTimingFields | undefined {
  return typeof dimensions === "function" ? dimensions() : dimensions;
}
