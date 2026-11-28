import {
  check,
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
import type {
  ArtifactCatalogCategory,
  ArtifactCatalogKind,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { builtInGenerationJobs } from "./built-in-generation-job";
import { chatThreads } from "./chat-thread";
import { files } from "./file";
import { hostedSites } from "./hosted-site";
import type { ArtifactThumbnail } from "@okouai/db/jsonb-contracts/artifact";
export type { ArtifactThumbnail } from "@okouai/db/jsonb-contracts/artifact";

/**
 * Artifact catalog kinds. One logical product maps to exactly one `artifacts`
 * row; `entity_id` points at the row that owns the kind-specific attributes.
 *
 * - `file` -> `files.id`
 * - `hosted-site` -> `hosted_sites.id`
 * - `image` -> `image_artifacts.id`
 * - `presentation` -> `presentation_artifacts.id`
 *
 * `logical_key` is stable across repeated publications of the same product:
 * `file:<url>` for stored files and `site:<hosted_site_id>` for hosted
 * products. Shared-thread snapshots use a compatibility `file` row whose
 * logical key is `shared-thread:<shared_thread_id>`.
 */
export const ARTIFACT_KINDS = [
  "file",
  "hosted-site",
  "image",
  "presentation",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_VISIBILITIES = [
  "private",
  "organization",
  "public",
] as const;
export type ArtifactVisibility = (typeof ARTIFACT_VISIBILITIES)[number];

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
    // Creating thread is stable across replacement, not a lifetime owner.
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      { onDelete: "set null" },
    ),
    // Optional summary classification: NULL retains the base storage kind,
    // except shared-thread logical keys identify shared snapshots.
    displayKind: varchar("display_kind", {
      length: 32,
    }).$type<ArtifactCatalogKind>(),
    sourceUrl: text("source_url"),
    aliasUrl: text("alias_url"),
    title: text("title").notNull(),
    thumbnail: jsonb("thumbnail").$type<ArtifactThumbnail>(),
    visibility: varchar("visibility", { length: 16 })
      .$type<ArtifactVisibility>()
      .notNull()
      .default("private"),
    category: varchar("category", {
      length: 32,
    }).$type<ArtifactCatalogCategory>(),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "artifacts_visibility_check",
        sql`${table.visibility} IN ('private', 'organization', 'public')`,
      ),
      uniqueIndex("artifacts_kind_entity_unique").on(
        table.kind,
        table.entityId,
      ),
      uniqueIndex("artifacts_author_logical_key_unique").on(
        table.orgId,
        table.authorUserId,
        table.logicalKey,
      ),
      index("artifacts_thread_author_created_idx")
        .on(
          table.chatThreadId,
          table.orgId,
          table.authorUserId,
          table.createdAt.desc(),
          table.id.desc(),
        )
        .where(sql`${table.chatThreadId} IS NOT NULL`),
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
      index("artifacts_author_category_created_idx")
        .on(
          table.orgId,
          table.authorUserId,
          table.category,
          table.createdAt.desc(),
          table.id.desc(),
        )
        .where(sql`${table.deletedAt} IS NULL`),
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
          return files.id;
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
