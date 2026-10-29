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
import { agents } from "./agent";
import { chatThreads } from "./chat-thread";

/** Personal organization only; conversation data stays on the canonical thread. */
export const chatThreadFolders = pgTable(
  "chat_thread_folders",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return agents.id;
        },
        { onDelete: "cascade" },
      ),
    name: varchar("name", { length: 100 }).notNull(),
    sortKey: text("sort_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "chat_thread_folders_name_check",
        sql`char_length(btrim(${table.name})) BETWEEN 1 AND 100 AND ${table.name} = btrim(${table.name})`,
      ),
      uniqueIndex("uq_chat_thread_folders_scope_name").on(
        table.userId,
        table.orgId,
        table.agentId,
        sql`lower(${table.name})`,
      ),
      index("idx_chat_thread_folders_scope_order").on(
        table.userId,
        table.orgId,
        table.agentId,
        table.sortKey,
        table.id,
      ),
    ];
  },
);

/** A missing row means Unfiled. Deleting a folder never deletes a thread. */
export const chatThreadFolderMemberships = pgTable(
  "chat_thread_folder_memberships",
  {
    chatThreadId: uuid("chat_thread_id")
      .primaryKey()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    folderId: uuid("folder_id")
      .notNull()
      .references(
        () => {
          return chatThreadFolders.id;
        },
        { onDelete: "cascade" },
      ),
  },
  (table) => {
    return [
      index("idx_chat_thread_folder_memberships_folder").on(
        table.folderId,
        table.chatThreadId,
      ),
    ];
  },
);
