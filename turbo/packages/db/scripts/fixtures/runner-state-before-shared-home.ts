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
import type {
  RunnerActiveReuseProducers,
  RunnerAdmittableProfiles,
  RunnerHeldHomeStates,
  RunnerHeldSandboxStates,
} from "../../src/jsonb-contracts/runner-state";

// Frozen ORM columns from 57d4f7f80c, before #41444. Retire only after the
// outgoing API serving/rollback window and migration gates in #41481 close.
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
  admittableProfiles: jsonb("admittable_profiles")
    .$type<RunnerAdmittableProfiles>()
    .default([])
    .notNull(),
  heldSandboxStates: jsonb("held_sandbox_states")
    .$type<RunnerHeldSandboxStates>()
    .default([])
    .notNull(),
  heldHomeStates: jsonb("held_home_states")
    .$type<RunnerHeldHomeStates>()
    .default([])
    .notNull(),
  activeReuseProducers: jsonb("active_reuse_producers")
    .$type<RunnerActiveReuseProducers>()
    .default([])
    .notNull(),
  mode: varchar("mode", { length: 20 }).notNull().default("running"),
  wssIngressServiceActive: boolean("wss_ingress_service_active")
    .notNull()
    .default(false),
  lastSeenAt: timestamp("last_seen_at").notNull(),
});
