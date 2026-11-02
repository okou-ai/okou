import {
  boolean,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  uuid,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
import { connectors } from "./connector";

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
