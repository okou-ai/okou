import { agentRunColumns } from "../columns/agent-run";

import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { agents } from "./agent";
import { registerAgentRunReferences } from "./agent-run-reference";

import type { AgentSessionStorageMounts } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";

/**
 * Agent Runs table
 * Created when developer executes agent via SDK
 * Stores an immutable launch snapshot for reproducibility.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    ...agentRunColumns(() => {
      return agentSessions.id;
    }),
  },
  (table) => {
    return [
      // Composite index for user listing with time-based sorting
      index("idx_agent_runs_user_created").on(
        table.userId,
        table.createdAt.desc(),
      ),
      index("idx_agent_runs_org").on(table.orgId),
      // Composite index for status-based heartbeat queries
      index("idx_agent_runs_status_heartbeat").on(
        table.status,
        table.lastHeartbeatAt,
      ),
      // Partial index for cron cleanup (only running status)
      index("idx_agent_runs_running_heartbeat")
        .on(table.lastHeartbeatAt)
        .where(sql`status = 'running'`),
      // Composite index for org+status queries (concurrency checks, queue listing)
      index("idx_agent_runs_org_status_created").on(
        table.orgId,
        table.status,
        table.createdAt.desc(),
      ),
      index("idx_agent_runs_session").on(table.sessionId),
      index("idx_agent_runs_chat_thread_id")
        .on(table.chatThreadId)
        .where(sql`${table.chatThreadId} IS NOT NULL`),
      index("idx_agent_runs_workflow_automation")
        .on(table.workflowAutomationId)
        .where(sql`${table.workflowAutomationId} IS NOT NULL`),
      check(
        "agent_runs_autonomy_budget_check",
        sql`${table.autonomyBudget} >= 0 AND ${table.autonomyBudget} <= 10`,
      ),
      check(
        "agent_runs_metadata_presence_check",
        sql`(
          (
            ${table.triggerSource} IS NULL AND
            ${table.autonomyBudget} IS NULL AND
            ${table.workflowAutomationId} IS NULL AND
            ${table.modelProvider} IS NULL AND
            ${table.modelProviderId} IS NULL AND
            ${table.modelProviderCredentialScope} IS NULL AND
            ${table.selectedModel} IS NULL AND
            ${table.modelRuntimeProvider} IS NULL AND
            ${table.modelRuntimeModel} IS NULL AND
            ${table.builtInModelKeyId} IS NULL AND
            ${table.codexServiceTier} IS NULL AND
            ${table.selectedVideoModel} IS NULL AND
            ${table.selectedImageModel} IS NULL AND
            ${table.chatThreadId} IS NULL AND
            ${table.apiStartedAt} IS NULL AND
            ${table.firstAssistantEventAcknowledgedAt} IS NULL AND
            ${table.summary} IS NULL AND
            ${table.triggerBrief} IS NULL
          ) OR (
            ${table.triggerSource} IS NOT NULL AND
            ${table.autonomyBudget} IS NOT NULL
          )
        )`,
      ),
      check(
        "agent_runs_launch_snapshot_check",
        sql`(
          ${table.launchSnapshot} IS NULL OR (
            jsonb_typeof(${table.launchSnapshot}) = 'object' AND
            jsonb_typeof(${table.launchSnapshot} -> 'framework') = 'string' AND
            ${table.launchSnapshot} ->> 'framework' = ANY (
              ARRAY['claude-code', 'codex', 'pi']
            ) AND
            ((
              jsonb_typeof(
              ${table.launchSnapshot} -> 'runnerProfile'
            ) = 'string' AND
            char_length(${table.launchSnapshot} ->> 'runnerProfile') >= 1 AND
            char_length(${table.launchSnapshot} ->> 'runnerProfile') <= 255 AND
            (
              (
                ${table.launchSnapshot} ?& ARRAY[
                  'schemaVersion',
                  'framework',
                  'runnerProfile'
                ] AND
                (
                  ${table.launchSnapshot} -
                  'schemaVersion' -
                  'framework' -
                  'runnerProfile'
                ) = '{}'::jsonb AND
                ${table.launchSnapshot} -> 'schemaVersion' = '1'::jsonb
              ) OR (
                ${table.launchSnapshot} ?& ARRAY[
                  'schemaVersion',
                  'framework',
                  'runnerProfile',
                  'piMemoryGenerationEnabled'
                ] AND
                (
                  ${table.launchSnapshot} -
                  'schemaVersion' -
                  'framework' -
                  'runnerProfile' -
                  'piMemoryGenerationEnabled'
                ) = '{}'::jsonb AND
                ${table.launchSnapshot} -> 'schemaVersion' = '2'::jsonb AND
                jsonb_typeof(
                  ${table.launchSnapshot} -> 'piMemoryGenerationEnabled'
                ) = 'boolean'
              ) OR (
                ${table.launchSnapshot} ?& ARRAY[
                  'schemaVersion',
                  'framework',
                  'runnerProfile'
                ] AND
                (
                  ${table.launchSnapshot} -
                  'schemaVersion' -
                  'framework' -
                  'runnerProfile'
                ) = '{}'::jsonb AND
                ${table.launchSnapshot} -> 'schemaVersion' = '3'::jsonb
              )
            )
            ) OR (
              ${table.launchSnapshot} ?& ARRAY['schemaVersion', 'framework', 'executionMode', 'inferenceContractVersion'] AND
              (${table.launchSnapshot} - 'schemaVersion' - 'framework' - 'executionMode' - 'inferenceContractVersion') = '{}'::jsonb AND
              ${table.launchSnapshot}->'schemaVersion' = '4'::jsonb AND
              ${table.launchSnapshot}->>'framework' = 'pi' AND
              ${table.launchSnapshot}->'executionMode' = '"api-inference"'::jsonb AND
              ${table.launchSnapshot}->'inferenceContractVersion' = '1'::jsonb
            ))
          )
        )`,
      ),
      check(
        "agent_runs_official_workflow_provenance_check",
        sql`(
          ${table.officialWorkflowProvenance} IS NULL OR (
            jsonb_typeof(${table.officialWorkflowProvenance}) = 'object' AND
            ${table.officialWorkflowProvenance} ?& ARRAY[
              'schemaVersion',
              'definitions'
            ] AND
            (
              ${table.officialWorkflowProvenance} -
              'schemaVersion' -
              'definitions'
            ) = '{}'::jsonb AND
            ${table.officialWorkflowProvenance} -> 'schemaVersion' = '1'::jsonb AND
            jsonb_typeof(
              ${table.officialWorkflowProvenance} -> 'definitions'
            ) = 'array' AND
            jsonb_array_length(
              ${table.officialWorkflowProvenance} -> 'definitions'
            ) > 0 AND
            NOT jsonb_path_exists(
              ${table.officialWorkflowProvenance},
              '$.definitions[*] ? (
                @.type() != "object" ||
                !exists(@.name) ||
                @.name.type() != "string" ||
                !(@.name like_regex "^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$") ||
                !exists(@.revision) ||
                @.revision.type() != "string" ||
                !(@.revision like_regex "^[0-9a-f]{64}$") ||
                !exists(@.artifact) ||
                @.artifact.type() != "object" ||
                exists(
                  @.keyvalue() ? (
                    @.key != "name" &&
                    @.key != "revision" &&
                    @.key != "artifact"
                  )
                ) ||
                !exists(@.artifact.orgId) ||
                @.artifact.orgId != "__system__" ||
                !exists(@.artifact.userId) ||
                @.artifact.userId != "__org__" ||
                !exists(@.artifact.storageName) ||
                @.artifact.storageName.type() != "string" ||
                !(@.artifact.storageName like_regex "^.{1,255}.?$") ||
                !exists(@.artifact.storageId) ||
                @.artifact.storageId.type() != "string" ||
                !(@.artifact.storageId like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$") ||
                !exists(@.artifact.storageVersion) ||
                @.artifact.storageVersion.type() != "string" ||
                !(@.artifact.storageVersion like_regex "^[0-9a-f]{64}$") ||
                exists(
                  @.artifact.keyvalue() ? (
                    @.key != "orgId" &&
                    @.key != "userId" &&
                    @.key != "storageName" &&
                    @.key != "storageId" &&
                    @.key != "storageVersion"
                  )
                )
              )'
            )
          )
        )`,
      ),
    ];
  },
);

/**
 * Agent Sessions table
 * Lightweight Agent-to-conversation association for continue operations.
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id").references(
      () => {
        return agents.id;
      },
      { onDelete: "cascade" },
    ),
    conversationId: uuid("conversation_id").references(
      (): AnyPgColumn => {
        return conversations.id;
      },
      {
        onDelete: "set null",
      },
    ),
    // Canonical writeback mounts used by session continuation.
    storageMounts: jsonb("storage_mounts").$type<AgentSessionStorageMounts>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_agent_sessions_user_agent").on(table.userId, table.agentId),
      index("idx_agent_sessions_org").on(table.orgId),
      index("idx_agent_sessions_agent").on(table.agentId),
      index("idx_agent_sessions_conversation").on(table.conversationId),
    ];
  },
);

/**
 * Conversations table
 * Stores CLI agent conversation history for checkpoint resumption
 *
 * Session history storage strategy:
 * - Resumable new records use cliAgentSessionHistoryHash (R2 blob reference)
 * - Intentionally historyless checkpoints leave both history fields null
 * - Legacy records use cliAgentSessionHistory (TEXT field)
 * - Read logic: use the hash-backed path when present; use TEXT only for
 *   legacy rows that do not have a hash
 */
export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .references(
      (): AnyPgColumn => {
        return agentRuns.id;
      },
      { onDelete: "cascade" },
    )
    .notNull()
    .unique(),
  cliAgentType: varchar("cli_agent_type", { length: 64 }).notNull(),
  cliAgentSessionId: varchar("cli_agent_session_id", { length: 255 }).notNull(),
  /** @deprecated Legacy TEXT storage - new records use hash instead */
  cliAgentSessionHistory: text("cli_agent_session_history"),
  /** SHA-256 hash of the raw session history bytes stored in R2 */
  cliAgentSessionHistoryHash: varchar("cli_agent_session_history_hash", {
    length: 64,
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

registerAgentRunReferences({
  agentRunId: agentRuns.id,
  agentSessionId: agentSessions.id,
});
