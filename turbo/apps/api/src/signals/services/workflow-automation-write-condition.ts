import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { eq } from "drizzle-orm";
import { observedWorkflowAutomationCondition } from "./workflow-automation-snapshot";

type AutomationRow = typeof workflowAutomations.$inferSelect;

export function workflowAutomationToggleCondition(automation: AutomationRow) {
  return automation.officialBlueprintKey === null
    ? eq(workflowAutomations.id, automation.id)
    : observedWorkflowAutomationCondition(automation);
}
