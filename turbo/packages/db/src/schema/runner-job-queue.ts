import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";
import type { RunnerJobQueueExecutionContext } from "@okouai/db/jsonb-contracts/runner-job-queue";

/**
 * Runner Job Queue table
 * Temporary storage for runner jobs with encrypted secrets
 * Records are deleted after job completion
 */
export const runnerJobQueue = pgTable(
  "runner_job_queue",
  {
    // Primary key, references agent_runs
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "no action" },
      ),

    // Runner routing
    runnerGroup: varchar("runner_group", { length: 255 }).notNull(),
    profile: varchar("profile", { length: 255 })
      .notNull()
      .default("vm0/default"),

    // Claude/Codex CLI agent session id (nullable for first-turn jobs before
    // the guest reports a CLI agent session).
    cliAgentSessionId: varchar("session_id", { length: 255 }),

    // Snapshot of the sandbox and home reuse identity at enqueue time.
    reuseKey: varchar("reuse_key", { length: 263 }),

    // Execution context (secrets encrypted with persistent-secret envelope)
    executionContext: jsonb("execution_context")
      .$type<RunnerJobQueueExecutionContext>()
      .notNull(),

    // Lifecycle management. Current API writers provide an application-clock
    // insertion time; the default keeps older writers compatible.
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // Initialized once by discovery after enqueue commits. Separate from FIFO
    // and latency provenance so uncommitted work cannot consume reuse protection.
    discoveryStartedAt: timestamp("discovery_started_at"),
    // Current API writers use the database clock during the insert statement.
    expiresAt: timestamp("expires_at").notNull(), // TTL for auto-cleanup
  },
  (table) => {
    return [
      // Predicate-free index used by current poll queries.
      index("runner_job_queue_group_profile_idx").on(
        table.runnerGroup,
        table.profile,
      ),
      // Index for TTL cleanup
      index("runner_job_queue_expires_at_idx").on(table.expiresAt),
    ];
  },
);
