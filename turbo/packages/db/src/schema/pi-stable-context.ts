import type {
  PiStableContextBuildInput,
  PiStableContextProjection,
} from "@okouai/db/jsonb-contracts/pi-stable-context";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
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

import { agents } from "./agent";
import { storages, storageVersions } from "./storage";

export type PiStableContextErasureSubjectKind = "organization" | "user";

/**
 * Durable legacy-Clerk erasure closure. Only a one-way digest is retained so
 * late identity-cache refreshes cannot restore stable-context authority.
 */
export const piStableContextErasureFences = pgTable(
  "pi_stable_context_erasure_fences",
  {
    subjectKind: varchar("subject_kind", { length: 16 })
      .$type<PiStableContextErasureSubjectKind>()
      .notNull(),
    subjectDigest: varchar("subject_digest", { length: 64 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "pi_stable_context_erasure_fences_pk",
        columns: [table.subjectKind, table.subjectDigest],
      }),
      check(
        "pi_stable_context_erasure_fences_kind_check",
        sql`${table.subjectKind} IN ('organization', 'user')`,
      ),
    ];
  },
);

export type PiStableContextPublicationState = "pending" | "ready";

/**
 * Authoritative invalidation fence. The agent row covers shared configuration;
 * the user row covers user-scoped connectors, grants, features, and workflows.
 */
export const piStableContextGenerations = pgTable(
  "pi_stable_context_generations",
  {
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    subject: text("subject").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull().default(1),
    publicationState: varchar("publication_state", { length: 16 })
      .$type<PiStableContextPublicationState>()
      .notNull()
      .default("ready"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "pi_stable_context_generations_pk",
        columns: [table.orgId, table.agentId, table.subject],
      }),
      check(
        "pi_stable_context_generations_state_check",
        sql`${table.publicationState} IN ('pending', 'ready')`,
      ),
      check(
        "pi_stable_context_generations_generation_check",
        sql`${table.generation} > 0`,
      ),
    ];
  },
);

/**
 * Concurrent multi-stage sources within one owner scope publish independently.
 * Reusing one publication key supersedes only the older write of that source.
 */
export const piStableContextPublications = pgTable(
  "pi_stable_context_publications",
  {
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    subject: text("subject").notNull(),
    publicationKey: text("publication_key").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    token: uuid("token").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "pi_stable_context_publications_pk",
        columns: [
          table.orgId,
          table.agentId,
          table.subject,
          table.publicationKey,
        ],
      }),
      uniqueIndex("pi_stable_context_publications_token_idx").on(table.token),
      check(
        "pi_stable_context_publications_generation_check",
        sql`${table.generation} > 0`,
      ),
    ];
  },
);

/** Owner-bound immutable artifacts. The owner fields prevent cross-tenant reuse. */
export const piStableContextArtifacts = pgTable(
  "pi_stable_context_artifacts",
  {
    digest: varchar("digest", { length: 64 }).primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    projection: jsonb("projection")
      .$type<PiStableContextProjection>()
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "pi_stable_context_artifacts_agent_fk",
        columns: [table.agentId],
        foreignColumns: [agents.id],
      }).onDelete("cascade"),
      index("pi_stable_context_artifacts_owner_idx").on(
        table.orgId,
        table.userId,
        table.agentId,
      ),
      index("pi_stable_context_artifacts_created_at_idx").on(table.createdAt),
    ];
  },
);

export type PiStableContextHeadStatus =
  | "missing"
  | "pending"
  | "running"
  | "ready"
  | "unindexable"
  | "failed";

