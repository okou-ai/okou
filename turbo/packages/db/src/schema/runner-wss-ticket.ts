import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run-session-conversation";

/** Pending one-use credentials; redeem by atomic deletion within 30 seconds. */
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
  },
  (table) => {
    return [
      index("runner_wss_tickets_run_created_idx").on(
        table.runId,
        table.createdAt,
      ),
      index("runner_wss_tickets_created_idx").on(table.createdAt),
    ];
  },
);
