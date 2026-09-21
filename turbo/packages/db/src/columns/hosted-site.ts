import {
  bigint,
  boolean,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { HostedSiteManifest } from "../jsonb-contracts/hosted-site";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

export const HOSTED_DEPLOYMENT_STATUSES = [
  "uploading",
  "ready",
  "failed",
  "deleted",
] as const;
export type HostedDeploymentStatus =
  (typeof HOSTED_DEPLOYMENT_STATUSES)[number];

/** Canonical columns shared by physical and runtime publication mappings. */
export function hostedSiteColumns() {
  return {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    slug: varchar("slug", { length: 64 }).notNull(),
    requestedSlug: varchar("requested_slug", { length: 64 }),
    publicBrand: text("public_brand").$type<PublicBrand>().notNull(),
    // Thread deletion must not erase the publication's ownership boundary.
    chatThreadId: uuid("chat_thread_id"),
    publicSlug: varchar("public_slug", { length: 96 }).notNull(),
    activeDeploymentId: uuid("active_deployment_id"),
    createdFromRunId: text("created_from_run_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  };
}

export function hostedDeploymentColumns(siteId: () => AnyPgColumn) {
  return {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(siteId, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    publicBrand: text("public_brand").$type<PublicBrand>().notNull(),
    status: varchar("status", { length: 32 })
      .$type<HostedDeploymentStatus>()
      .notNull()
      .default("uploading"),
    artifactUrl: text("artifact_url"),
    r2Prefix: text("r2_prefix").notNull(),
    manifest: jsonb("manifest").$type<HostedSiteManifest>().notNull(),
    manifestHash: varchar("manifest_hash", { length: 64 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    entrypoint: text("entrypoint").notNull().default("/index.html"),
    spaFallback: boolean("spa_fallback").notNull().default(false),
    fileCount: integer("file_count").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    url: text("url").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    readyAt: timestamp("ready_at"),
  };
}

export function privateHostedDeploymentColumns(siteId: () => AnyPgColumn) {
  return {
    ...hostedDeploymentColumns(siteId),
    artifactUrl: text("artifact_url").notNull(),
  };
}
