import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
import { connectors } from "./connector";
import { orgCustomConnectors } from "./org-custom-connector";

/** Absence inherits the account's live default; it is not a denied grant. */
export const chatThreadConnectorAccessOverrides = pgTable(
  "chat_thread_connector_access_overrides",
  {
    chatThreadId: uuid("chat_thread_id").notNull(),
    connectorId: uuid("connector_id").notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.chatThreadId, table.connectorId] }),
      index("idx_chat_connector_access_account").on(table.connectorId),
      foreignKey({
        columns: [table.chatThreadId],
        foreignColumns: [chatThreads.id],
      }).onDelete("cascade"),
      foreignKey({
        columns: [table.connectorId],
        foreignColumns: [connectors.id],
      }).onDelete("cascade"),
    ];
  },
);

/** One shared policy, including its one-time legacy initialization, per target. */
export const chatThreadConnectorPolicies = pgTable(
  "chat_thread_connector_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }),
    customConnectorId: uuid("custom_connector_id"),
    // Retain the custom bundle's existing selected-name/default semantics.
    permissionNames: text("permission_names")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (table) => {
    return [
      uniqueIndex("uq_chat_connector_policy_builtin")
        .on(table.chatThreadId, table.connectorSlug)
        .where(sql`${table.connectorSlug} IS NOT NULL`),
      uniqueIndex("uq_chat_connector_policy_custom")
        .on(table.chatThreadId, table.customConnectorId)
        .where(sql`${table.customConnectorId} IS NOT NULL`),
      index("idx_chat_connector_policy_custom").on(table.customConnectorId),
      foreignKey({
        columns: [table.chatThreadId],
        foreignColumns: [chatThreads.id],
      }).onDelete("cascade"),
      foreignKey({
        columns: [table.customConnectorId],
        foreignColumns: [orgCustomConnectors.id],
      }).onDelete("cascade"),
      check(
        "chk_chat_connector_policy_target",
        sql`num_nonnulls(${table.connectorSlug}, ${table.customConnectorId}) = 1`,
      ),
    ];
  },
);

export const chatThreadConnectorPermissionGrants = pgTable(
  "chat_thread_connector_permission_grants",
  {
    policyId: uuid("policy_id").notNull(),
    permission: varchar("permission", { length: 128 }).notNull(),
    action: varchar("action", { length: 8 })
      .$type<"allow" | "deny">()
      .notNull(),
    expiresAt: timestamp("expires_at"),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.policyId, table.permission] }),
      foreignKey({
        columns: [table.policyId],
        foreignColumns: [chatThreadConnectorPolicies.id],
      }).onDelete("cascade"),
      check(
        "chk_chat_connector_grant_action",
        sql`${table.action} IN ('allow', 'deny')`,
      ),
      check(
        "chk_chat_connector_grant_expiry",
        sql`${table.action} = 'allow' OR ${table.expiresAt} IS NULL`,
      ),
    ];
  },
);
