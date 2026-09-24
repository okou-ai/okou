import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Provenance for an input event attributed to a chat agent run.
 *
 * The primary key is the source run id, so one source run context can be
 * shared by every target chat event it triggers. The source ids intentionally
 * have no foreign keys: this is historical provenance and must survive
 * deletion of the live source run, thread, or agent.
 */
export const chatAgentRunContext = pgTable(
  "chat_agent_run_context",
  {
    id: uuid("id").primaryKey(),
    sourceChatThreadId: uuid("source_chat_thread_id").notNull(),
    sourceAgentId: uuid("source_agent_id").notNull(),
    // Ownership survives source-row deletion so late optional writes can be swept.
    sourceUserId: text("source_user_id"),
    sourceOrgId: text("source_org_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("chat_agent_run_context_source_user_idx").on(table.sourceUserId),
      index("chat_agent_run_context_source_org_idx").on(table.sourceOrgId),
    ];
  },
);
