import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/** Run-local correlation only. Final prices and execution state belong to Router. */
export const dataRouterRequests = pgTable(
  "data_router_requests",
  {
    requestId: uuid("request_id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [index("idx_data_router_requests_run").on(table.runId)];
  },
);
