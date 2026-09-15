import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { sshConnections } from "./ssh-connection";

export const sshConnectionObservations = pgTable(
  "ssh_connection_observations",
  {
    connectionId: uuid("connection_id")
      .primaryKey()
      .references(
        () => {
          return sshConnections.id;
        },
        { onDelete: "cascade" },
      ),
    generation: integer("generation").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    failureReason: varchar("failure_reason", { length: 64 }),
  },
  (table) => {
    return [
      check(
        "chk_ssh_connection_observation_generation",
        sql`${table.generation} > 0`,
      ),
      check(
        "chk_ssh_connection_observation_failure",
        sql`${table.failureReason} IS NULL OR ${table.failureReason} IN ('invalid_credential', 'unsupported_credential', 'credential_resource_limit', 'unsafe_destination', 'network_failure', 'host_key_mismatch', 'unsupported_host_key', 'authentication_failed', 'protocol', 'timed_out', 'access_rejected', 'access_tls_failure', 'access_protocol_failure')`,
      ),
    ];
  },
);
