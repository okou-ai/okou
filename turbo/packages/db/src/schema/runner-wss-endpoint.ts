import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/** Host-attested *local* listener readiness, not proof of public TLS reachability. */
export const runnerWssEndpoints = pgTable("runner_wss_endpoints", {
  runnerId: uuid("runner_id").primaryKey(),
  // Pinned on first registration; a different host cannot claim this ID on expiry.
  hostId: uuid("host_id").notNull(),
  lastProbedAt: timestamp("last_probed_at").notNull(),
  leaseExpiresAt: timestamp("lease_expires_at").notNull(),
  withdrawnAt: timestamp("withdrawn_at"),
  // Conflicting host claims quarantine this ID until an explicit operator reset.
  quarantinedAt: timestamp("quarantined_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
