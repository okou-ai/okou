// Frozen outgoing ORM shape from c3d810a6f4b48c119e576ac784b04b0ce0b81e52.
// Retain until #41444's migration, old-writer drain and rollback gates are verified.
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const outgoingRunnerState = pgTable("runner_state", {
  runnerId: uuid("runner_id").primaryKey(),
  runnerGroup: varchar("runner_group", { length: 255 }).notNull(),
  heartbeatGeneration: bigint("heartbeat_generation", { mode: "number" })
    .notNull()
    .default(0),
  heartbeatSequence: bigint("heartbeat_sequence", { mode: "number" })
    .notNull()
    .default(0),
  totalVcpu: integer("total_vcpu").notNull().default(0),
  totalMemoryMb: integer("total_memory_mb").notNull().default(0),
  maxConcurrent: integer("max_concurrent").notNull().default(0),
  allocatedVcpu: integer("allocated_vcpu").notNull().default(0),
  allocatedMemoryMb: integer("allocated_memory_mb").notNull().default(0),
  runningCount: integer("running_count").notNull().default(0),
  admittableProfiles: jsonb("admittable_profiles").default([]).notNull(),
  heldSandboxStates: jsonb("held_sandbox_states").default([]).notNull(),
  heldHomeStates: jsonb("held_home_states").default([]).notNull(),
  activeReuseProducers: jsonb("active_reuse_producers").default([]).notNull(),
  mode: varchar("mode", { length: 20 }).notNull().default("running"),
  wssIngressServiceActive: boolean("wss_ingress_service_active")
    .notNull()
    .default(false),
  lastSeenAt: timestamp("last_seen_at").notNull(),
});
