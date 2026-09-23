import {
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
import { builtInGenerationJobs } from "./built-in-generation-job";
import { hostedSites } from "./hosted-site";
import { runUploadedFiles } from "./run-uploaded-file";
import type { ArtifactThumbnail } from "@okouai/db/jsonb-contracts/artifact";
export type { ArtifactThumbnail } from "@okouai/db/jsonb-contracts/artifact";

/**
 * Artifact catalog kinds. One logical product maps to exactly one `artifacts`
 * row; `entity_id` points at the row that owns the kind-specific attributes.
 *
 * - `file` -> `run_uploaded_files.id`
 * - `hosted-site` -> `hosted_sites.id`
 * - `image` -> `image_artifacts.id`
 * - `video` -> `video_artifacts.id`
 * - `presentation` -> `presentation_artifacts.id`
 *
 * `logical_key` is stable across repeated projections of the same product:
 * `file:<url>` for stored files and `site:<hosted_site_id>` for hosted
 * products. Shared-thread snapshots use a compatibility `file` row whose
 * logical key is `shared-thread:<shared_thread_id>`.
 * Projection metadata records which `run_uploaded_files` row most recently
 * won a file-backed logical key without changing the catalog sort position.
 */
export const ARTIFACT_KINDS = [
  "file",
  "hosted-site",
  "image",
  "video",
  "presentation",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Common artifact registry. Holds only what the catalog list renders, so the
 * list query never touches a kind-specific table. `author_user_id` is the
 * owning Okou user, never an external chat sender.
 */
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    authorUserId: text("author_user_id").notNull(),
    kind: varchar("kind", { length: 32 }).$type<ArtifactKind>().notNull(),
    entityId: uuid("entity_id").notNull(),
    logicalKey: text("logical_key").notNull(),
    projectionFileId: uuid("projection_file_id"),
    projectionCreatedAt: timestamp("projection_created_at").notNull(),
    title: text("title").notNull(),
    thumbnail: jsonb("thumbnail").$type<ArtifactThumbnail>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("artifacts_kind_entity_unique").on(
        table.kind,
        table.entityId,
      ),
      uniqueIndex("artifacts_author_logical_key_unique").on(
        table.orgId,
        table.authorUserId,
        table.logicalKey,
      ),
      index("artifacts_author_created_idx").on(
        table.orgId,
        table.authorUserId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
      index("artifacts_author_kind_created_idx").on(
        table.orgId,
        table.authorUserId,
        table.kind,
        table.createdAt.desc(),
        table.id.desc(),
      ),
    ];
  },
);

/**
 * Durable handoff for catalog writes and bounded recovery. Catalog-producing
 * file writers enqueue in their transaction; a bounded worker can replay after
 * a later sync fails.
 * The legacy trigger also queues rows until the trigger-retirement release.
 */
export const artifactCatalogPendingFiles = pgTable(
  "artifact_catalog_pending_files",
  {
    fileId: uuid("file_id")
      .primaryKey()
      .references(
        () => {
          return runUploadedFiles.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    authorUserId: text("author_user_id").notNull(),
    queuedAt: timestamp("queued_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("artifact_catalog_pending_owner_idx").on(
        table.orgId,
        table.authorUserId,
        table.queuedAt,
        table.fileId,
      ),
    ];
  },
);

/**
 * Kind entity for officially generated images. References the stored file
 * instead of copying its URL or storage state.
 */
export const imageArtifacts = pgTable(
  "image_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fileId: uuid("file_id")
      .notNull()
      .references(
        () => {
          return runUploadedFiles.id;
        },
        { onDelete: "cascade" },
      ),
    generationJobId: uuid("generation_job_id").references(
      () => {
        return builtInGenerationJobs.id;
      },
      { onDelete: "set null" },
    ),
    model: text("model"),
    provider: text("provider"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [uniqueIndex("image_artifacts_file_unique").on(table.fileId)];
  },
);

/**
 * Kind entity for officially generated videos.
 */
export const videoArtifacts = pgTable(
  "video_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fileId: uuid("file_id")
      .notNull()
      .references(
        () => {
          return runUploadedFiles.id;
        },
        { onDelete: "cascade" },
      ),
    generationJobId: uuid("generation_job_id").references(
      () => {
        return builtInGenerationJobs.id;
      },
      { onDelete: "set null" },
    ),
    model: text("model"),
    durationSeconds: integer("duration_seconds"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [uniqueIndex("video_artifacts_file_unique").on(table.fileId)];
  },
);

/**
 * Kind entity for presentations. Publication and version state stay in
 * `hosted_sites` / `hosted_deployments`.
 */
export const presentationArtifacts = pgTable(
  "presentation_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hostedSiteId: uuid("hosted_site_id")
      .notNull()
      .references(
        () => {
          return hostedSites.id;
        },
        { onDelete: "cascade" },
      ),
    generationJobId: uuid("generation_job_id").references(
      () => {
        return builtInGenerationJobs.id;
      },
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("presentation_artifacts_site_unique").on(table.hostedSiteId),
    ];
  },
);
