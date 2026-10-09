import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { agents } from "./agent";
import type {
  BankingAccessAuditMetadata,
  BankingAccountMetadata,
  BankingAccountProviderIds,
  BankingConnectionAuditMetadata,
  BankingOperationScope,
  BankingOperationScopes,
} from "@okouai/db/jsonb-contracts/banking";
export type { BankingOperationScope } from "@okouai/db/jsonb-contracts/banking";

export type BankingProvider = "finicity";
export type BankingConnectionStatus =
  "active" | "repair_required" | "revoked" | "deleted";
export type BankingAuditStatus = "allowed" | "denied";
export type BankingConnectSessionMode = "connect" | "fix";
export type BankingConnectSessionStatus =
  "pending" | "completed" | "cancelled" | "failed" | "superseded";

export const bankingConnections = pgTable(
  "banking_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    provider: varchar("provider", { length: 32 })
      .$type<BankingProvider>()
      .notNull()
      .default("finicity"),
    providerCustomerId: varchar("provider_customer_id", {
      length: 128,
    }).notNull(),
    status: varchar("status", { length: 32 })
      .$type<BankingConnectionStatus>()
      .notNull()
      .default("active"),
    consentExpiresAt: timestamp("consent_expires_at"),
    repairRequiredAt: timestamp("repair_required_at"),
    revokedAt: timestamp("revoked_at"),
    deletedAt: timestamp("deleted_at"),
    auditMetadata: jsonb("audit_metadata")
      .$type<BankingConnectionAuditMetadata>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_banking_connections_owner_provider").on(
        table.orgId,
        table.userId,
        table.provider,
      ),
      index("idx_banking_connections_org_user").on(table.orgId, table.userId),
    ];
  },
);

export const bankingAccounts = pgTable(
  "banking_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return bankingConnections.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    providerAccountId: varchar("provider_account_id", {
      length: 128,
    }).notNull(),
    displayName: varchar("display_name", { length: 256 }),
    institutionName: varchar("institution_name", { length: 256 }),
    institutionLoginId: varchar("institution_login_id", { length: 128 }),
    accountType: varchar("account_type", { length: 64 }),
    accountNumberLast4: varchar("account_number_last4", { length: 8 }),
    enabled: boolean("enabled").notNull().default(true),
    repairRequiredAt: timestamp("repair_required_at"),
    metadata: jsonb("metadata")
      .$type<BankingAccountMetadata>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_banking_accounts_connection_provider_account").on(
        table.connectionId,
        table.providerAccountId,
      ),
      index("idx_banking_accounts_org_user").on(table.orgId, table.userId),
    ];
  },
);

export const bankingAgentEnablements = pgTable(
  "banking_agent_enablements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return bankingConnections.id;
        },
        { onDelete: "cascade" },
      ),
    accountProviderIds: jsonb("account_provider_ids")
      .$type<BankingAccountProviderIds>()
      .notNull()
      .default([]),
    operationScopes: jsonb("operation_scopes")
      .$type<BankingOperationScopes>()
      .notNull()
      .default(["accounts.read", "balances.read", "transactions.read"]),
    // Whether automation-triggered runs may use this banking enablement.
    allowAutomationRuns: boolean("allow_automation_runs")
      .notNull()
      .default(false),
    purpose: text("purpose"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "banking_agent_enablements_agent_id_agents_id_fk",
        columns: [table.agentId],
        foreignColumns: [agents.id],
      }).onDelete("cascade"),
      uniqueIndex("idx_banking_agent_enablements_unique").on(
        table.orgId,
        table.userId,
        table.agentId,
        table.connectionId,
      ),
      index("idx_banking_agent_enablements_agent_user").on(
        table.agentId,
        table.userId,
      ),
    ];
  },
);

export const bankingConnectSessions = pgTable(
  "banking_connect_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return bankingConnections.id;
        },
        { onDelete: "cascade" },
      ),
    mode: varchar("mode", { length: 16 })
      .$type<BankingConnectSessionMode>()
      .notNull(),
    status: varchar("status", { length: 16 })
      .$type<BankingConnectSessionStatus>()
      .notNull()
      .default("pending"),
    institutionLoginId: varchar("institution_login_id", { length: 128 }),
    addedAt: timestamp("added_at"),
    doneAt: timestamp("done_at"),
    completedAt: timestamp("completed_at"),
    endReason: varchar("end_reason", { length: 64 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_banking_connect_sessions_owner").on(
        table.orgId,
        table.userId,
        table.createdAt,
      ),
      index("idx_banking_connect_sessions_connection").on(
        table.connectionId,
        table.createdAt,
      ),
      uniqueIndex("idx_banking_connect_sessions_one_pending")
        .on(table.connectionId)
        .where(sql`${table.status} = 'pending'`),
    ];
  },
);

export const bankingConnectEvents = pgTable(
  "banking_connect_events",
  {
    eventId: varchar("event_id", { length: 128 }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(
        () => {
          return bankingConnectSessions.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    endReason: varchar("end_reason", { length: 64 }),
    providerOccurredAt: timestamp("provider_occurred_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_banking_connect_events_session").on(
        table.sessionId,
        table.createdAt,
      ),
    ];
  },
);

export const bankingAccessAuditEvents = pgTable(
  "banking_access_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: uuid("run_id"),
    agentId: uuid("agent_id"),
    connectionId: uuid("connection_id"),
    provider: varchar("provider", { length: 32 })
      .$type<BankingProvider>()
      .notNull()
      .default("finicity"),
    providerAccountId: varchar("provider_account_id", { length: 128 }),
    action: varchar("action", { length: 64 })
      .$type<BankingOperationScope>()
      .notNull(),
    status: varchar("status", { length: 16 })
      .$type<BankingAuditStatus>()
      .notNull(),
    failureCode: varchar("failure_code", { length: 64 }),
    metadata: jsonb("metadata")
      .$type<BankingAccessAuditMetadata>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_banking_access_audit_org_user").on(table.orgId, table.userId),
      index("idx_banking_access_audit_run").on(table.runId),
      index("idx_banking_access_audit_created").on(table.createdAt),
    ];
  },
);
