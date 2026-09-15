import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { RunnerCancellationMode } from "@okouai/api-contracts/contracts/runners";
import {
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  integer,
  boolean,
  bigint,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { chatThreads } from "../schema/chat-thread";
import { workflowAutomations } from "../schema/workflow";
import type {
  AgentRunLaunchSnapshot,
  AgentRunOfficialWorkflowProvenance,
  AgentRunResult,
  AgentRunSecretNames,
  AgentRunStorageMounts,
  AgentRunVars,
} from "@okouai/db/jsonb-contracts/agent-run-session-conversation";

/** Shared physical and runtime column builders. */
export function agentRunColumns(sessionId: () => AnyPgColumn) {
  return {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Clerk user ID - owner of this run
    continuedFromSessionId: uuid("continued_from_session_id"),
    sessionId: uuid("session_id")
      .notNull()
      .references(
        (): AnyPgColumn => {
          return sessionId();
        },
        { onDelete: "cascade" },
      ),
    status: varchar("status", { length: 20 }).notNull(),
    // Explicit stop intent. NULL preserves ordinary completion and older writers.
    runnerCancellationMode: text(
      "runner_cancellation_mode",
    ).$type<RunnerCancellationMode>(),
    prompt: text("prompt").notNull(),
    appendSystemPrompt: text("append_system_prompt"),
    vars: jsonb("vars").$type<AgentRunVars>(),
    // Secret names for validation (values never stored - must be provided at runtime)
    secretNames: jsonb("secret_names").$type<AgentRunSecretNames>(),
    // Canonical resolved mounts used by new run writers.
    storageMounts: jsonb("storage_mounts").$type<AgentRunStorageMounts>(),
    launchSnapshot: jsonb("launch_snapshot").$type<AgentRunLaunchSnapshot>(),
    // Immutable per-run telemetry admission; tracing is disabled unless the
    // run was explicitly created with the user switch enabled.
    langfuseTraceEnabled: boolean("langfuse_trace_enabled")
      .default(false)
      .notNull(),
    // Exact accepted Definition inputs mounted for this Run. Null preserves
    // historical and non-Official producers during the additive rollout.
    officialWorkflowProvenance: jsonb(
      "official_workflow_provenance",
    ).$type<AgentRunOfficialWorkflowProvenance>(),
    sandboxId: varchar("sandbox_id", { length: 255 }),
    // One of: "reused" | "featureDisabled" | "noSessionId" | "noReuseKey" |
    // "poolMiss" | "profileMismatch" | "deviceLimitMismatch" | "unparkFailed".
    // Null means unknown (old runner or historical row); "noSessionId" is a
    // legacy ambiguous result.
    sandboxReuseResult: varchar("sandbox_reuse_result", { length: 50 }),
    // Final workspace reuse outcome after sandbox preparation. Null means the
    // runner did not reach a reliable decision or predates this field.
    workspaceReuseResult: varchar("workspace_reuse_result", { length: 50 }),
    // Null identifies a historical claim without cancellation recovery.
    // Current claims initialize false; false/true records whether recovery
    // completion has been reported. The barrier is active only while the
    // public run status is cancelled.
    cancellationRecoveryCompleted: boolean("cancellation_recovery_completed"),
    result: jsonb("result").$type<AgentRunResult>(),
    error: text("error"),
    failureReason: text("failure_reason").$type<RunFailureReasonToken>(),
    lastEventSequence: integer("last_event_sequence"),
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    creditAdmitted: boolean("credit_admitted").notNull().default(false),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    lastHeartbeatAt: timestamp("last_heartbeat_at"),
    // Immutable winning official claim attribution. ID/generation is the
    // authority; hostname/version are diagnostic snapshots. Null covers
    // historical, rollout-omitting, and non-official claims.
    runnerId: uuid("runner_id"),
    runnerHeartbeatGeneration: bigint("runner_heartbeat_generation", {
      mode: "number",
    }),
    runnerHostname: varchar("runner_hostname", { length: 255 }),
    runnerVersion: varchar("runner_version", { length: 128 }),
    activeInputEnabled: boolean("active_input_enabled")
      .default(false)
      .notNull(),
    runnerGroup: varchar("runner_group", { length: 255 }),
    // Null discriminators identify accepted lifecycle-only history where all
    // product metadata is absent. Product runs write both fields together.
    triggerSource: varchar("trigger_source", { length: 20 }),
    autonomyBudget: integer("autonomy_budget"),
    workflowAutomationId: uuid("workflow_automation_id").references(
      (): AnyPgColumn => {
        return workflowAutomations.id;
      },
      { onDelete: "set null" },
    ),
    modelProvider: varchar("model_provider", { length: 100 }),
    modelProviderId: uuid("model_provider_id"),
    // Proven upstream identity at admission, never a token/ciphertext hash.
    // Null historical bindings cannot authorize failed-run account management.
    modelProviderAccountIdentity: varchar("model_provider_account_identity", {
      length: 64,
    }),
    modelProviderCredentialScope: varchar("model_provider_credential_scope", {
      length: 20,
    }),
    selectedModel: varchar("selected_model", { length: 255 }),
    modelRuntimeProvider: varchar("model_runtime_provider", { length: 100 }),
    modelRuntimeModel: varchar("model_runtime_model", { length: 255 }),
    builtInModelKeyId: uuid("built_in_model_key_id"),
    reasoningEffort: varchar("reasoning_effort", {
      length: 20,
    }).$type<ReasoningEffort>(),
    codexServiceTier: varchar("codex_service_tier", {
      length: 20,
    }).$type<CodexServiceTier>(),
    selectedVideoModel: varchar("selected_video_model", { length: 255 }),
    /** Built-in image model default snapshotted for this run. */
    selectedImageModel: varchar("selected_image_model", { length: 255 }),
    chatThreadId: uuid("chat_thread_id").references(
      (): AnyPgColumn => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    apiStartedAt: timestamp("api_started_at"),
    firstAssistantEventAcknowledgedAt: timestamp(
      "first_assistant_event_acknowledged_at",
    ),
    summary: text("summary"),
    triggerBrief: text("trigger_brief"),
  };
}
