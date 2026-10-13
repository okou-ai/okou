import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { vncConnections } from "./vnc-connection";

export const vncConnectionObservations = pgTable(
  "vnc_connection_observations",
  {
    connectionId: uuid("connection_id")
      .primaryKey()
      .references(
        () => {
          return vncConnections.id;
        },
        { onDelete: "cascade" },
      ),
    generation: integer("generation").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    failureReason: varchar("failure_reason", { length: 64 }),
    sshGeneration: integer("ssh_generation"),
    kdcSshGeneration: integer("kdc_ssh_generation"),
  },
  (table) => {
    return [
      check(
        "chk_vnc_observation_ssh_generation",
        sql`${table.sshGeneration} IS NULL OR ${table.sshGeneration} > 0`,
      ),
      check(
        "chk_vnc_observation_kdc_ssh_generation",
        sql`${table.kdcSshGeneration} IS NULL OR ${table.kdcSshGeneration} > 0`,
      ),
      check(
        "chk_vnc_connection_observation_generation",
        sql`${table.generation} > 0`,
      ),
      check(
        "chk_vnc_connection_observation_failure",
        sql`${table.failureReason} IS NULL OR ${table.failureReason} IN ('invalid_credential', 'unsafe_destination', 'network_failure', 'protocol', 'timed_out', 'disconnected', 'authentication_failed', 'unsupported_profile', 'kerberos_expired', 'kerberos_non_renewable', 'kerberos_renewal_exhausted')`,
      ),
    ];
  },
);
