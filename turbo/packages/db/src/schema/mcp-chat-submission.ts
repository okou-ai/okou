import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";

/** Immutable retry identities; expired rows remain until their conversation is erased. */
export const mcpChatSubmissions = pgTable(
  "mcp_chat_submissions",
  {
    requestId: uuid("request_id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    inputSeqId: bigint("input_seq_id", { mode: "number" }).notNull(),
    acceptedAt: timestamp("accepted_at").notNull(),
  },
  (table) => {
    return [index("mcp_chat_submissions_thread_idx").on(table.threadId)];
  },
);
