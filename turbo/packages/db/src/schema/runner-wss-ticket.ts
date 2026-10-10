import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run-session-conversation";

/** One-use bearer ticket; consumed rows remain WSS authority while the Run is live. */
export const runnerWssTickets = pgTable(
  "runner_wss_tickets",
  {
    digest: varchar("digest", { length: 64 }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runnerId: uuid("runner_id").notNull(),
    origin: varchar("origin", { length: 300 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => {
    return [
      index("runner_wss_tickets_run_expires_idx").on(
        table.runId,
        table.expiresAt,
      ),
      index("runner_wss_tickets_expires_idx").on(table.expiresAt),
    ];
  },
);
