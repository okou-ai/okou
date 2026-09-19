import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import type {
  OfficialWorkflowCatalogReleasePayload,
  OfficialWorkflowDefinitionRevisionPayload,
} from "@okouai/db/jsonb-contracts/official-workflow-catalog";
import { storages, storageVersions } from "./storage";

export const officialWorkflowDefinitionRevisions = pgTable(
  "official_workflow_definition_revisions",
  {
    definitionName: varchar("definition_name", { length: 64 }).notNull(),
    revision: varchar("revision", { length: 64 }).notNull(),
    payload: jsonb("payload")
      .$type<OfficialWorkflowDefinitionRevisionPayload>()
      .notNull(),
    storageName: varchar("storage_name", { length: 256 }).notNull(),
    storageId: uuid("storage_id")
      .notNull()
      .references(() => {
        return storages.id;
      }),
    storageVersion: varchar("storage_version", { length: 64 })
      .notNull()
      .references(() => {
        return storageVersions.id;
      }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "official_workflow_definition_revisions_pk",
        columns: [table.definitionName, table.revision],
      }),
      check(
        "official_workflow_definition_revision_hash_format",
        sql`${table.revision} ~ '^[0-9a-f]{64}$'`,
      ),
    ];
  },
);

export const officialWorkflowCatalogReleases = pgTable(
  "official_workflow_catalog_releases",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    payload: jsonb("payload")
      .$type<OfficialWorkflowCatalogReleasePayload>()
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "official_workflow_catalog_release_hash_format",
        sql`${table.id} ~ '^[0-9a-f]{64}$'`,
      ),
    ];
  },
);

export const officialWorkflowCatalogState = pgTable(
  "official_workflow_catalog_state",
  {
    authority: varchar("authority", { length: 32 }).primaryKey(),
    acceptedReleaseId: varchar("accepted_release_id", { length: 64 })
      .notNull()
      .references(() => {
        return officialWorkflowCatalogReleases.id;
      }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "official_workflow_catalog_state_authority",
        sql`${table.authority} = 'official'`,
      ),
    ];
  },
);

export type OfficialWorkflowReconciliationWorkState = "pending" | "running";

/**
 * Durable, bounded discovery cursor for one Definition's installed fleet.
 * Catalog activation upserts one row per affected Definition; workers page
 * Installations from the authoritative accepted release without fleet fanout
 * in the activation transaction.
 */
export const officialWorkflowReconciliationWork = pgTable(
  "official_workflow_reconciliation_work",
  {
    definitionName: varchar("definition_name", { length: 64 }).primaryKey(),
    requestedReleaseId: varchar("requested_release_id", { length: 64 })
      .notNull()
      .references(() => {
        return officialWorkflowCatalogReleases.id;
      }),
    cursorWorkflowId: uuid("cursor_workflow_id"),
    state: varchar("state", { length: 16 })
      .$type<OfficialWorkflowReconciliationWorkState>()
      .notNull()
      .default("pending"),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_official_workflow_reconciliation_work_due").on(
        table.availableAt,
        table.definitionName,
      ),
      check(
        "official_workflow_reconciliation_work_state_check",
        sql`(
          ${table.state} = 'pending'
          AND ${table.leaseId} IS NULL
          AND ${table.leaseExpiresAt} IS NULL
        ) OR (
          ${table.state} = 'running'
          AND ${table.leaseId} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL
        )`,
      ),
      check(
        "official_workflow_reconciliation_work_attempt_count_check",
        sql`${table.attemptCount} >= 0`,
      ),
    ];
  },
);
