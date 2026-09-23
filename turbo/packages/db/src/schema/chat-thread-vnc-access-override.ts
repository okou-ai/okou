import {
  boolean,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  uuid,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";
import { vncConnections } from "./vnc-connection";

/** Only explicit chat choices are stored; absence inherits the host default. */
export const chatThreadVncAccessOverrides = pgTable(
  "chat_thread_vnc_access_overrides",
  {
    chatThreadId: uuid("chat_thread_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "chat_thread_vnc_access_overrides_pk",
        columns: [table.chatThreadId, table.connectionId],
      }),
      index("idx_chat_thread_vnc_access_overrides_connection").on(
        table.connectionId,
      ),
      foreignKey({
        name: "chat_thread_vnc_access_overrides_thread_fk",
        columns: [table.chatThreadId],
        foreignColumns: [chatThreads.id],
      }).onDelete("cascade"),
      foreignKey({
        name: "chat_thread_vnc_access_overrides_connection_fk",
        columns: [table.connectionId],
        foreignColumns: [vncConnections.id],
      }).onDelete("cascade"),
    ];
  },
);
