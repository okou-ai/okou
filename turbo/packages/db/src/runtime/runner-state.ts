import { index, pgTable } from "drizzle-orm/pg-core";
import { runnerStateColumns } from "../columns/runner-state";
// Shared by runtime consumers and the migration-owned schema export.
export const runnerState = pgTable(
  "runner_state",
  runnerStateColumns(),
  (table) => {
    return [index("runner_state_group_idx").on(table.runnerGroup)];
  },
);
