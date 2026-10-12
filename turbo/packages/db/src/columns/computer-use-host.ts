import { integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type {
  ComputerUsePermissions,
  ComputerUseSupportedCapabilities,
} from "@okouai/db/jsonb-contracts/computer-use-host";

/** Shared by physical DDL and the session-only application mapping. */
export function computerUseHostColumns() {
  return {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    installationId: uuid("installation_id"),
    displayName: text("display_name").notNull(),
    sessionId: text("session_id"),
    sessionValidatedAt: timestamp("session_validated_at"),
    connectionGeneration: integer("connection_generation").default(0).notNull(),
    appVersion: text("app_version").notNull(),
    osVersion: text("os_version").notNull(),
    supportedCapabilities: jsonb("supported_capabilities")
      .$type<ComputerUseSupportedCapabilities>()
      .default([])
      .notNull(),
    permissions: jsonb("permissions")
      .$type<ComputerUsePermissions>()
      .default({ accessibility: false, screenRecording: false })
      .notNull(),
    status: text("status").default("online").notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
