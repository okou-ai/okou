import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agentRunInference } from "./agent-run-inference";

/** Bounded immutable envelopes. PostgreSQL owns publication and reclamation. */
export const piInferenceObjects = pgTable(
  "pi_inference_objects",
  {
    hash: varchar("hash", { length: 64 }).primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => {
    return [
      check(
        "pi_inference_object_hash_check",
        sql`${t.hash} ~ '^[0-9a-f]{64}$'`,
      ),
      check(
        "pi_inference_object_kind_check",
        sql`${t.kind} IN ('configuration', 'context', 'h1', 'secrets')`,
      ),
      check(
        "pi_inference_object_size_check",
        sql`octet_length(${t.content}) <= 33554432`,
      ),
      index("pi_inference_object_gc_idx").on(t.createdAt, t.hash),
    ];
  },
);

/** Exact immutable references per inference owner, including terminal
 * owners awaiting accounting/physical release. No duplicated conversation refs. */
export const agentRunInferenceObjects = pgTable(
  "agent_run_inference_objects",
  {
    runId: uuid("run_id")
      .notNull()
      .references(
        () => {
          return agentRunInference.runId;
        },
        { onDelete: "cascade" },
      ),
    kind: text("kind").notNull(),
    hash: varchar("hash", { length: 64 })
      .notNull()
      .references(
        () => {
          return piInferenceObjects.hash;
        },
        { onDelete: "restrict" },
      ),
  },
  (t) => {
    return [
      primaryKey({ columns: [t.runId, t.kind, t.hash] }),
      index("agent_run_inference_object_hash_idx").on(t.hash),
    ];
  },
);
