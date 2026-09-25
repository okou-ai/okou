import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ComputerUseCommandAuditError,
  ComputerUseCommandAuditRedactedResult,
  ComputerUseCommandPayload,
  ComputerUseCommandResult,
  ComputerUsePermissions,
  ComputerUseSupportedCapabilities,
} from "@okouai/db/jsonb-contracts/computer-use-host";
export type { ComputerUsePermissions } from "@okouai/db/jsonb-contracts/computer-use-host";

export const computerUseHosts = pgTable(
  "computer_use_hosts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    installationId: uuid("installation_id"),
    displayName: text("display_name").notNull(),
    tokenHash: text("token_hash").notNull(),
    appVersion: text("app_version").notNull(),
    osVersion: text("os_version").notNull(),
    supportedCapabilities: jsonb("supported_capabilities")
      .$type<ComputerUseSupportedCapabilities>()
      .default([])
      .notNull(),
    permissions: jsonb("permissions")
      .$type<ComputerUsePermissions>()
      .default({ accessibility: false, screenRecording: false })
      .notNull(),
    status: text("status").default("online").notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_computer_use_hosts_token_hash").on(table.tokenHash),
      uniqueIndex("idx_computer_use_hosts_active_installation")
        .on(table.orgId, table.userId, table.installationId)
        .where(sql`installation_id IS NOT NULL AND revoked_at IS NULL`),
      index("idx_computer_use_hosts_org_user").on(table.orgId, table.userId),
    ];
  },
);

export const computerUseCommands = pgTable(
  "computer_use_commands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    hostId: uuid("host_id").references(() => {
      return computerUseHosts.id;
    }),
    kind: text("kind").notNull(),
    status: text("status").default("queued").notNull(),
    payload: jsonb("payload")
      .$type<ComputerUseCommandPayload>()
      .default({})
      .notNull(),
    result: jsonb("result").$type<ComputerUseCommandResult>(),
    error: text("error"),
    timeoutMs: integer("timeout_ms"),
    claimedAt: timestamp("claimed_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_computer_use_commands_host_status").on(
        table.hostId,
        table.status,
      ),
      // One running command per host. Claim polls race without locks, so
      // this is what makes the losing poll's compare-and-set fail.
      uniqueIndex("idx_computer_use_commands_running_host")
        .on(table.hostId)
        .where(sql`status = 'running'`),
      index("idx_computer_use_commands_org_user").on(table.orgId, table.userId),
      index("idx_computer_use_commands_created").on(table.createdAt),
    ];
  },
);

export const computerUseCommandAuditEvents = pgTable(
  "computer_use_command_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    commandId: uuid("command_id")
      .references(() => {
        return computerUseCommands.id;
      })
      .notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    hostId: uuid("host_id").references(() => {
      return computerUseHosts.id;
    }),
    kind: text("kind").notNull(),
    app: text("app"),
    event: text("event").notNull(),
    approvalOutcome: text("approval_outcome"),
    redactedResult:
      jsonb("redacted_result").$type<ComputerUseCommandAuditRedactedResult>(),
    error: jsonb("error").$type<ComputerUseCommandAuditError>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_computer_use_command_audit_command").on(table.commandId),
      index("idx_computer_use_command_audit_org_user").on(
        table.orgId,
        table.userId,
      ),
      index("idx_computer_use_command_audit_created").on(table.createdAt),
    ];
  },
);

export const computerUseAuthorizationRequests = pgTable(
  "computer_use_authorization_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestTokenHash: text("request_token_hash").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: uuid("run_id").notNull(),
    source: text("source").notNull(),
    chatThreadId: uuid("chat_thread_id"),
    slackConnectionId: uuid("slack_connection_id"),
    slackChannelId: text("slack_channel_id"),
    slackThreadTs: text("slack_thread_ts"),
    teamsConnectionId: uuid("teams_connection_id"),
    teamsConversationId: text("teams_conversation_id"),
    teamsThreadId: text("teams_thread_id"),
    expiresAt: timestamp("expires_at").notNull(),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_computer_use_auth_requests_token_hash").on(
        table.requestTokenHash,
      ),
      index("idx_computer_use_auth_requests_org_user").on(
        table.orgId,
        table.userId,
      ),
      index("idx_computer_use_auth_requests_expires").on(table.expiresAt),
      check(
        "computer_use_auth_requests_source_check",
        sql`source IN ('chat', 'slack', 'teams')`,
      ),
      check(
        "computer_use_auth_requests_scope_check",
        sql`(
          source = 'chat'
          AND chat_thread_id IS NOT NULL
          AND slack_connection_id IS NULL
          AND slack_channel_id IS NULL
          AND slack_thread_ts IS NULL
          AND teams_connection_id IS NULL
          AND teams_conversation_id IS NULL
          AND teams_thread_id IS NULL
        ) OR (
          source = 'slack'
          AND chat_thread_id IS NULL
          AND slack_connection_id IS NOT NULL
          AND slack_channel_id IS NOT NULL
          AND slack_thread_ts IS NOT NULL
          AND teams_connection_id IS NULL
          AND teams_conversation_id IS NULL
          AND teams_thread_id IS NULL
        ) OR (
          source = 'teams'
          AND chat_thread_id IS NULL
          AND slack_connection_id IS NULL
          AND slack_channel_id IS NULL
          AND slack_thread_ts IS NULL
          AND teams_connection_id IS NOT NULL
          AND teams_conversation_id IS NOT NULL
          AND teams_thread_id IS NOT NULL
        )`,
      ),
    ];
  },
);
