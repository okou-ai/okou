import { pgTable } from "drizzle-orm/pg-core";
import { workflowAutomationColumns } from "../columns/workflow-automation";
import { connectors } from "../schema/connector";
import { workflows } from "../schema/workflow";

// Application mapping. DDL lives in the schema.
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
