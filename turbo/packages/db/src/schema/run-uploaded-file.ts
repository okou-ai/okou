import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentRuns } from "./agent-run";
import { chatThreads } from "./chat-thread";
import type {
  CanonicalAssetDeliveryError,
  CanonicalAssetMaterializationError,
  CanonicalAssetProvenance,
  CanonicalAssetSlackDeliveryDestination,
  RunUploadedFileMetadata,
} from "@okouai/db/jsonb-contracts/run-uploaded-file";

export const RUN_UPLOADED_FILE_SOURCES = [
  "automation-schedule",
  "automation-event",
  "goal",
  "web",
  "slack",
  "teams",
  "feishu",
  "email",
  "telegram",
  "agentphone",
  "github",
  "cli",
  "agent",
] as const;
export type RunUploadedFileSource = (typeof RUN_UPLOADED_FILE_SOURCES)[number];

export const CANONICAL_ASSET_CLASSIFICATIONS = [
  "input",
  "published-output",
] as const;
export type CanonicalAssetClassification =
  (typeof CANONICAL_ASSET_CLASSIFICATIONS)[number];

export const CANONICAL_ASSET_ACCESS_LEVELS = ["private", "published"] as const;
export type CanonicalAssetAccessLevel =
  (typeof CANONICAL_ASSET_ACCESS_LEVELS)[number];

export const CANONICAL_ASSET_MATERIALIZATION_STATUSES = [
  "pending",
  "ready",
  "failed",
] as const;
export type CanonicalAssetMaterializationStatus =
  (typeof CANONICAL_ASSET_MATERIALIZATION_STATUSES)[number];

export const CANONICAL_ASSET_DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "failed",
] as const;
export type CanonicalAssetDeliveryStatus =
  (typeof CANONICAL_ASSET_DELIVERY_STATUSES)[number];

export const CANONICAL_ASSET_VERSION = 1;

export const runUploadedFiles = pgTable(
  "run_uploaded_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "cascade" },
    ),
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    source: varchar("source", { length: 32 }).notNull(),
    externalId: text("external_id").notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id"),
    filename: text("filename"),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    url: text("url"),
    previewImageUrl: text("preview_image_url"),
    // Reserves a row for one preview attempt, so a repeatedly failing video
    // cannot hold a backfill slot on every tick.
    previewAttemptedAt: timestamp("preview_attempted_at"),
    metadata: jsonb("metadata")
      .$type<RunUploadedFileMetadata>()
      .notNull()
      .default({}),
    assetVersion: integer("asset_version"),
    classification: varchar("classification", {
      length: 32,
    }).$type<CanonicalAssetClassification>(),
    accessLevel: varchar("access_level", {
      length: 16,
    }).$type<CanonicalAssetAccessLevel>(),
    materializationStatus: varchar("materialization_status", {
      length: 16,
    }).$type<CanonicalAssetMaterializationStatus>(),
    checksumSha256: varchar("checksum_sha256", { length: 64 }),
    storageKey: text("storage_key"),
    provenance: jsonb("provenance").$type<CanonicalAssetProvenance>(),
    materializationError: jsonb(
      "materialization_error",
    ).$type<CanonicalAssetMaterializationError>(),
    idempotencyScope: text("idempotency_scope"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_run_uploaded_files_run").on(table.runId),
      uniqueIndex("idx_run_uploaded_files_run_source_external").on(
        table.runId,
        table.source,
        table.externalId,
      ),
      index("idx_run_uploaded_files_source_external").on(
        table.source,
        table.externalId,
      ),
      index("idx_run_uploaded_files_updated")
        .on(table.updatedAt, table.id)
        .where(sql`${table.url} IS NOT NULL`),
      uniqueIndex("run_uploaded_files_canonical_idempotency_unique")
        .on(table.userId, table.idempotencyScope, table.idempotencyKey)
        .where(sql`${table.assetVersion} = 1`),
      index("run_uploaded_files_chat_thread_idx")
        .on(table.chatThreadId)
        .where(sql`${table.chatThreadId} IS NOT NULL`),
    ];
  },
);

export const canonicalAssetDeliveries = pgTable(
  "canonical_asset_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    assetId: uuid("asset_id")
      .notNull()
      .references(
        () => {
          return runUploadedFiles.id;
        },
        { onDelete: "cascade" },
      ),
    provider: varchar("provider", { length: 32 }).notNull(),
    operationId: uuid("operation_id").notNull(),
    status: varchar("status", { length: 16 })
      .$type<CanonicalAssetDeliveryStatus>()
      .notNull(),
    destination: jsonb("destination")
      .$type<CanonicalAssetSlackDeliveryDestination>()
      .notNull(),
    externalId: text("external_id"),
    url: text("url"),
    lastError: jsonb("last_error").$type<CanonicalAssetDeliveryError>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex(
        "canonical_asset_deliveries_asset_provider_operation_unique",
      ).on(table.assetId, table.provider, table.operationId),
      index("canonical_asset_deliveries_asset_idx").on(table.assetId),
    ];
  },
);
