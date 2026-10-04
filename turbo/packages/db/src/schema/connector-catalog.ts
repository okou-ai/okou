import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ConnectorCatalogCompatibilityEvaluationPayload } from "@okouai/db/jsonb-contracts/connector-catalog";
import type {
  JsonObject,
  JsonReadonlyStringArray,
} from "@okouai/db/jsonb-contracts/shared";

// The immutable catalog reader is not connected until the subsequent migration.
export const connectorCatalog = pgTable("connector_catalog", {
  schemaVersion: integer("schema_version").primaryKey(),
  hash: text("hash").notNull(),
  activatedAt: timestamp("activated_at").notNull(),
  catalogVersion: text("catalog_version"),
  catalogHeader: jsonb("catalog_header").$type<JsonObject>().notNull(),
  entrySlugs: jsonb("entry_slugs").$type<JsonReadonlyStringArray>().notNull(),
});

export const connectorCatalogEntries = pgTable(
  "connector_catalog_entries",
  {
    hash: text("hash").notNull(),
    slug: text("slug").notNull(),
    payload: jsonb("payload").$type<JsonObject>().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.hash, table.slug] })];
  },
);

export const CONNECTOR_CATALOG_ATTEMPT_OUTCOMES = [
  "accepted",
  "unchanged",
  "rejected",
] as const;
export type ConnectorCatalogAttemptOutcome =
  (typeof CONNECTOR_CATALOG_ATTEMPT_OUTCOMES)[number];

export const CONNECTOR_CATALOG_FAILURE_CODES = [
  "source-unavailable",
  "object-too-large",
  "invalid-json",
  "invalid-pointer",
  "invalid-reference",
  "digest-mismatch",
  "unsupported-schema",
  "invalid-artifact",
  "public-leakage",
  "relationship-mismatch",
  "invalid-compression",
] as const;
export type ConnectorCatalogFailureCode =
  (typeof CONNECTOR_CATALOG_FAILURE_CODES)[number];

