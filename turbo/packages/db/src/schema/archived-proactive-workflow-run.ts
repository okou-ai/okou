import { pgTable, uuid, index } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";
import { archivedProactiveWorkflows } from "./workflow";

/** The live automation FK clears on deletion. Retain the original trigger for Run history. */
export const archivedProactiveWorkflowRuns = pgTable(
  "archived_proactive_workflow_runs",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(
        () => {
          return archivedProactiveWorkflows.id;
        },
        { onDelete: "cascade" },
      ),
    automationId: uuid("automation_id").notNull(),
  },
  (table) => {
    return [index("idx_archived_proactive_runs_workflow").on(table.workflowId)];
  },
);
