import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const tsvectorColumn = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * Durable searchable-message projection. These rows do not depend on a
 * chat_events UUID and remain authoritative after the canonical event row
 * ages out of PostgreSQL.
 */
export const chatEventSearchMessages = pgTable(
  "chat_event_search_messages",
  {
    chatThreadId: uuid("chat_thread_id").notNull(),
    seqId: bigint("seq_id", { mode: "number" }).notNull(),
    runId: uuid("run_id"),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id"),
    role: text("role").$type<"user" | "assistant">().notNull(),
    createdAt: timestamp("created_at").notNull(),
    text: text("text").notNull(),
    textBigram: text("text_bigram").notNull(),
    tsv: tsvectorColumn("tsv").generatedAlwaysAs(
      sql`to_tsvector('simple', text_bigram)`,
    ),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.chatThreadId, table.seqId] }),
      index("chat_event_search_messages_user_org_created_idx").on(
        table.userId,
        table.orgId,
        table.createdAt.desc(),
      ),
      index("chat_event_search_messages_user_org_agent_id_created_idx").on(
        table.userId,
        table.orgId,
        table.agentId,
        table.createdAt.desc(),
      ),
      // btree_gin: intersect the user's postings with keyword postings inside
      // one GIN scan, so common keywords do not fall back to a table scan.
      index("chat_event_search_messages_user_tsv_gin_idx").using(
        "gin",
        table.userId,
        table.tsv,
      ),
    ];
  },
);

/**
 * Durable-projection watermark. Missing rows intentionally mean zero.
 */
export const chatEventSearchMessageWatermarks = pgTable(
  "chat_event_search_message_watermarks",
  {
    chatThreadId: uuid("chat_thread_id").primaryKey(),
    indexedSeqId: bigint("indexed_seq_id", { mode: "number" }).notNull(),
  },
);
