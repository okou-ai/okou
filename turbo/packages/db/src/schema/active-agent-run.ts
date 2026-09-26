import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { RunActivityEntries } from "@okouai/db/jsonb-contracts/run-activity";
import { agentRuns } from "./agent-run";

/**
 * Narrow, per-run state that exists while a runner may still work on the run.
 * Launch inserts it; a never-started run loses it when it turns terminal, and a
 * started run keeps it until its runner reports completion or cleanup declares
 * the runner gone. Heartbeat and activity writes therefore never rewrite the
 * wide `agent_runs` row or its indexes. Only immutable identity columns are
 * indexed; mutable fields stay unindexed so single-row updates remain HOT.
 * The unique `chat_thread_id` index is the per-thread active-run lock.
 */
export const activeAgentRuns = pgTable(
  "active_agent_runs",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    // Immutable after insert and without a foreign key. Null for threadless
    // runs. The unique index makes this row the thread's active-run lock:
    // launch inserts it last, and a conflict means the thread is busy.
    chatThreadId: uuid("chat_thread_id"),
    lastHeartbeatAt: timestamp("last_heartbeat_at").notNull(),
    activityEntries: jsonb("activity_entries")
      .$type<RunActivityEntries>()
      .notNull()
      .default([]),
    activityRevision: text("activity_revision").notNull().default("empty"),
    summary: text("summary"),
    summaryRevision: text("summary_revision"),
    nextAttemptAt: timestamp("next_attempt_at"),
    claimId: uuid("claim_id"),
    claimExpiresAt: timestamp("claim_expires_at"),
  },
  (table) => {
    return [
      index("active_agent_runs_org_idx").on(table.orgId),
      index("active_agent_runs_user_idx").on(table.userId),
      uniqueIndex("active_agent_runs_chat_thread_unique").on(
        table.chatThreadId,
      ),
      check(
        "active_agent_runs_activity_entries_bound",
        sql`jsonb_typeof(${table.activityEntries}) = 'array' AND jsonb_array_length(${table.activityEntries}) <= 16 AND octet_length(${table.activityEntries}::text) <= 16384`,
      ),
    ];
  },
);
