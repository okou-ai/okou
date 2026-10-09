// Prospective single-inventory SQL fixture for the approved PR5/PR6 target.
// Test-only feasibility evidence, not a production mapping or deployed retirement.
// Keep through the transition; PR5 must verify its actual canonical application SQL.
import {
  pgTable,
  uuid,
  varchar,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import type {
  RunnerAdmittableProfiles,
  RunnerActiveReuseProducers,
  RunnerHeldSandboxStates,
  RunnerHeldHomeStates,
} from "@okouai/db/jsonb-contracts/runner-state";

export const runnerStateAfterHomeBridge = pgTable(
  "runner_state",
  {
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
  },
  (table) => {
    return [index("runner_state_group_idx").on(table.runnerGroup)];
  },
);
