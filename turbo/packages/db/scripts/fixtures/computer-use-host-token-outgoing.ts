// Frozen host column mapping before #38674 removed token_hash from runtime SQL.
// This historical fixture is used only by the two-release migration validator.
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ComputerUseCommandPayload,
  ComputerUseCommandResult,
  ComputerUsePermissions,
  ComputerUseSupportedCapabilities,
} from "../../src/jsonb-contracts/computer-use-host";

export const outgoingHosts = pgTable("computer_use_hosts", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  installationId: uuid("installation_id"),
  displayName: text("display_name").notNull(),
  tokenHash: text("token_hash"),
  sessionId: text("session_id"),
  sessionValidatedAt: timestamp("session_validated_at"),
  connectionGeneration: integer("connection_generation").default(0).notNull(),
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
});

// Commands observed by the same historical writer. Later additive columns must
// not enter its implicit INSERT, SELECT or RETURNING lists before their migration.
export const outgoingCommands = pgTable("computer_use_commands", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  runId: text("run_id"),
  hostId: uuid("host_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").default("queued").notNull(),
  payload: jsonb("payload")
    .$type<ComputerUseCommandPayload>()
    .default({})
    .notNull(),
  result: jsonb("result").$type<ComputerUseCommandResult>(),
  error: text("error"),
  timeoutMs: integer("timeout_ms").notNull(),
  claimedAt: timestamp("claimed_at"),
  claimedConnectionGeneration: integer("claimed_connection_generation"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