/** One current generation per owner and stable request variant. */
export const piStableContextHeads = pgTable(
  "pi_stable_context_heads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    variantDigest: varchar("variant_digest", { length: 64 }).notNull(),
    generation: bigint("generation", { mode: "number" }).notNull().default(1),
    agentGeneration: bigint("agent_generation", { mode: "number" })
      .notNull()
      .default(1),
    userGeneration: bigint("user_generation", { mode: "number" })
      .notNull()
      .default(1),
    inputDigest: varchar("input_digest", { length: 64 }),
    status: varchar("status", { length: 16 })
      .$type<PiStableContextHeadStatus>()
      .notNull()
      .default("missing"),
    input: jsonb("input").$type<PiStableContextBuildInput>(),
    artifactDigest: varchar("artifact_digest", { length: 64 }).references(
      () => {
        return piStableContextArtifacts.digest;
      },
    ),
    validityHorizon: timestamp("validity_horizon"),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastErrorClass: varchar("last_error_class", { length: 128 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "pi_stable_context_heads_agent_fk",
        columns: [table.agentId],
        foreignColumns: [agents.id],
      }).onDelete("cascade"),
      uniqueIndex("pi_stable_context_heads_owner_variant_idx").on(
        table.orgId,
        table.userId,
        table.agentId,
        table.variantDigest,
      ),
      index("pi_stable_context_heads_pending_idx")
        .on(table.availableAt, table.id)
        .where(sql`${table.status} IN ('pending', 'failed')`),
      index("pi_stable_context_heads_lease_idx")
        .on(table.leaseExpiresAt, table.id)
        .where(sql`${table.status} = 'running'`),
      check(
        "pi_stable_context_heads_status_check",
        sql`${table.status} IN ('missing', 'pending', 'running', 'ready', 'unindexable', 'failed')`,
      ),
      check(
        "pi_stable_context_heads_generation_check",
        sql`${table.generation} > 0 AND ${table.agentGeneration} > 0 AND ${table.userGeneration} > 0`,
      ),
      check(
        "pi_stable_context_heads_input_check",
        sql`(${table.status} = 'missing' AND ${table.input} IS NULL AND ${table.inputDigest} IS NULL) OR (${table.status} <> 'missing' AND ${table.input} IS NOT NULL AND ${table.inputDigest} IS NOT NULL)`,
      ),
      check(
        "pi_stable_context_heads_artifact_check",
        sql`(${table.status} = 'ready' AND ${table.artifactDigest} IS NOT NULL) OR (${table.status} <> 'ready' AND ${table.artifactDigest} IS NULL)`,
      ),
      check(
        "pi_stable_context_heads_lease_check",
        sql`(${table.status} = 'running' AND ${table.leaseId} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.leaseId} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
      ),
      check(
        "pi_stable_context_heads_attempt_check",
        sql`${table.attemptCount} >= 0`,
      ),
    ];
  },
);

/** Retention and erasure edges for every exact Storage dependency. */
export const piStableContextArtifactResources = pgTable(
  "pi_stable_context_artifact_resources",
  {
    artifactDigest: varchar("artifact_digest", { length: 64 }).notNull(),
    ordinal: integer("ordinal").notNull(),
    storageId: uuid("storage_id").notNull(),
    storageVersionId: varchar("storage_version_id", { length: 64 }).notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "pi_stable_context_artifact_resources_pk",
        columns: [table.artifactDigest, table.ordinal],
      }),
      foreignKey({
        name: "pi_stable_context_artifact_resources_artifact_fk",
        columns: [table.artifactDigest],
        foreignColumns: [piStableContextArtifacts.digest],
      }).onDelete("cascade"),
      foreignKey({
        name: "pi_stable_context_artifact_resources_storage_fk",
        columns: [table.storageId],
        foreignColumns: [storages.id],
      }).onDelete("cascade"),
      foreignKey({
        name: "pi_stable_context_artifact_resources_version_fk",
        columns: [table.storageVersionId],
        foreignColumns: [storageVersions.id],
      }).onDelete("cascade"),
      uniqueIndex("pi_stable_context_artifact_resources_version_idx").on(
        table.artifactDigest,
        table.storageVersionId,
        table.ordinal,
      ),
      index("pi_stable_context_artifact_resources_storage_idx").on(
        table.storageId,
      ),
      check(
        "pi_stable_context_artifact_resources_ordinal_check",
        sql`${table.ordinal} >= 0`,
      ),
    ];
  },
);
