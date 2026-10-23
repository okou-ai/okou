import type { AgentRunCallbackPayload } from "@okouai/db/jsonb-contracts/agent-run-callback";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Agent Run Callbacks table
 * Stores webhook callbacks to be invoked when an agent run completes.
 * Used for event-driven notifications (e.g., Slack replies) instead of polling.
 */
export const agentRunCallbacks = pgTable(
  "agent_run_callbacks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    url: text("url"),
    internalKind: varchar("internal_kind", { length: 64 }),
    // HTTP callback secret encrypted with the persistent-secret KMS envelope.
    // Direct internal callbacks do not use HTTP authentication.
    encryptedSecret: text("encrypted_secret"),
    // Arbitrary JSON payload to include in callback (e.g., Slack context)
    payload: jsonb("payload").$type<AgentRunCallbackPayload>(),
    // pending | delivered | failed
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_agent_run_callbacks_run_id").on(table.runId),
      index("idx_agent_run_callbacks_pi_memory")
        .on(sql`(${table.payload}->>'memoryStorageId')`, table.runId)
        .where(sql`${table.internalKind} = 'pi-memory:phase2'`),
      index("idx_agent_run_callbacks_pending")
        .on(table.status)
        .where(sql`status = 'pending'`),
    ];
  },
);
