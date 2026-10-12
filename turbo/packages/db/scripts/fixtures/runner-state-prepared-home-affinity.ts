// Frozen expanded application mapping from release 47a4d38e84372782cf11b0a37d335083387e8c08.
// Retain this test-only mapping until the physical contraction is deployed.
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  RunnerAdmittableProfiles,
  RunnerActiveReuseProducers,
  RunnerHeldSandboxStates,
  RunnerHeldHomeStates,
} from "@okouai/db/jsonb-contracts/runner-state";
import type { RunnerHeldWorkspaceStates } from "./runner-state-before-home-affinity";

export const runnerStatePreparedHome = pgTable(
  "runner_state",
  {
    runnerId: uuid("runner_id").primaryKey(),
    runnerGroup: varchar("runner_group", { length: 255 }).notNull(),
    heartbeatGeneration: bigint("heartbeat_generation", {
      mode: "number",
    })
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
    /** Host-local WSS ingress service observation; not public DNS/TLS reachability. */
    wssIngressServiceActive: boolean("wss_ingress_service_active")
      .notNull()
      .default(false),
    lastSeenAt: timestamp("last_seen_at").notNull(),
    heldWorkspaceStates: jsonb("held_workspace_states")
      .$type<RunnerHeldWorkspaceStates>()
      .default([])
      .notNull(),
    homeAffinityVersion: integer("home_affinity_version"),
    homeAffinityGeneration: bigint("home_affinity_generation", {
      mode: "number",
    }),
    homeAffinitySequence: bigint("home_affinity_sequence", { mode: "number" }),
  },
  (table) => {
    return [index("runner_state_group_idx").on(table.runnerGroup)];
  },
);
