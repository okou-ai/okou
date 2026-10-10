import { index, pgTable } from "drizzle-orm/pg-core";
import { runnerStateColumns } from "../columns/runner-state";
// Executing statements omit the four retirement columns, including implicit
// SELECT/INSERT/RETURNING. The migration-owned schema retains them for PR6.
export const runnerState = pgTable(
  "runner_state",
  runnerStateColumns(),
  (table) => {
    return [index("runner_state_group_idx").on(table.runnerGroup)];
  },
);
