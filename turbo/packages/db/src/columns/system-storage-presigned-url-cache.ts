import {
  boolean,
  integer,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/** Cache columns shared by the runtime and migration-owned tables. */
export function systemStoragePresignedUrlCacheColumns() {
  return {
    cacheKey: varchar("cache_key", { length: 64 }).primaryKey(),
    scope: varchar("scope", { length: 64 }).default("system_storage").notNull(),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull(),
    storageVersionId: varchar("storage_version_id", { length: 64 }).notNull(),
    resolvedOrgId: text("resolved_org_id"),
    publicEndpoint: boolean("public_endpoint").notNull(),
    ttlSeconds: integer("ttl_seconds").notNull(),
    presignedUrl: text("presigned_url").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    lastRequestedAt: timestamp("last_requested_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
