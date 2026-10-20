import { index, pgTable } from "drizzle-orm/pg-core";
import { runnerStateColumns } from "../columns/runner-state";
// Application mapping excludes retired ingress storage retained by the schema.
export const runnerState = pgTable(
  "runner_state",
  runnerStateColumns(),
  (table) => {
    return [index("runner_state_group_idx").on(table.runnerGroup)];
  },
);