const byteaColumn = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const connectorCatalogSyncState = pgTable(
  "connector_catalog_sync_state",
  {
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    revision: integer("revision").default(0).notNull(),
    lastObservedCatalogVersion: varchar("last_observed_catalog_version", {
      length: 255,
    }),
    lastObservedCatalogKey: text("last_observed_catalog_key"),
    lastObservedCatalogDigest: varchar("last_observed_catalog_digest", {
      length: 71,
    }),
    lastObservedPointerEtag: text("last_observed_pointer_etag"),
    lastAttemptAt: timestamp("last_attempt_at"),
    lastAttemptOutcome: varchar("last_attempt_outcome", {
      length: 32,
    }).$type<ConnectorCatalogAttemptOutcome>(),
    lastAttemptReusedCachedRejection: boolean(
      "last_attempt_reused_cached_rejection",
    ),
    lastSuccessAt: timestamp("last_success_at"),
    lastFailureCode: varchar("last_failure_code", {
      length: 64,
    }).$type<ConnectorCatalogFailureCode>(),
    lastRejectedCatalogVersion: varchar("last_rejected_catalog_version", {
      length: 255,
    }),
    lastRejectedCatalogKey: text("last_rejected_catalog_key"),
    lastRejectedCatalogDigest: varchar("last_rejected_catalog_digest", {
      length: 71,
    }),
    lastRejectedPointerEtag: text("last_rejected_pointer_etag"),
    lastRejectedFailureCode: varchar("last_rejected_failure_code", {
      length: 64,
    }).$type<ConnectorCatalogFailureCode>(),
    lastRejectedBackendVersion: varchar("last_rejected_backend_version", {
      length: 64,
    }),
    lastRejectedBuildCommitSha: varchar("last_rejected_build_commit_sha", {
      length: 40,
    }),
  },
  (table) => {
    return [
      primaryKey({
        name: "connector_catalog_sync_state_pk",
        columns: [table.sourceId, table.schemaVersion],
      }),
      check(
        "connector_catalog_sync_state_schema_version_positive",
        sql`${table.schemaVersion} > 0`,
      ),
      check(
        "connector_catalog_sync_state_revision_nonnegative",
        sql`${table.revision} >= 0`,
      ),
      check(
        "connector_catalog_sync_state_observed_identity_complete",
        sql`(
          ${table.lastObservedCatalogVersion} IS NULL
          AND ${table.lastObservedCatalogKey} IS NULL
          AND ${table.lastObservedCatalogDigest} IS NULL
        ) OR (
          ${table.lastObservedCatalogVersion} IS NOT NULL
          AND ${table.lastObservedCatalogKey} IS NOT NULL
          AND ${table.lastObservedCatalogDigest} IS NOT NULL
        )`,
      ),
      check(
        "connector_catalog_sync_state_attempt_complete",
        sql`(
          ${table.lastAttemptOutcome} IS NULL
          AND ${table.lastAttemptAt} IS NULL
          AND ${table.lastFailureCode} IS NULL
        ) OR (
          ${table.lastAttemptOutcome} = 'rejected'
          AND ${table.lastAttemptAt} IS NOT NULL
          AND ${table.lastFailureCode} IS NOT NULL
        ) OR (
          ${table.lastAttemptOutcome} IN ('accepted', 'unchanged')
          AND ${table.lastAttemptAt} IS NOT NULL
          AND ${table.lastFailureCode} IS NULL
        )`,
      ),
      check(
        "connector_catalog_sync_state_attempt_cache_reuse_complete",
        sql`(
          ${table.lastAttemptOutcome} IS NULL
          AND ${table.lastAttemptReusedCachedRejection} IS NULL
        ) OR (
          ${table.lastAttemptOutcome} IS NOT NULL
          AND ${table.lastAttemptReusedCachedRejection} IS NOT NULL
          AND (
            ${table.lastAttemptReusedCachedRejection} = FALSE
            OR ${table.lastAttemptOutcome} = 'rejected'
          )
        )`,
      ),
      check(
        "connector_catalog_sync_state_rejected_candidate_complete",
        sql`(
          ${table.lastRejectedCatalogVersion} IS NULL
          AND ${table.lastRejectedCatalogKey} IS NULL
          AND ${table.lastRejectedCatalogDigest} IS NULL
          AND ${table.lastRejectedPointerEtag} IS NULL
          AND ${table.lastRejectedFailureCode} IS NULL
        ) OR (
          ${table.lastRejectedFailureCode} IS NOT NULL
          AND ${table.lastRejectedFailureCode} <> 'source-unavailable'
          AND (
            (
              ${table.lastRejectedCatalogVersion} IS NOT NULL
              AND ${table.lastRejectedCatalogKey} IS NOT NULL
              AND ${table.lastRejectedCatalogDigest} IS NOT NULL
            ) OR ${table.lastRejectedPointerEtag} IS NOT NULL
          )
          AND (
            (
              ${table.lastRejectedCatalogVersion} IS NULL
              AND ${table.lastRejectedCatalogKey} IS NULL
              AND ${table.lastRejectedCatalogDigest} IS NULL
            ) OR (
              ${table.lastRejectedCatalogVersion} IS NOT NULL
              AND ${table.lastRejectedCatalogKey} IS NOT NULL
              AND ${table.lastRejectedCatalogDigest} IS NOT NULL
            )
          )
        )`,
      ),
      check(
        "connector_catalog_sync_state_rejection_authority_complete",
        sql`(
          ${table.lastRejectedFailureCode} IS NULL
          AND ${table.lastRejectedBackendVersion} IS NULL
          AND ${table.lastRejectedBuildCommitSha} IS NULL
        ) OR (
          ${table.lastRejectedFailureCode} IS NOT NULL
          AND ${table.lastRejectedBackendVersion} IS NOT NULL
          AND ${table.lastRejectedBackendVersion} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'
          AND (
            ${table.lastRejectedBuildCommitSha} IS NULL
            OR ${table.lastRejectedBuildCommitSha} ~ '^[a-f0-9]{40}$'
          )
        )`,
      ),
    ];
  },
);

