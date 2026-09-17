import { pgTable, uuid, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";
import { conversations } from "./conversation";
import type { CheckpointStorageMounts } from "@okouai/db/jsonb-contracts/checkpoint";

/**
 * Checkpoints table
 * Stores agent run state snapshots for debugging and future resumption
 */
export const checkpoints = pgTable(
  "checkpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      )
      .notNull()
      .unique(),
    conversationId: uuid("conversation_id")
      .references(
        () => {
          return conversations.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    // Canonical exact mount snapshot.
    storageMounts: jsonb("storage_mounts").$type<CheckpointStorageMounts>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [index("idx_checkpoints_conversation").on(table.conversationId)];
  },
);
