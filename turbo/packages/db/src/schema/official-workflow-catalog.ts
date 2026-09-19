import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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
    authority: varchar("authority", { length: 64 })
      .notNull()
      .default("official"),
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
        columns: [table.authority, table.definitionName, table.revision],
      }),
      check(
        "official_workflow_definition_revision_authority",
        sql`${table.authority} = 'official' OR ${table.authority} ~ '^test:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
      ),
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
    authority: varchar("authority", { length: 64 })
      .notNull()
      .default("official"),
    id: varchar("id", { length: 64 }).notNull(),
    payload: jsonb("payload")
      .$type<OfficialWorkflowCatalogReleasePayload>()
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "official_workflow_catalog_releases_pk",
        columns: [table.authority, table.id],
      }),
      check(
        "official_workflow_catalog_release_authority",
        sql`${table.authority} = 'official' OR ${table.authority} ~ '^test:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
      ),
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
    authority: varchar("authority", { length: 64 })
      .primaryKey()
      .default("official"),
    acceptedReleaseId: varchar("accepted_release_id", { length: 64 }).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "official_workflow_catalog_state_authority",
        sql`${table.authority} = 'official' OR ${table.authority} ~ '^test:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
      ),
      foreignKey({
        name: "official_workflow_catalog_state_release_fk",
        columns: [table.authority, table.acceptedReleaseId],
        foreignColumns: [
          officialWorkflowCatalogReleases.authority,
          officialWorkflowCatalogReleases.id,
        ],
      }),
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
    authority: varchar("authority", { length: 64 })
      .notNull()
      .default("official"),
    definitionName: varchar("definition_name", { length: 64 }).notNull(),
    requestedReleaseId: varchar("requested_release_id", {
      length: 64,
    }).notNull(),
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
      primaryKey({
        name: "official_workflow_reconciliation_work_pk",
        columns: [table.authority, table.definitionName],
      }),
      foreignKey({
        name: "official_workflow_reconciliation_work_release_fk",
        columns: [table.authority, table.requestedReleaseId],
        foreignColumns: [
          officialWorkflowCatalogReleases.authority,
          officialWorkflowCatalogReleases.id,
        ],
      }),
      index("idx_official_workflow_reconciliation_work_due").on(
        table.authority,
        table.availableAt,
        table.definitionName,
      ),
      check(
        "official_workflow_reconciliation_work_authority",
        sql`${table.authority} = 'official' OR ${table.authority} ~ '^test:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
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