export const connectorCatalogActiveSnapshot = pgTable(
  "connector_catalog_active_snapshot",
  {
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    catalogVersion: varchar("catalog_version", { length: 255 }).notNull(),
    catalogKey: text("catalog_key").notNull(),
    catalogDigest: varchar("catalog_digest", { length: 71 }).notNull(),
    catalogRawSize: integer("catalog_raw_size").notNull(),
    catalogGzip: byteaColumn("catalog_gzip").notNull(),
    activatedAt: timestamp("activated_at").notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "connector_catalog_active_snapshot_pk",
        columns: [table.sourceId, table.schemaVersion],
      }),
      foreignKey({
        name: "connector_catalog_active_snapshot_sync_state_fk",
        columns: [table.sourceId, table.schemaVersion],
        foreignColumns: [
          connectorCatalogSyncState.sourceId,
          connectorCatalogSyncState.schemaVersion,
        ],
      }),
      check(
        "connector_catalog_active_snapshot_schema_version_positive",
        sql`${table.schemaVersion} > 0`,
      ),
      check(
        "connector_catalog_active_snapshot_catalog_raw_size_positive",
        sql`${table.catalogRawSize} > 0`,
      ),
      check(
        "connector_catalog_active_snapshot_catalog_digest_valid",
        sql`${table.catalogDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
    ];
  },
);

export const connectorCatalogRuntimeProjectionSets = pgTable(
  "connector_catalog_runtime_projection_sets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    catalogVersion: varchar("catalog_version", { length: 255 }).notNull(),
    catalogDigest: varchar("catalog_digest", { length: 71 }).notNull(),
    projectionVersion: integer("projection_version").notNull(),
    connectorCount: integer("connector_count").notNull(),
    catalogValidationBackendVersion: varchar(
      "catalog_validation_backend_version",
      { length: 64 },
    ).notNull(),
    catalogValidationBuildCommitSha: varchar(
      "catalog_validation_build_commit_sha",
      { length: 40 },
    ),
  },
  (table) => {
    return [
      uniqueIndex(
        "connector_catalog_runtime_projection_sets_source_schema_unique",
      ).on(table.sourceId, table.schemaVersion),
      foreignKey({
        name: "connector_catalog_runtime_projection_sets_sync_state_fk",
        columns: [table.sourceId, table.schemaVersion],
        foreignColumns: [
          connectorCatalogSyncState.sourceId,
          connectorCatalogSyncState.schemaVersion,
        ],
      }),
      check(
        "connector_catalog_projection_sets_schema_positive",
        sql`${table.schemaVersion} > 0`,
      ),
      check(
        "connector_catalog_projection_sets_version_supported",
        sql`${table.projectionVersion} = 2`,
      ),
      check(
        "connector_catalog_projection_sets_count_positive",
        sql`${table.connectorCount} > 0`,
      ),
      check(
        "connector_catalog_projection_sets_digest_valid",
        sql`${table.catalogDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
      check(
        "connector_catalog_projection_sets_validator_complete",
        sql`${table.catalogValidationBackendVersion} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'
          AND (
            ${table.catalogValidationBuildCommitSha} IS NULL
            OR ${table.catalogValidationBuildCommitSha} ~ '^[a-f0-9]{40}$'
          )`,
      ),
    ];
  },
);

export const connectorCatalogRuntimeProjections = pgTable(
  "connector_catalog_runtime_projections",
  {
    projectionSetId: uuid("projection_set_id").notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }).notNull(),
    connectorDigest: varchar("connector_digest", { length: 71 }).notNull(),
    connectorPayload: byteaColumn("connector_payload").notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "connector_catalog_runtime_projections_pk",
        columns: [table.projectionSetId, table.connectorSlug],
      }),
      foreignKey({
        name: "connector_catalog_runtime_projections_set_fk",
        columns: [table.projectionSetId],
        foreignColumns: [connectorCatalogRuntimeProjectionSets.id],
      }).onDelete("cascade"),
      check(
        "connector_catalog_projections_connector_digest_valid",
        sql`${table.connectorDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
    ];
  },
);

export const connectorCatalogCompatibilityEvaluation = pgTable(
  "connector_catalog_compatibility_evaluation",
  {
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    catalogVersion: varchar("catalog_version", { length: 255 }).notNull(),
    catalogDigest: varchar("catalog_digest", { length: 71 }).notNull(),
    executableCapabilityDigest: varchar("executable_capability_digest", {
      length: 71,
    }).notNull(),
    catalogValidationBackendVersion: varchar(
      "catalog_validation_backend_version",
      {
        length: 64,
      },
    ),
    catalogValidationBuildCommitSha: varchar(
      "catalog_validation_build_commit_sha",
      {
        length: 40,
      },
    ),
    evaluatedAt: timestamp("evaluated_at").notNull(),
    filteredAuthMethods: jsonb("filtered_auth_methods")
      .$type<ConnectorCatalogCompatibilityEvaluationPayload>()
      .notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "connector_catalog_compatibility_evaluation_pk",
        columns: [
          table.sourceId,
          table.schemaVersion,
          table.catalogVersion,
          table.catalogDigest,
          table.executableCapabilityDigest,
        ],
      }),
      foreignKey({
        name: "connector_catalog_compatibility_evaluation_sync_state_fk",
        columns: [table.sourceId, table.schemaVersion],
        foreignColumns: [
          connectorCatalogSyncState.sourceId,
          connectorCatalogSyncState.schemaVersion,
        ],
      }),
      check(
        "connector_catalog_compat_eval_schema_version_positive",
        sql`${table.schemaVersion} > 0`,
      ),
      check(
        "connector_catalog_compatibility_evaluation_digest_valid",
        sql`${table.executableCapabilityDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
      check(
        "connector_catalog_compatibility_catalog_digest_valid",
        sql`${table.catalogDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
      check(
        "connector_catalog_compat_validation_authority_complete",
        sql`(
          ${table.catalogValidationBackendVersion} IS NULL
          AND ${table.catalogValidationBuildCommitSha} IS NULL
        ) OR (
          ${table.catalogValidationBackendVersion} IS NOT NULL
          AND ${table.catalogValidationBackendVersion} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'
          AND (
            ${table.catalogValidationBuildCommitSha} IS NULL
            OR ${table.catalogValidationBuildCommitSha} ~ '^[a-f0-9]{40}$'
          )
        )`,
      ),
    ];
  },
);
