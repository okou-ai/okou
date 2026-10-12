import { pgTable } from "drizzle-orm/pg-core";
import { workflowAutomationColumns } from "../columns/workflow-automation";
import { connectors } from "../schema/connector";
import { workflows } from "../schema/workflow";

// Application mapping. It omits the retired official_result_email_enabled
// column, which stays migration-owned until release 3 of #39378 drops it after
// outgoing APIs drain and rollback excludes them. DDL lives in the schema.
export const workflowAutomations = pgTable(
  "workflow_automations",
  workflowAutomationColumns(
    () => {
      return workflows.id;
    },
    () => {
      return connectors.id;
    },
  ),
);
