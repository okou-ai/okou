import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
import { connectors } from "./connector";

export const chatThreadConnectorSelections = pgTable(
  "chat_thread_connector_selections",
  {
    chatThreadId: uuid("chat_thread_id").notNull(),
    connectorId: uuid("connector_id").notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }),
    customConnectorId: uuid("custom_connector_id"),
  },
  (table) => {
    return [
      primaryKey({
        name: "chat_thread_connector_selections_thread_connector_pk",
        columns: [table.chatThreadId, table.connectorId],
      }),
      uniqueIndex("idx_chat_thread_connector_selections_thread_slug")
        .on(table.chatThreadId, table.connectorSlug)
        .where(sql`${table.connectorSlug} IS NOT NULL`),
      uniqueIndex(
        "idx_chat_thread_connector_selections_thread_custom_connector",
      )
        .on(table.chatThreadId, table.customConnectorId)
        .where(sql`${table.customConnectorId} IS NOT NULL`),
      index("idx_chat_thread_connector_selections_connector").on(
        table.connectorId,
      ),
      index("idx_chat_thread_connector_selections_custom_connector").on(
        table.customConnectorId,
      ),
      foreignKey({
        name: "fk_chat_thread_connector_selections_thread",
        columns: [table.chatThreadId],
        foreignColumns: [chatThreads.id],
      }).onDelete("cascade"),
      // PostgreSQL deferral is declared in ../constraints/connector-selection.sql;
      // Drizzle models the identity/action but cannot emit DEFERRABLE.
      foreignKey({
        name: "fk_chat_thread_connector_selections_connector_slug",
        columns: [table.connectorId, table.connectorSlug],
        foreignColumns: [connectors.id, connectors.connectorSlug],
      }).onDelete("no action"),
      foreignKey({
        name: "fk_chat_thread_connector_selections_custom_connector",
        columns: [table.connectorId, table.customConnectorId],
        foreignColumns: [connectors.id, connectors.customConnectorId],
      }).onDelete("no action"),
      check(
        "chk_chat_thread_connector_selections_target",
        sql`num_nonnulls(${table.connectorSlug}, ${table.customConnectorId}) = 1`,
      ),
    ];
  },
);
