import { sql } from "drizzle-orm";
import {
  check,
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
import type { HostAuthorizationPermissions } from "../jsonb-contracts/host-authorization";
import { chatThreads } from "./chat-thread";
import { vncConnections } from "./vnc-connection";

/** Approval applies the existing chat override; this record is not another grant. */
export const vncAuthorizations = pgTable(
  "vnc_authorizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return vncConnections.id;
        },
        { onDelete: "cascade" },
      ),
    generation: integer("generation").notNull(),
    requestedByRunId: uuid("requested_by_run_id").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    callbackPrompt: varchar("callback_prompt", { length: 200 }).notNull(),
    requiredPermissions: jsonb("required_permissions")
      .$type<HostAuthorizationPermissions>()
      .notNull()
      .default([]),
    status: varchar("status", { length: 16 })
      .$type<"pending" | "approved" | "denied" | "revoked">()
      .notNull()
      .default("pending"),
    requestExpiresAt: timestamp("request_expires_at").notNull(),
    continuationQueuedAt: timestamp("continuation_queued_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => {
    return [
      uniqueIndex("uq_vnc_authorization_run_host_generation").on(
        table.requestedByRunId,
        table.connectionId,
        table.generation,
      ),
      index("idx_vnc_authorization_owner").on(table.orgId, table.userId),
      index("idx_vnc_authorization_thread").on(table.chatThreadId),
      index("idx_vnc_authorization_host").on(table.connectionId),
      check(
        "vnc_authorization_status_check",
        sql`${table.status} IN ('pending', 'approved', 'denied', 'revoked')`,
      ),
    ];
  },
);
