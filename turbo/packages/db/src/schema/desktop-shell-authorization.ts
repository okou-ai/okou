import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { DesktopShellAuthorizationStatus } from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import { chatThreads } from "./chat-thread";
import { computerUseHosts } from "./computer-use-host";

/** An application becomes its own immutable, one-hour dispatch grant. */
export const desktopShellAuthorizations = pgTable(
  "desktop_shell_authorizations",
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
    computerUseHostId: uuid("computer_use_host_id")
      .notNull()
      .references(
        () => {
          return computerUseHosts.id;
        },
        { onDelete: "cascade" },
      ),
    requestedByRunId: uuid("requested_by_run_id").notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    status: varchar("status", { length: 16 })
      .$type<DesktopShellAuthorizationStatus>()
      .default("pending")
      .notNull(),
    requestExpiresAt: timestamp("request_expires_at").notNull(),
    approvedAt: timestamp("approved_at"),
    grantExpiresAt: timestamp("grant_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_desktop_shell_authorization_run_host").on(
        table.requestedByRunId,
        table.computerUseHostId,
      ),
      uniqueIndex("uq_desktop_shell_authorization_open_scope")
        .on(
          table.orgId,
          table.userId,
          table.chatThreadId,
          table.computerUseHostId,
        )
        .where(sql`${table.status} IN ('pending', 'approved')`),
      index("idx_desktop_shell_authorization_owner").on(
        table.orgId,
        table.userId,
      ),
      check(
        "desktop_shell_authorization_status_check",
        sql`${table.status} IN ('pending', 'approved', 'denied', 'revoked', 'expired')`,
      ),
      check(
        "desktop_shell_authorization_deadline_check",
        sql`(${table.approvedAt} IS NULL AND ${table.grantExpiresAt} IS NULL AND ${table.status} IN ('pending', 'denied', 'expired')) OR (${table.approvedAt} IS NOT NULL AND ${table.grantExpiresAt} IS NOT NULL AND ${table.grantExpiresAt} = ${table.approvedAt} + interval '1 hour' AND ${table.status} IN ('approved', 'revoked', 'expired'))`,
      ),
    ];
  },
);
