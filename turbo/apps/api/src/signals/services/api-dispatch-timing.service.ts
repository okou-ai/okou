import { performance } from "node:perf_hooks";

import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";

import { env } from "../../lib/env";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import { singleton } from "../../lib/singleton";
import { now } from "../../lib/time";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { safeSync } from "../utils";

type ApiDispatchTimingSpanKind = "top_level" | "nested";
export type ApiDispatchTimingDimensions = Readonly<Record<string, string>>;
export type ApiDispatchTimingDimensionsInput =
  | ApiDispatchTimingDimensions
  | (() => ApiDispatchTimingDimensions | undefined);

type ApiProcessAgeBucket =
  | "0_1s"
  | "1_10s"
  | "10_60s"
  | "1_5m"
  | "5_15m"
  | "15m_plus";
type ApiProcessDispatchOrdinalBucket =
  | "first"
  | "2_4"
  | "5_16"
  | "17_64"
  | "65_plus";

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
  | "api_dispatch_pre_create_agent_run"
  | "api_dispatch_pre_create_direct_parse_body"
  | "api_dispatch_pre_create_direct_prepare_args"
  | "api_dispatch_pre_create_agent_parse_body"
  | "api_dispatch_pre_create_agent_prepare_args"
  | "api_dispatch_pre_create_agent_entrypoint_gap"
  | "api_dispatch_pre_create_agent_resolve_agent_id"
  | "api_dispatch_pre_create_agent_load_agent"
  | "api_dispatch_pre_create_agent_load_bootstrap_snapshot_rows"
  | "api_dispatch_pre_create_agent_materialize_bootstrap_context"
  | "api_dispatch_pre_create_agent_resolve_firewall_metadata"
  | "api_dispatch_pre_create_agent_resolve_thread_session"
  | "api_dispatch_pre_create_agent_web_chat_resolve_session_prompt_context"
  | "api_dispatch_pre_create_agent_build_create_run_args"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_load_and_authorize_agent"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_validate_model_selection"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_feature_switches"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_agent_run_source"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_validate_codex_service_tier"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_initial_thread_model_pin"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_thread"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_existing_thread_load_snapshot"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_existing_thread_resolve_persisted_model"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_persist_explicit_model_selection"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_persist_explicit_codex_service_tier"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_computer_use_host_grant"
  | "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_attachment_metadata"
  | "api_dispatch_pre_create_agent_web_chat_resolve_client_message"
  | "api_dispatch_pre_create_agent_web_chat_validate_revocation"
  | "api_dispatch_pre_create_agent_web_chat_check_active_run"
  | "api_dispatch_pre_create_agent_web_chat_queue_first_enqueue"
  | "api_dispatch_pre_create_agent_web_chat_queue_first_enqueue_transaction"
  | "api_dispatch_pre_create_agent_web_chat_queue_first_enqueue_clear_draft"
  | "api_dispatch_pre_create_agent_web_chat_queue_first_enqueue_persist_event"
  | "api_dispatch_pre_create_agent_web_chat_queue_first_enqueue_register_input_assets"
  | "api_dispatch_pre_create_agent_web_chat_queue_first_enqueue_touch_thread_sort"
  | "api_dispatch_pre_create_agent_web_chat_queue_first_check_dispatchable"
  | "api_dispatch_pre_create_agent_web_chat_create_normal_run"
  | "api_dispatch_pre_create_agent_web_chat_resolve_model_pin"
  | "api_dispatch_pre_create_agent_web_chat_resolve_provider_admission"
  | "api_dispatch_pre_create_agent_web_chat_build_create_run_args"
  | "api_dispatch_pre_create_agent_workflow_slash_prepare_normal_send"
  | "api_dispatch_pre_create_agent_workflow_slash_load_thread_mapping"
  | "api_dispatch_pre_create_agent_workflow_slash_ensure_thread"
  | "api_dispatch_pre_create_agent_slack_entrypoint_gap"
  | "api_dispatch_pre_create_agent_slack_background_start_gap"
  | "api_dispatch_pre_create_agent_slack_resolve_message"
  | "api_dispatch_pre_create_agent_slack_set_thread_status"
  | "api_dispatch_pre_create_agent_slack_build_run_params"
  | "api_dispatch_pre_create_agent_slack_build_run_params_enrich_message"
  | "api_dispatch_pre_create_agent_slack_build_run_params_resolve_model_route"
  | "api_dispatch_pre_create_agent_slack_build_run_params_load_thread_binding"
  | "api_dispatch_pre_create_agent_slack_build_run_params_resolve_session"
  | "api_dispatch_pre_create_agent_slack_build_run_params_resolve_computer_use_host"
  | "api_dispatch_pre_create_agent_slack_build_run_params_fetch_conversation_context"
  | "api_dispatch_pre_create_agent_slack_build_run_params_fetch_conversation_context_replies"
  | "api_dispatch_pre_create_agent_slack_build_run_params_fetch_conversation_context_history"
  | "api_dispatch_pre_create_agent_slack_build_run_params_fetch_conversation_context_user_info"
  | "api_dispatch_pre_create_agent_slack_build_run_params_fetch_conversation_context_format"
  | "api_dispatch_pre_create_agent_slack_build_run_params_user_info_resolver"
  | "api_dispatch_pre_create_agent_slack_build_run_params_assemble"
  | "api_dispatch_pre_create_agent_slack_create_run"
  | "api_dispatch_pre_create_agent_teams_entrypoint_gap"
  | "api_dispatch_pre_create_agent_teams_create_run"
  | "api_dispatch_pre_create_agent_workflow_automation_entrypoint_gap"
  | "api_dispatch_pre_create_agent_workflow_automation_queue_admission"
  | "api_dispatch_pre_create_agent_workflow_automation_check_active_run"
  | "api_dispatch_pre_create_agent_workflow_automation_check_target_access"
  | "api_dispatch_pre_create_agent_workflow_automation_resolve_model_context"
  | "api_dispatch_pre_create_agent_workflow_automation_build_run_input"
  | "api_dispatch_pre_create_agent_workflow_automation_create_run"
  | "api_dispatch_pre_create_agent_automation_event_background_start_gap"
  | "api_dispatch_pre_create_agent_automation_event_load_source_state"
  | "api_dispatch_pre_create_agent_automation_event_load_external_events"
  | "api_dispatch_pre_create_agent_automation_event_load_automations"
  | "api_dispatch_pre_create_agent_automation_event_match_automations"
  | "api_dispatch_pre_create_agent_automation_event_record_processed_event"
  | "api_dispatch_pre_create_agent_automation_event_build_run_input"
  | "api_dispatch_pre_create_agent_automation_event_handoff_run"
  | "api_dispatch_check_org_tier"
  | "api_dispatch_check_run_admission"
  | "api_dispatch_prepare_run_callbacks"
  | "api_dispatch_prepare_run_context"
  | "api_dispatch_prepare_context_feature_switches"
  | "api_dispatch_prepare_context_resolve_agent_execution"
  | "api_dispatch_prepare_context_load_persisted_environment"
  | "api_dispatch_prepare_context_build_resolved_body"
  | "api_dispatch_prepare_context_resolve_framework"
  | "api_dispatch_prepare_context_resolve_model_provider"
  | "api_dispatch_prepare_context_select_connector_catalog"
  | "api_dispatch_prepare_context_resolve_thread_connector_selections"
  | "api_dispatch_prepare_context_load_connector_contexts"
  | "api_dispatch_prepare_context_load_stored_connectors"
  | "api_dispatch_prepare_context_load_stored_connector_snapshot_rows"
  | "api_dispatch_prepare_context_materialize_stored_connector_snapshot"
  | "api_dispatch_prepare_context_decrypt_stored_connector_secrets"
  | "api_dispatch_prepare_context_build_stored_connector_state"
  | "api_dispatch_prepare_context_load_custom_connectors"
  | "api_dispatch_prepare_context_load_custom_connector_rows"
  | "api_dispatch_prepare_context_load_custom_connector_value_rows"
  | "api_dispatch_prepare_context_build_custom_connector_firewalls"
  | "api_dispatch_prepare_context_render_custom_connector_auth_templates"
  | "api_dispatch_prepare_context_render_custom_connector_prefixes"
  | "api_dispatch_prepare_context_assemble_custom_connector_firewalls"
  | "api_dispatch_prepare_context_build_permission_manifest"
  | "api_dispatch_prepare_context_load_builtin_permission_indexes"
  | "api_dispatch_prepare_context_apply_builtin_permission_policies"
  | "api_dispatch_prepare_context_apply_custom_permission_policies"
  | "api_dispatch_prepare_context_apply_model_provider_permission_policy"
  | "api_dispatch_prepare_context_merge_permission_manifest"
  | "api_dispatch_prepare_context_validate_environment"
  | "api_dispatch_prepare_context_load_user_timezone"
  | "api_dispatch_prepare_context_prepare_output_metadata"
  | "api_dispatch_resolve_agent_execution_by_agent_id"
  | "api_dispatch_resolve_agent_execution_by_session_id"
  | "api_dispatch_resolve_agent_execution_lookup_agent"
  | "api_dispatch_resolve_agent_execution_lookup_session_snapshot"
  | "api_dispatch_resolve_agent_execution_resolve_session_history"
  | "api_dispatch_check_built_in_credits"
  | "api_dispatch_insert_run_with_concurrency"
  | "api_dispatch_build_runner_job_payload"
  | "api_dispatch_prepare_pi_launch_resources"
  | "api_dispatch_prepare_pi_launch_resume_session"
  | "api_dispatch_persist_atomic_launch"
  | "api_dispatch_admission_lock_wait"
  | "api_dispatch_admission_lock_held"
  | "api_dispatch_subscription_prepare_snapshot"
  | "api_dispatch_subscription_prepare_bundle_proof"
  | "api_dispatch_subscription_validate_admission"
  | "api_dispatch_check_concurrency_limit"
  | "api_dispatch_concurrency_preflight_lock_wait"
  | "api_dispatch_concurrency_preflight_check"
  | "api_dispatch_queue_promotion_lock_wait"
  | "api_dispatch_queue_promotion_lock_held"
  | "api_dispatch_resolve_queue_first_admission"
  | "api_dispatch_claim_queue_first_message"
  | "api_dispatch_resolve_queue_first_claim_snapshot"
  | "api_dispatch_persist_queue_first_replacement"
  | "api_dispatch_queue_first_thread_lock_wait"
  | "api_dispatch_validate_thread_session_snapshot_thread"
  | "api_dispatch_validate_thread_session_snapshot_session"
  | "api_dispatch_activate_usage_allowance_windows"
  | "api_dispatch_load_thread_session_binding"
  | "api_dispatch_update_thread_session_binding"
  | "api_dispatch_prepare_storage_manifest"
  | "api_dispatch_prepare_storage_manifest_resolve_plan"
  | "api_dispatch_prepare_storage_manifest_resolve_inputs"
  | "api_dispatch_prepare_storage_manifest_ensure_artifacts"
  | "api_dispatch_prepare_storage_manifest_ensure_artifact_lookup_storage"
  | "api_dispatch_prepare_storage_manifest_ensure_artifact_insert_storage"
  | "api_dispatch_prepare_storage_manifest_ensure_artifact_refetch_storage"
  | "api_dispatch_prepare_storage_manifest_ensure_artifact_skip_initialized"
  | "api_dispatch_prepare_storage_manifest_ensure_artifact_upload_empty_objects"
  | "api_dispatch_prepare_storage_manifest_ensure_artifact_insert_initial_version"
  | "api_dispatch_prepare_storage_manifest_load_storage_index"
  | "api_dispatch_prepare_storage_manifest_build_entries"
  | "api_dispatch_prepare_storage_manifest_build_compose_entries"
  | "api_dispatch_prepare_storage_manifest_resolve_compose_versions"
  | "api_dispatch_prepare_storage_manifest_generate_compose_urls"
  | "api_dispatch_prepare_storage_manifest_build_additional_entries"
  | "api_dispatch_prepare_storage_manifest_resolve_additional_versions"
  | "api_dispatch_prepare_storage_manifest_generate_additional_urls"
  | "api_dispatch_prepare_storage_manifest_build_artifact_entries"
  | "api_dispatch_prepare_storage_manifest_resolve_artifact_versions"
  | "api_dispatch_prepare_storage_manifest_generate_artifact_urls"
  | "api_dispatch_prepare_storage_manifest_assemble"
  | "api_dispatch_build_stored_execution_context"
  | "api_dispatch_connector_catalog_load_runtime_snapshot"
  | "api_dispatch_connector_catalog_query_projection_identity"
  | "api_dispatch_connector_catalog_query_projection_rows"
  | "api_dispatch_connector_catalog_fetch_projection_rows"
  | "api_dispatch_connector_catalog_validate_projection_rows"
  | "api_dispatch_connector_catalog_parse_projection_rows"
  | "api_dispatch_connector_catalog_verify_projection_row_digests"
  | "api_dispatch_connector_catalog_count_projection_rows"
  | "api_dispatch_connector_catalog_materialize_projection"
  | "api_dispatch_connector_catalog_query_identity"
  | "api_dispatch_connector_catalog_query_payload"
  | "api_dispatch_connector_catalog_decompress"
  | "api_dispatch_connector_catalog_verify_digest"
  | "api_dispatch_connector_catalog_decode_json"
  | "api_dispatch_connector_catalog_validate_schema"
  | "api_dispatch_connector_catalog_validate_public_projection"
  | "api_dispatch_connector_catalog_validate_relationships"
  | "api_dispatch_connector_catalog_validate_compatibility"
  | "api_dispatch_connector_catalog_materialize_accepted_snapshot"
  | "api_dispatch_connector_catalog_materialize_runtime_snapshot"
  | "api_dispatch_connector_catalog_materialize_server_firewalls"
  | "api_dispatch_phase_pre_create"
  | "api_dispatch_phase_prepare_context"
  | "api_dispatch_phase_prepare_launch"
  | "api_dispatch_phase_queue_insert";

type ApiDispatchPhaseActionType =
  | "api_dispatch_phase_pre_create"
  | "api_dispatch_phase_prepare_context"
  | "api_dispatch_phase_prepare_launch"
  | "api_dispatch_phase_queue_insert";

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

interface ApiDispatchTimingRecord {
  readonly actionType: ApiDispatchTimingActionType;
  readonly spanKind: ApiDispatchTimingSpanKind;
  readonly durationMs: number;
  readonly timestamp: string;
  readonly dimensions?: ApiDispatchTimingDimensions;
}

export class ApiDispatchTimingCollector {
  private readonly records: ApiDispatchTimingRecord[] = [];
  private readonly processAgeBucket = apiProcessAgeBucket(performance.now());
  private processDispatchOrdinalBucket:
    | ApiProcessDispatchOrdinalBucket
    | undefined;

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

  flush(args: {
    readonly runId: string;
    readonly runnerGroup: string;
    readonly profile: string;
    readonly dispatchPath: "direct";
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
            dispatch_path: args.dispatchPath,
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
): ApiDispatchTimingDimensions | undefined {
  return typeof dimensions === "function" ? dimensions() : dimensions;
}
