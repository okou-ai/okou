import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { vncConnections } from "./vnc-connection";

export const vncControlLeases = pgTable(
  "vnc_control_leases",
  {
    connectionId: uuid("connection_id")
      .primaryKey()
      .references(
        () => {
          return vncConnections.id;
        },
        { onDelete: "cascade" },
      ),
    instanceId: uuid("instance_id").notNull(),
    generation: integer("generation").notNull(),
    grantId: uuid("grant_id").notNull(),
    holderId: uuid("holder_id").notNull(),
    leaseToken: uuid("lease_token").notNull(),
    // Retain the reservation through revocation/Run deletion until expiry.
    runId: uuid("run_id").notNull(),
    runnerId: uuid("runner_id").notNull(),
    heartbeatGeneration: bigint("heartbeat_generation", {
      mode: "number",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      precision: 3,
    }).notNull(),
  },
  (table) => {
    return [
      check("chk_vnc_control_leases_generation", sql`${table.generation} > 0`),
      check(
        "chk_vnc_control_leases_runner_generation",
        sql`${table.heartbeatGeneration} > 0 AND ${table.heartbeatGeneration} <= 9007199254740991`,
      ),
    ];
  },
);
