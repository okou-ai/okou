import { boolean, index, pgTable } from "drizzle-orm/pg-core";
import { runnerStateColumns } from "../columns/runner-state";

// Retain retired ingress storage for outgoing API SQL during traffic drain.
// Application queries use the runtime mapping without this field.
export const runnerState = pgTable(
  "runner_state",
  {
    ...runnerStateColumns(),
    wssIngressServiceActive: boolean("wss_ingress_service_active")
      .notNull()
      .default(false),
  },
  (table) => {
    return [index("runner_state_group_idx").on(table.runnerGroup)];
  },
);
